"use strict";

// Creator Pool: creator accounts, workflows, ratings, reports and the server
// rendered public pages. Mounted from lib/api.js, which passes in its shared
// helpers (database pool, cookies, Google token check, admin identity).
//
// Public reads
//   GET  /api/v1/categories
//   GET  /api/v1/workflows?sort=top|most|new&category=&q=&page=
//   GET  /api/v1/workflows/:slug
//   GET  /api/v1/creators/:handle
// Sign in (Google, verified server side)
//   GET  /api/v1/auth/config
//   POST /api/v1/auth/google        { credential }
//   POST /api/v1/auth/logout
// Creator writes (session cookie, fetch header required)
//   GET    /api/v1/me
//   POST   /api/v1/me/profile        create after first sign in
//   PATCH  /api/v1/me/profile
//   POST   /api/v1/me/deactivate
//   POST   /api/v1/workflows         create draft
//   GET    /api/v1/me/workflows/:id
//   PATCH  /api/v1/workflows/:id
//   POST   /api/v1/workflows/:id/publish
//   POST   /api/v1/workflows/:id/unpublish
// Device writes (device cookie)
//   PUT    /api/v1/workflows/:id/rating   { score }
//   DELETE /api/v1/workflows/:id/rating
//   POST   /api/v1/workflows/:id/report   { reason, detail }
// Pages (rewritten from /workflows, /workflows/:slug, /creators/:handle)
//   GET /api/pages/workflows, /api/pages/workflows/:slug, /api/pages/creators/:handle, /api/pages/sitemap
// Admin (moderator session or ADMIN_TOKEN)
//   GET  /api/admin/pool/overview
//   GET  /api/admin/pool/reports
//   GET  /api/admin/pool/workflows?status=
//   POST /api/admin/pool/workflows/:id/hide | restore | remove
//   POST /api/admin/pool/reports/:id/resolve | dismiss
//   POST /api/admin/pool/creators/:id/status { status }

const crypto = require("crypto");
const { layout, esc, SITE } = require("./pages");
const { dashboardPage } = require("./dashboard");

const CREATOR_COOKIE = "bwm_c";
const SIGNUP_COOKIE = "bwm_s";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SIGNUP_SECONDS = 20 * 60;
const HANDLE_RE = /^[A-Za-z0-9_]{3,30}$/;
const RESERVED_HANDLES = new Set(["admin", "administrator", "moderator", "mod", "builtwithmuse", "muse", "meta", "official", "support", "help", "api", "creator", "creators", "workflow", "workflows", "about", "privacy", "blog", "login", "signin", "signup", "me", "editorial", "team", "staff", "root", "system", "null", "undefined"]);
const HANDLE_COOLDOWN_DAYS = 30;
const LIMITS = {
  title: [10, 70], summary: [1, 160], problem: [1, 1000], result: [1, 1000], step: [1, 1000], prompt: [0, 1000],
  steps: [2, 15], prerequisites: [0, 10], prerequisite: [1, 200], bio: [0, 400], displayName: [2, 60], detail: [0, 500],
};
const RATE = {
  rating: { device: { hour: 30, day: 120 }, ip: { hour: 60, day: 300 } },
  report: { device: { hour: 5, day: 15 }, ip: { hour: 10, day: 40 } },
  login: { ip: { hour: 20, day: 80 } },
};
const PUBLISH_CAP = { firstDay: 3, perDay: 10, drafts: 60 };
const PAGE_SIZE = 24;
const REPORT_REASONS = ["spam", "unsafe", "stolen", "other"];

let deps = null;
let pool = null;

// Idempotent Creator Pool schema. Runs on every boot (cold start); every
// statement is guarded so re-running is safe.
const CREATOR_SCHEMA = `
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS x_url TEXT;
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS youtube_url TEXT;
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS tiktok_url TEXT;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS screenshot_url TEXT;
CREATE TABLE IF NOT EXISTS workflow_saves (
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, device_id)
);
CREATE TABLE IF NOT EXISTS workflow_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  hidden_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id UUID NOT NULL REFERENCES workflow_comments(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, creator_id)
);
CREATE TABLE IF NOT EXISTS comment_reports (
  id SERIAL PRIMARY KEY,
  comment_id UUID NOT NULL REFERENCES workflow_comments(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (comment_id, device_id)
);
-- One account for everything: a first Google sign in creates a minimal
-- profile at once (auto handle, not yet claimed) so claiming a code never
-- forces anyone through creator onboarding. Saves are keyed to the creator
-- once signed in; old device rows keep counting.
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS handle_claimed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE workflow_saves ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES creator_profiles(id) ON DELETE CASCADE;
ALTER TABLE workflow_saves DROP CONSTRAINT IF EXISTS workflow_saves_pkey;
ALTER TABLE workflow_saves ALTER COLUMN device_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_saves_device_uidx ON workflow_saves (workflow_id, device_id) WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_saves_creator_uidx ON workflow_saves (workflow_id, creator_id) WHERE creator_id IS NOT NULL;
-- Creator follows: one row per follower -> followed pair. A creator cannot
-- follow themselves and cannot follow the editorial team profile.
CREATE TABLE IF NOT EXISTS creator_follows (
  follower_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  followed_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
-- "Others" catch all category for workflows that do not fit the list.
INSERT INTO categories (slug, name, position) VALUES ('others', 'Others', 110)
ON CONFLICT (slug) DO NOTHING;
`;
async function ensureCreatorSchema(attempts = 12) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query(CREATOR_SCHEMA);
      await pool.query("UPDATE creator_profiles SET display_name = 'Jayesh' WHERE is_editorial AND display_name = 'Built with Muse editorial'");
      return;
    } catch (err) {
      if (i === attempts) console.error("creator schema init failed", err.code || "", err.message);
      else await new Promise((r) => setTimeout(r, Math.min(700 * i, 4000)));
    }
  }
}

// The promise from the last init() call. handle() awaits it so the referral
// migrations (foreign keys into creator_profiles) are done before any
// request touches the database.
let schemaReady = null;
function init(shared) {
  deps = shared;
  pool = shared.pool;
  schemaReady = ensureCreatorSchema();
}

// ---------------------------------------------------------------------------
// Sessions. A creator session is a signed cookie carrying the profile id;
// the profile row is loaded on every request so a deactivation takes effect
// at once. The signup cookie carries a verified email for the minutes between
// Google sign in and choosing a handle.
function key(label) {
  return crypto.createHash("sha256").update(label + ":" + deps.DEVICE_SECRET).digest();
}
function signBody(label, data, seconds) {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url");
  const sig = crypto.createHmac("sha256", key(label)).update(body).digest("base64url");
  return body + "." + sig;
}
function readSigned(label, raw) {
  const [body, sig] = String(raw || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", key(label)).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch (_) {
    return null;
  }
}
function cookie(req, name, value, maxAge) {
  const secure = deps.isSecure(req) ? "; Secure" : "";
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}
function clearCookie(req, name) {
  return cookie(req, name, "", 0);
}
async function creatorFromRequest(req) {
  const data = readSigned("creator", deps.parseCookies(req)[CREATOR_COOKIE]);
  if (!data || !data.cid) return null;
  const r = await pool.query("SELECT * FROM creator_profiles WHERE id = $1", [data.cid]);
  const profile = r.rows[0];
  if (!profile) return null;
  return profile;
}
// Any signed in request links the device to the creator, which is what
// blocks that device from rating the creator's own work later.
async function rememberDevice(creatorId, deviceId) {
  if (!creatorId || !deviceId) return;
  await pool.query(
    `INSERT INTO creator_devices (creator_id, device_id) VALUES ($1, $2)
     ON CONFLICT (creator_id, device_id) DO UPDATE SET last_seen_at = now()`,
    [creatorId, deviceId]
  );
}
async function event(kind, fields) {
  await pool.query(
    "INSERT INTO pool_events (kind, workflow_id, creator_id, device_id, actor, detail) VALUES ($1, $2, $3, $4, $5, $6)",
    [kind, fields.workflowId || null, fields.creatorId || null, fields.deviceId || null, fields.actor || null, fields.detail ? JSON.stringify(fields.detail) : null]
  );
}
async function overLimit(table, column, value, limit) {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour, count(*) AS day
       FROM ${table} WHERE ${column} = $1 AND created_at > now() - interval '1 day'`,
    [value]
  );
  return Number(r.rows[0].hour) >= limit.hour || Number(r.rows[0].day) >= limit.day;
}

// ---------------------------------------------------------------------------
// Validation. Every string is trimmed and length checked; nothing is trusted
// from the client beyond its content.
const DASH_RE = /[‐-―−]/g;
function text(value, [min, max], name, errors, { required = min > 0 } = {}) {
  let s = typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(DASH_RE, "-").trim() : "";
  if (!s && !required) return null;
  if (s.length < Math.max(1, min)) errors.push(`${name}_short`);
  if (s.length > max) errors.push(`${name}_long`);
  return s;
}
function list(value, count, each, name, errors) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) { errors.push(`${name}_invalid`); return []; }
  const items = value.map((v) => (typeof v === "string" ? v.replace(DASH_RE, "-").trim() : "")).filter(Boolean);
  if (items.length < count[0]) errors.push(`${name}_few`);
  if (items.length > count[1]) errors.push(`${name}_many`);
  for (const item of items) if (item.length > each[1]) errors.push(`${name}_item_long`);
  return items.slice(0, count[1]);
}
function validUrl(value, name, errors) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  if (s.length > 500 || !/^https?:\/\/[^\s]+$/i.test(s)) { errors.push(`${name}_invalid`); return null; }
  return s;
}
function validImage(value, name, errors) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  // Uploaded pictures arrive as client side resized JPEG data URLs (max ~600KB).
  if (/^data:image\/(png|jpeg|webp);base64,/.test(s)) {
    if (s.length > 800000) { errors.push(name + "_invalid"); return null; }
    return s;
  }
  return validUrl(s, name, errors);
}
function validAvatar(value, errors) { return validImage(value, "avatar", errors); }
function slugify(title) {
  return title.toLowerCase().replace(DASH_RE, "-").replace(/['"’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workflow";
}
// Tags arrive as a comma separated string or an array. At most five survive,
// lowercased, each 2 to 24 chars of letters, numbers and single hyphens.
const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function parseTags(value, errors) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = [];
  for (const item of raw) {
    const tag = String(item).trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (!tag) continue;
    if (seen.includes(tag)) continue;
    if (tag.length < 2 || tag.length > 24 || !TAG_RE.test(tag)) { errors.push("tag_invalid"); continue; }
    seen.push(tag);
    if (seen.length >= 5) break;
  }
  return seen;
}
async function uniqueSlug(base, excludeId) {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const r = await pool.query("SELECT id FROM workflows WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2)", [candidate, excludeId || null]);
    if (!r.rows[0]) return candidate;
  }
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

// Parses a workflow body from the client. Drafts only need a title; publishing
// needs the three quick answers: title, what you told Muse, what happened.
// Everything else (summary, problem, steps, category) is optional detail that
// can be added later and helps the workflow rank.
function parseWorkflow(body, { complete }) {
  const errors = [];
  const out = {};
  out.title = text(body.title, LIMITS.title, "title", errors);
  out.summary = text(body.summary, LIMITS.summary, "summary", errors, { required: false });
  out.problem = text(body.problem, LIMITS.problem, "problem", errors, { required: false });
  out.result = text(body.result, LIMITS.result, "result", errors, { required: complete });
  out.prompt = text(body.prompt, LIMITS.prompt, "prompt", errors, { required: complete });
  out.proof_url = validUrl(body.proof_url, "proof_url", errors);
  out.steps = list(body.steps, [0, LIMITS.steps[1]], LIMITS.step, "steps", errors);
  out.prerequisites = list(body.prerequisites, LIMITS.prerequisites, LIMITS.prerequisite, "prerequisites", errors);
  out.category = typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
  out.tags = parseTags(body.tags, errors);
  out.screenshot_url = validImage(body.screenshot_url, "screenshot", errors);
  return { value: out, errors };
}

async function categoryId(slug) {
  if (!slug) return null;
  const r = await pool.query("SELECT id FROM categories WHERE slug = $1 AND active", [slug]);
  return r.rows[0] ? r.rows[0].id : null;
}

// ---------------------------------------------------------------------------
// Reads.
const WORKFLOW_SELECT = `
  w.id, w.slug, w.title, w.summary, w.problem, w.result, w.prompt, w.proof_url, w.screenshot_url, w.status, w.hidden_at,
  w.published_at, w.created_at, w.updated_at, w.tags,
  cat.slug AS category, cat.name AS category_name,
  c.id AS creator_id, c.handle, c.display_name, c.avatar_url, c.is_editorial, c.status AS creator_status,
  s.rating_count, s.average, s.weighted_score`;
const WORKFLOW_FROM = `
  FROM workflows w
  JOIN creator_profiles c ON c.id = w.creator_id
  LEFT JOIN categories cat ON cat.id = w.category_id
  LEFT JOIN workflow_stats s ON s.workflow_id = w.id`;
const DISCOVERABLE = `w.status = 'published' AND w.hidden_at IS NULL AND c.status = 'active'`;

function publicWorkflow(row) {
  // Quick submissions can skip the summary; fall back to the result excerpt
  // so cards, hero leads and meta descriptions never render empty.
  const fallbackSummary = row.summary || String(row.result || "").replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    id: row.id, slug: row.slug, title: row.title, summary: fallbackSummary, category: row.category, categoryName: row.category_name,
    status: row.status, publishedAt: row.published_at, updatedAt: row.updated_at,
    creator: { handle: row.handle, displayName: row.display_name, avatarUrl: row.avatar_url, editorial: row.is_editorial, status: row.creator_status },
    ratingCount: Number(row.rating_count || 0), average: row.average === null ? null : Number(row.average), weightedScore: Number(row.weighted_score || 0), proofUrl: row.proof_url, tags: row.tags || [],
  };
}
async function loadParts(workflowId) {
  const steps = await pool.query("SELECT position, title, body FROM workflow_steps WHERE workflow_id = $1 ORDER BY position", [workflowId]);
  const prereqs = await pool.query("SELECT body FROM workflow_prerequisites WHERE workflow_id = $1 ORDER BY position", [workflowId]);
  return { steps: steps.rows.map((s) => (s.title ? { title: s.title, body: s.body } : s.body)), prerequisites: prereqs.rows.map((p) => p.body) };
}
function sortClause(sort) {
  if (sort === "most") return "s.rating_count DESC NULLS LAST, s.weighted_score DESC, w.published_at DESC";
  if (sort === "new") return "w.published_at DESC, w.id";
  return "s.weighted_score DESC, s.rating_count DESC NULLS LAST, w.published_at DESC";
}
async function listWorkflows({ sort = "top", category = "", q = "", page = 1, handle = "", tag = "" }) {
  const where = [DISCOVERABLE];
  const params = [];
  if (category) { params.push(category); where.push(`cat.slug = $${params.length}`); }
  if (handle) { params.push(handle.toLowerCase()); where.push(`lower(c.handle) = $${params.length}`); }
  if (tag) { params.push(tag.toLowerCase()); where.push(`$${params.length} = ANY (w.tags)`); }
  if (q) { params.push("%" + q.replace(/[%_]/g, "") + "%"); where.push(`(w.title ILIKE $${params.length} OR w.summary ILIKE $${params.length} OR w.problem ILIKE $${params.length} OR c.display_name ILIKE $${params.length} OR c.handle ILIKE $${params.length})`); }
  const offset = (page - 1) * PAGE_SIZE;
  params.push(PAGE_SIZE + 1, offset);
  const r = await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE ${where.join(" AND ")} ORDER BY ${sortClause(sort)} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const total = (await pool.query(`SELECT count(*) AS n ${WORKFLOW_FROM} WHERE ${where.join(" AND ")}`, params.slice(0, -2))).rows[0].n;
  return { rows: r.rows.slice(0, PAGE_SIZE), hasMore: r.rows.length > PAGE_SIZE, total: Number(total) };
}
async function newWorkflows() {
  const r = await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE ${DISCOVERABLE} AND w.published_at > now() - interval '14 days' AND coalesce(s.rating_count, 0) < 3 ORDER BY w.published_at DESC LIMIT 4`);
  return r.rows;
}
async function workflowBySlug(slug) {
  const r = await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE w.slug = $1`, [slug]);
  return r.rows[0] || null;
}
async function workflowById(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE w.id = $1`, [id]);
  return r.rows[0] || null;
}
async function creatorByHandle(handle) {
  const r = await pool.query(
    `SELECT c.*, s.workflow_count, s.rating_count, s.average, s.weighted_score
       FROM creator_profiles c LEFT JOIN creator_stats s ON s.creator_id = c.id WHERE lower(c.handle) = lower($1)`,
    [handle]
  );
  return r.rows[0] || null;
}
function publicCreator(row) {
  return {
    handle: row.handle, displayName: row.display_name, bio: row.bio, avatarUrl: row.avatar_url, websiteUrl: row.website_url, xUrl: row.x_url, youtubeUrl: row.youtube_url, instagramUrl: row.instagram_url, tiktokUrl: row.tiktok_url,
    editorial: row.is_editorial, status: row.status, joinedAt: row.created_at,
    workflowCount: Number(row.workflow_count || 0), ratingCount: Number(row.rating_count || 0), weightedScore: Number(row.weighted_score || 0),
  };
}
async function stats(workflowId) {
  const r = await pool.query("SELECT rating_count, average, weighted_score FROM workflow_stats WHERE workflow_id = $1", [workflowId]);
  const row = r.rows[0] || {};
  return { ratingCount: Number(row.rating_count || 0), average: row.average === null || row.average === undefined ? null : Number(row.average), weightedScore: Number(row.weighted_score || 0) };
}
// Visible comments for a workflow, oldest first, with like counts. viewerId
// marks which ones the signed in creator already liked (null for guests).
async function listComments(workflowId, viewerId) {
  const r = await pool.query(
    `SELECT wc.id, wc.body, wc.created_at, c.handle, c.display_name, c.avatar_url,
            (SELECT count(*) FROM comment_likes cl WHERE cl.comment_id = wc.id) AS likes,
            ${viewerId ? "(SELECT count(*) FROM comment_likes cl WHERE cl.comment_id = wc.id AND cl.creator_id = $2)" : "0"} AS liked
     FROM workflow_comments wc JOIN creator_profiles c ON c.id = wc.creator_id
     WHERE wc.workflow_id = $1 AND wc.hidden_at IS NULL ORDER BY wc.created_at ASC LIMIT 100`,
    viewerId ? [workflowId, viewerId] : [workflowId]
  );
  return r.rows.map((x) => ({
    id: x.id, body: x.body, createdAt: x.created_at,
    creator: { handle: x.handle, displayName: x.display_name, avatarUrl: x.avatar_url },
    likes: Number(x.likes), liked: Number(x.liked) > 0,
  }));
}
async function isOwnerDevice(creatorId, deviceId) {
  const r = await pool.query("SELECT 1 FROM creator_devices WHERE creator_id = $1 AND device_id = $2", [creatorId, deviceId]);
  return Boolean(r.rows[0]);
}
async function setting(keyName, fallback) {
  const r = await pool.query("SELECT value FROM pool_settings WHERE key = $1", [keyName]);
  return r.rows[0] ? r.rows[0].value : fallback;
}

// ---------------------------------------------------------------------------
// Writes.
async function writeParts(client, workflowId, value) {
  await client.query("DELETE FROM workflow_steps WHERE workflow_id = $1", [workflowId]);
  await client.query("DELETE FROM workflow_prerequisites WHERE workflow_id = $1", [workflowId]);
  for (let i = 0; i < value.steps.length; i++) {
    await client.query("INSERT INTO workflow_steps (workflow_id, position, body) VALUES ($1, $2, $3)", [workflowId, i + 1, value.steps[i]]);
  }
  for (let i = 0; i < value.prerequisites.length; i++) {
    await client.query("INSERT INTO workflow_prerequisites (workflow_id, position, body) VALUES ($1, $2, $3)", [workflowId, i + 1, value.prerequisites[i]]);
  }
}
async function createWorkflow(creator, value, { status = "draft" } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const slug = await uniqueSlug(slugify(value.title));
    const cat = await categoryId(value.category);
    const r = await client.query(
      `INSERT INTO workflows (creator_id, slug, title, summary, problem, result, prompt, proof_url, screenshot_url, category_id, tags, status, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12 = 'published' THEN now() ELSE NULL END) RETURNING id, slug`,
      [creator.id, slug, value.title, value.summary || "", value.problem || "", value.result || "", value.prompt, value.proof_url, value.screenshot_url, cat, value.tags || [], status]
    );
    await writeParts(client, r.rows[0].id, value);
    await client.query("COMMIT");
    return r.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
async function updateWorkflow(existing, value, editorId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (existing.status === "published" || existing.status === "unpublished") {
      const parts = await loadParts(existing.id);
      await client.query("INSERT INTO workflow_revisions (workflow_id, editor_id, snapshot) VALUES ($1, $2, $3)", [
        existing.id, editorId, JSON.stringify({ title: existing.title, summary: existing.summary, problem: existing.problem, result: existing.result, prompt: existing.prompt, proof_url: existing.proof_url, screenshot_url: existing.screenshot_url, category: existing.category, tags: existing.tags || [], ...parts }),
      ]);
    }
    // The slug follows the title while the work is a draft and freezes once published.
    const slug = existing.status === "draft" ? await uniqueSlug(slugify(value.title), existing.id) : existing.slug;
    const cat = await categoryId(value.category);
    await client.query(
      `UPDATE workflows SET title = $2, summary = $3, problem = $4, result = $5, prompt = $6, proof_url = $7, screenshot_url = $8, category_id = $9, slug = $10, tags = $11, updated_at = now() WHERE id = $1`,
      [existing.id, value.title, value.summary || "", value.problem || "", value.result || "", value.prompt, value.proof_url, value.screenshot_url, cat, slug, value.tags || []]
    );
    await writeParts(client, existing.id, value);
    await client.query("COMMIT");
    return slug;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
async function fullWorkflowValue(row) {
  const parts = await loadParts(row.id);
  return {
    title: row.title, summary: row.summary, problem: row.problem, result: row.result, prompt: row.prompt, proof_url: row.proof_url, screenshot_url: row.screenshot_url, category: row.category, tags: row.tags || [],
    steps: parts.steps.map((s) => (typeof s === "string" ? s : s.body)), prerequisites: parts.prerequisites,
  };
}
async function publishAllowed(creator) {
  const age = await pool.query("SELECT created_at < now() - interval '1 day' AS old FROM creator_profiles WHERE id = $1", [creator.id]);
  const cap = age.rows[0] && age.rows[0].old ? PUBLISH_CAP.perDay : PUBLISH_CAP.firstDay;
  const n = await pool.query("SELECT count(*) AS n FROM workflows WHERE creator_id = $1 AND published_at > now() - interval '1 day'", [creator.id]);
  return Number(n.rows[0].n) < cap;
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by pages and JSON.
function ratingLabel(w) {
  const n = w.ratingCount || 0;
  if (n === 0) return { text: "New", stars: "", count: "" };
  if (n < 3) return { text: "New", stars: "", count: `${n} rating${n === 1 ? "" : "s"}` };
  return { text: w.average.toFixed(1), stars: "★".repeat(Math.round(w.average)) + "☆".repeat(5 - Math.round(w.average)), count: `${n} ratings` };
}
function ratingHtml(w) {
  const r = ratingLabel(w);
  if (r.text === "New") return `<span class="rating"><span class="new">New</span>${r.count ? ` <span>${esc(r.count)}</span>` : ""}</span>`;
  return `<span class="rating"><span class="stars" aria-hidden="true">${r.stars}</span> ${esc(r.text)} <span style="color:var(--muted-2);font-weight:600">${esc(r.count)}</span></span>`;
}
function dateLabel(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function cardHtml(row) {
  const w = publicWorkflow(row);
  return `<a class="card" href="/workflows/${esc(w.slug)}">
  <span class="tag">${esc(w.categoryName || "Workflow")}</span>
  <h3>${esc(w.title)}</h3>
  <p>${esc(w.summary)}</p>
  <span class="by">by ${esc(w.creator.displayName)}${w.creator.editorial ? " (editorial)" : ""}</span>
  ${w.tags.length ? `<span class="tags">${w.tags.slice(0, 3).map((t) => `#${esc(t)}`).join(" ")}</span>` : ""}
  <span class="foot">${ratingHtml(w)}<span>${esc(dateLabel(w.updatedAt))}</span></span>
</a>`;
}
function initials(name) {
  return String(name || "?").split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}
function commentHtml(cm) {
  return `<div class="comment" data-comment="${esc(cm.id)}">
    <div class="comment-head">${avatarHtml({ displayName: cm.creator.displayName, avatarUrl: cm.creator.avatarUrl }, "36px")}<div><b>${esc(cm.creator.displayName)}</b><span>@${esc(cm.creator.handle)}</span></div></div>
    <p>${esc(cm.body)}</p>
    <div class="comment-foot">
      <button class="quiet-link like-btn${cm.liked ? " on" : ""}" type="button" data-comment="${esc(cm.id)}" aria-pressed="${cm.liked}">Like${cm.likes ? ` (${cm.likes})` : ""}</button>
      <button class="quiet-link report-comment" type="button" data-comment="${esc(cm.id)}">Report</button>
    </div>
  </div>`;
}
function avatarHtml(creator, size = "") {
  const img = creator.avatarUrl || creator.avatar_url;
  return `<div class="avatar"${size ? ` style="width:${size};height:${size}"` : ""}>${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" />` : esc(initials(creator.displayName || creator.display_name))}</div>`;
}
function creatorScoreLabel(c) {
  if (!c.ratingCount) return "New";
  return c.weightedScore.toFixed(1);
}

const SESSION_JS = `fetch("/api/session", { method: "POST", credentials: "same-origin" }).catch(() => {});`;
// Fills the header account slot on server rendered pages: avatar plus quick
// links when signed in, a sign in link otherwise. Mirrors the SPA account chip.
const ACCOUNT_JS = `
      (() => {
        const slot = document.getElementById("account-slot");
        if (!slot) return;
        const esc = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
        fetch("/api/v1/me", { credentials: "same-origin" }).then((r) => r.json().catch(() => null)).then((d) => {
          const me = d && d.ok ? d : null;
          if (me && me.creator) {
            const c = me.creator;
            slot.innerHTML =
              (c.avatarUrl ? '<img src="' + esc(c.avatarUrl) + '" alt="" referrerpolicy="no-referrer" />' : "") +
              '<a href="/#mycodes">My codes</a><a href="/#saved">Saved</a><button type="button" id="slot-signout">Sign out</button>';
            document.getElementById("slot-signout").addEventListener("click", async () => {
              try { await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "fetch" } }); } catch (_) {}
              location.reload();
            });
          } else {
            slot.innerHTML = '<a href="/creator">Sign in</a>';
          }
        }).catch(() => {});
      })();`;

// ---------------------------------------------------------------------------
// Pages.
async function pageIndex(url) {
  const sort = ["top", "most", "new"].includes(url.searchParams.get("sort")) ? url.searchParams.get("sort") : "top";
  const category = (url.searchParams.get("category") || "").replace(/[^a-z-]/g, "").slice(0, 40);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const tag = (url.searchParams.get("tag") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  const page = Math.max(1, Math.min(200, Number(url.searchParams.get("page")) || 1));
  const cats = (await pool.query("SELECT slug, name FROM categories WHERE active ORDER BY position")).rows;
  const { rows, hasMore, total } = await listWorkflows({ sort, category, q, page, tag });
  const popularTags = !q ? (await pool.query(`SELECT t AS tag, count(*) AS n FROM workflows, unnest(tags) AS t WHERE status = 'published' AND hidden_at IS NULL GROUP BY t ORDER BY n DESC LIMIT 12`)).rows : [];
  const fresh = !q && !category && !tag && page === 1 && sort === "top" ? await newWorkflows() : [];
  const link = (over) => {
    const p = new URLSearchParams();
    const merged = { sort, category, q, tag, page: 1, ...over };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "sort" && v === "top") && !(k === "page" && v === 1)) p.set(k, String(v));
    const s = p.toString();
    return "/workflows" + (s ? "?" + s : "");
  };
  const catName = category ? (cats.find((c) => c.slug === category) || {}).name : "";
  const title = q ? `Muse workflows matching "${q}" | Built with Muse` : catName ? `${catName} workflows for Muse | Built with Muse` : "Muse workflows people actually run | Built with Muse";
  const description = catName
    ? `${catName} workflows for Meta's Muse: problem, steps and result, published by named creators and rated by the community.`
    : "A public record of who can make Muse useful. Practical workflows with the problem, the steps and the honest result, published by named creators and rated once per device.";
  const chips = [`<a class="chip" href="${esc(link({ category: "" }))}"${!category ? ' aria-current="true"' : ""}>All</a>`]
    .concat(cats.map((c) => `<a class="chip" href="${esc(link({ category: c.slug }))}"${category === c.slug ? ' aria-current="true"' : ""}>${esc(c.name)}</a>`)).join("");
  const sorts = [["top", "Top rated"], ["most", "Most rated"], ["new", "Newest"]].map(([k, label]) => `<a class="chip" href="${esc(link({ sort: k }))}"${sort === k ? ' aria-current="true"' : ""}>${label}</a>`).join("");
  const body = `
        <section class="hero">
          <div>
            <div class="eyebrow">Creator pool</div>
            <h1>Workflows people actually run.</h1>
            <p class="lead">Every entry states the problem, the steps and the honest result, under the name of the person who published it. Rate what you try; useful work rises.</p>
            <div class="meta"><span>${total} published</span><span>One rating per device</span><span>No approval queue</span></div>
          </div>
          <aside class="hero-aside">
            <div class="k">Publish yours</div>
            <p>Made Muse do something useful? Write it up as problem, steps, result. It goes live the moment you publish, and your reputation grows from real ratings.</p>
            <a class="cta full" href="/creator">Publish a workflow</a>
          </aside>
        </section>
        <div class="toolbar">
          <form action="/workflows" method="get" role="search">
            <input type="search" name="q" value="${esc(q)}" placeholder="Search workflows or creators" aria-label="Search workflows" maxlength="80" />
            ${category ? `<input type="hidden" name="category" value="${esc(category)}" />` : ""}
            ${sort !== "top" ? `<input type="hidden" name="sort" value="${esc(sort)}" />` : ""}
            <button class="cta" type="submit">Search</button>
          </form>
          <div class="chips">${sorts}</div>
        </div>
        <div class="chips" style="margin-bottom:26px">${chips}</div>
        ${popularTags.length && !tag ? `<div class="chips" style="margin-bottom:26px" aria-label="Popular tags">${popularTags.map((t) => `<a class="chip" href="${esc(link({ tag: t.tag }))}">#${esc(t.tag)}</a>`).join("")}</div>` : ""}
        ${tag ? `<div class="chips" style="margin-bottom:26px"><span class="chip" aria-current="true">#${esc(tag)}</span><a class="chip" href="${esc(link({ tag: "" }))}">Clear</a></div>` : ""}
        ${fresh.length ? `<div class="section-title"><h2>New this week</h2><p>Fresh work collecting its first ratings</p></div><div class="grid" style="margin-bottom:12px">${fresh.map(cardHtml).join("")}</div><div class="section-title"><h2>${catName || "All workflows"}</h2><p>${sort === "top" ? "Ranked by weighted score" : sort === "most" ? "Ranked by rating count" : "Newest first"}</p></div>` : ""}
        ${rows.length ? `<div class="grid">${rows.map(cardHtml).join("")}</div>` : `<div class="empty">${q ? "Nothing matches that search yet." : "No workflows here yet. Be the first to publish one."}</div>`}
        ${page > 1 || hasMore ? `<div class="pager">${page > 1 ? `<a class="cta ghost" href="${esc(link({ page: page - 1 }))}">Newer</a>` : ""}${hasMore ? `<a class="cta ghost" href="${esc(link({ page: page + 1 }))}">More</a>` : ""}</div>` : ""}`;
  return layout({
    title, description, path: link({}), current: "/workflows", body, script: SESSION_JS + ACCOUNT_JS,
    jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: SITE + link({}), description, isPartOf: { "@id": SITE + "/#website" } },
    noindex: Boolean(q) || Boolean(tag) || page > 1,
  });
}

function notFoundPage(what) {
  return layout({
    title: "Not found | Built with Muse", description: "That page does not exist.", path: "/workflows", noindex: true, current: "/workflows",
    body: `<section class="hero"><div><div class="eyebrow">Not found</div><h1>That ${what} is not here.</h1><p class="lead">It may have been unpublished, or the link is wrong.</p><p style="margin-top:22px"><a class="cta" href="/workflows">Browse the pool</a></p></div></section>`,
  });
}

async function pageWorkflow(slug, req) {
  const row = await workflowBySlug(slug);
  const creator = row ? await creatorFromRequest(req) : null;
  const isOwner = row && creator && creator.id === row.creator_id;
  const isMod = row && deps.isAdmin(req);
  if (!row || row.status === "removed" || row.creator_status === "removed") return { status: 404, html: notFoundPage("workflow") };
  const visible = row.status === "published" && (!row.hidden_at || isOwner || isMod);
  if (!visible && !isOwner && !isMod) return { status: 404, html: notFoundPage("workflow") };
  const w = publicWorkflow(row);
  const parts = await loadParts(row.id);
  const deviceId = deps.deviceFromCookie(req);
  let yourRating = null;
  if (deviceId) {
    const r = await pool.query("SELECT score FROM workflow_ratings WHERE workflow_id = $1 AND device_id = $2", [row.id, deviceId]);
    yourRating = r.rows[0] ? r.rows[0].score : null;
  }
  let savedNow = false;
  let saveCount = 0;
  {
    const s = await pool.query("SELECT count(*) AS n FROM workflow_saves WHERE workflow_id = $1", [row.id]);
    saveCount = Number(s.rows[0].n);
    if (creator) {
      const mine = await pool.query("SELECT 1 FROM workflow_saves WHERE workflow_id = $1 AND creator_id = $2", [row.id, creator.id]);
      savedNow = Boolean(mine.rows[0]);
      // Adopt a save from before they signed in so it follows the account.
      if (!savedNow && deviceId) {
        const moved = await pool.query(
          `UPDATE workflow_saves SET creator_id = $2, device_id = NULL
            WHERE workflow_id = $1 AND device_id = $3 AND creator_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM workflow_saves WHERE workflow_id = $1 AND creator_id = $2)`,
          [row.id, creator.id, deviceId]
        );
        savedNow = moved.rowCount > 0;
      }
    } else if (deviceId) {
      const mine = await pool.query("SELECT 1 FROM workflow_saves WHERE workflow_id = $1 AND device_id = $2", [row.id, deviceId]);
      savedNow = Boolean(mine.rows[0]);
    }
  }
  const comments = await listComments(row.id, creator ? creator.id : null);
  const ownerBlocked = isOwner || (deviceId ? await isOwnerDevice(row.creator_id, deviceId) : false);
  const more = (await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE ${DISCOVERABLE} AND c.id = $1 AND w.id <> $2 ORDER BY s.weighted_score DESC LIMIT 3`, [row.creator_id, row.id])).rows;
  const related = row.category ? (await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE ${DISCOVERABLE} AND cat.slug = $1 AND w.id <> $2 AND c.id <> $3 ORDER BY s.weighted_score DESC LIMIT 3`, [row.category, row.id, row.creator_id])).rows : [];
  const creatorRow = await creatorByHandle(row.handle);
  const c = publicCreator(creatorRow);
  let following = false;
  let followerCount = 0;
  {
    const fc = await pool.query("SELECT count(*) AS n FROM creator_follows WHERE followed_id = $1", [row.creator_id]);
    followerCount = Number(fc.rows[0].n);
    if (creator && creator.id !== row.creator_id) {
      const f = await pool.query("SELECT 1 FROM creator_follows WHERE follower_id = $1 AND followed_id = $2", [creator.id, row.creator_id]);
      following = Boolean(f.rows[0]);
    }
  }
  const canFollow = creator && creator.id !== row.creator_id && !c.editorial;
  const stepsHtml = parts.steps.map((s) => (typeof s === "string" ? `<li><span>${esc(s)}</span></li>` : `<li><span><strong>${esc(s.title)}</strong>${esc(s.body)}</span></li>`)).join("");
  const title = `${w.title} | Built with Muse`;
  const description = w.summary;
  const rl = ratingLabel(w);
  const stateNote = row.status !== "published" ? `<div class="callout"><strong>${row.status === "draft" ? "Draft" : "Unpublished"}</strong>Only you can see this page.</div>` : row.hidden_at ? `<div class="callout"><strong>Hidden after reports</strong>Visitors cannot see this workflow until a moderator restores it.</div>` : "";
  const deactivated = row.creator_status === "deactivated" ? `<div class="callout"><strong>Deactivated creator</strong>This creator's account is deactivated. The workflow stays readable but is no longer listed.</div>` : "";
  const body = `
        <section class="hero">
          <div>
            <div class="eyebrow">${esc(w.categoryName || "Workflow")}</div>
            <h1 class="title-case">${esc(w.title)}</h1>
            <p class="lead">${esc(w.summary)}</p>
            <div class="meta"><span>by <a href="/creators/${esc(c.handle)}">${esc(c.displayName)}</a>${c.editorial ? ' <span class="badge editorial">Editorial</span>' : ""}</span>${canFollow ? `<span><button class="follow-btn${following ? " on" : ""}" type="button" data-handle="${esc(c.handle)}">${following ? "Following" : "Follow"}</button></span>` : ""}<span>Updated ${esc(dateLabel(w.updatedAt))}</span><span>${ratingHtml(w)}</span></div>
            ${w.tags.length ? `<div class="tags">${w.tags.map((t) => `<a class="chip" href="/workflows?tag=${esc(t)}">#${esc(t)}</a>`).join("")}</div>` : ""}
          </div>
          <aside class="hero-aside" id="rate-box">
            <div class="k">Rate this workflow</div>
            ${ownerBlocked
              ? `<p>You cannot rate your own work. Ratings come from other people's devices.</p>`
              : `<p>${yourRating ? `You gave this ${yourRating} star${yourRating === 1 ? "" : "s"}. Change it any time.` : "Tried it? One rating per device, and you can change it later."}</p>
            <div class="rate" data-workflow="${esc(w.id)}">
              <div class="stars-input" role="radiogroup" aria-label="Your rating">
                ${[1, 2, 3, 4, 5].map((n) => `<button class="star${yourRating && n <= yourRating ? " picked" : ""}" type="button" data-score="${n}" aria-label="${n} star${n === 1 ? "" : "s"}" aria-pressed="${yourRating === n}">★</button>`).join("")}
              </div>
              <div class="rate-status" id="rate-status" aria-live="polite"></div>
              ${yourRating ? `<button class="quiet-link" type="button" id="rate-remove">Remove my rating</button>` : ""}
            </div>`}
            <div class="save-row">
              <button class="cta ghost save-btn" type="button" id="save-btn" data-workflow="${esc(w.id)}">${savedNow ? "Saved ✓" : "Save this workflow"}</button>
              <div class="rate-status" id="save-status" aria-live="polite">${saveCount ? `${saveCount} save${saveCount === 1 ? "" : "s"}` : ""}</div>
            </div>
          </aside>
        </section>
        ${row.prompt ? `<section class="prompt-block">
          <div class="k">Say this to Muse</div>
          <pre class="prompt" id="prompt-text">${esc(row.prompt)}</pre>
          <div class="prompt-actions"><button class="cta" type="button" id="copy-prompt">Copy prompt</button><span class="rate-status" id="copy-status" aria-live="polite"></span></div>
          <p class="prompt-hint">Copy it into Muse and run it.</p>
          <p class="prompt-quote">"I ran this with one prompt in Muse"</p>
        </section>` : ""}
        <div class="layout">
          <article>
            ${stateNote}${deactivated}
            ${(w.problem || row.problem) ? `<h2>The problem</h2><p>${esc(w.problem || row.problem).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />")}</p>` : ""}
            ${parts.prerequisites.length ? `<h2>Before you start</h2><ul>${parts.prerequisites.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
            ${parts.steps.length ? `<h2>Steps</h2><ol class="steps">${stepsHtml}</ol>` : ""}
            <h2>The result</h2>
            <p>${esc(row.result).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />")}</p>
            ${creator ? "" : `<div class="save-nudge"><p><strong>Want this on every device?</strong> Sign in with Google and your saved workflows follow you around.</p><a class="cta ghost" href="/creator">Sign in to save it</a></div>`}
            ${row.screenshot_url ? `<figure class="proof-shot"><img src="${esc(row.screenshot_url)}" alt="Screenshot from the workflow author" loading="lazy" /><figcaption>Screenshot shared by the author as proof.</figcaption></figure>` : ""}
            ${row.proof_url ? `<div class="proof-box"><span class="badge proof">Proof attached</span><a href="${esc(row.proof_url)}" target="_blank" rel="noopener noreferrer nofollow">Open the source</a></div>` : ""}
            <div class="save-below">
              <button class="cta save-btn" type="button" id="save-btn-below" data-workflow="${esc(w.id)}">${savedNow ? "Saved ✓" : "Save this workflow"}</button>
              <span class="rate-status" id="save-status-below" aria-live="polite">${saveCount ? `${saveCount} save${saveCount === 1 ? "" : "s"}` : ""}</span>
            </div>
            <div class="report-box">
              <details>
                <summary>Report this workflow</summary>
                <form id="report-form" data-workflow="${esc(w.id)}">
                  <select name="reason" aria-label="Reason"><option value="spam">Spam</option><option value="unsafe">Unsafe or harmful</option><option value="stolen">Stolen from someone else</option><option value="other">Something else</option></select>
                  <textarea name="detail" rows="3" maxlength="500" placeholder="What is wrong? (optional)"></textarea>
                  <div style="display:flex;gap:10px;align-items:center;margin-top:10px"><button class="cta ghost" type="submit">Send report</button><span class="rate-status" id="report-status" aria-live="polite"></span></div>
                </form>
              </details>
            </div>
          </article>
          <aside class="rail">
            <div class="rail-box">
              <div class="k">Creator</div>
              <div class="profile-head">${avatarHtml(c, "56px")}<div><h3 style="margin:0">${esc(c.displayName)}</h3><p style="margin:0">@${esc(c.handle)}</p></div></div>
              <div class="stat-row"><div class="stat"><b>${esc(creatorScoreLabel(c))}</b><span>Score</span></div><div class="stat"><b>${c.ratingCount}</b><span>Ratings</span></div><div class="stat"><b>${c.workflowCount}</b><span>Workflows</span></div></div>
              <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap"><a class="link" href="/creators/${esc(c.handle)}">See the profile</a>${canFollow ? `<button class="follow-btn lg${following ? " on" : ""}" type="button" data-handle="${esc(c.handle)}">${following ? "Following" : "Follow"}</button>` : ""}${followerCount ? `<span class="rate-status">${followerCount} follower${followerCount === 1 ? "" : "s"}</span>` : ""}</div>
            </div>
            ${more.length ? `<div class="rail-box"><div class="k">More from this creator</div>${more.map((m) => `<a class="link" href="/workflows/${esc(m.slug)}">${esc(m.title)}<small>${esc(ratingLabel(publicWorkflow(m)).text === "New" ? "New" : ratingLabel(publicWorkflow(m)).text + " · " + ratingLabel(publicWorkflow(m)).count)}</small></a>`).join("")}</div>` : ""}
            ${related.length ? `<div class="rail-box"><div class="k">Related in ${esc(w.categoryName)}</div>${related.map((m) => `<a class="link" href="/workflows/${esc(m.slug)}">${esc(m.title)}<small>by ${esc(m.display_name)}</small></a>`).join("")}</div>` : ""}
            <div class="rail-box">
              <div class="k">Not in Muse yet?</div>
              <p>The community pool hands out free invite codes.</p>
              <a class="cta" href="/">Get a code</a>
            </div>
          </aside>
        </div>
        <section class="comments" id="comments">
          <div class="section-title"><h2>Discussion</h2><p>${comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "No comments yet"}</p></div>
          <div id="comment-list">${comments.map(commentHtml).join("") || `<div class="empty">Be the first to share how this worked for you.</div>`}</div>
          ${creator
            ? `<form id="comment-form" data-workflow="${esc(w.id)}">
                <textarea name="body" rows="3" maxlength="500" placeholder="Tried it? Share what happened." aria-label="Write a comment"></textarea>
                <div style="display:flex;gap:10px;align-items:center;margin-top:10px"><button class="cta" type="submit">Post comment</button><span class="rate-status" id="comment-status" aria-live="polite"></span></div>
              </form>`
            : `<p><a class="cta ghost" href="/creator">Sign in to join the discussion</a></p>`}
        </section>`;
  const script = `${SESSION_JS}${ACCOUNT_JS}
      (() => {
        const box = document.querySelector(".rate");
        const status = document.getElementById("rate-status");
        const post = (path, options) => fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, ...options });
        if (box) {
          const stars = [...box.querySelectorAll(".star")];
          const paint = (n) => stars.forEach((s) => { s.classList.toggle("lit", Number(s.dataset.score) <= n); });
          stars.forEach((s) => { s.addEventListener("mouseenter", () => paint(Number(s.dataset.score))); s.addEventListener("mouseleave", () => paint(0)); });
          stars.forEach((s) => s.addEventListener("click", async () => {
            status.className = "rate-status"; status.textContent = "Saving";
            try {
              const r = await post("/api/v1/workflows/" + box.dataset.workflow + "/rating", { method: "PUT", body: JSON.stringify({ score: Number(s.dataset.score) }) });
              const d = await r.json();
              if (!r.ok || !d.ok) throw new Error(d.error || "failed");
              stars.forEach((x) => { const picked = Number(x.dataset.score) <= d.yourRating; x.classList.toggle("picked", picked); x.setAttribute("aria-pressed", String(Number(x.dataset.score) === d.yourRating)); });
              status.textContent = "Saved. " + (d.ratingCount < 3 ? d.ratingCount + " rating" + (d.ratingCount === 1 ? "" : "s") + " so far." : "Average " + d.average.toFixed(1) + " from " + d.ratingCount + " ratings.");
              if (!document.getElementById("rate-remove")) { const b = document.createElement("button"); b.className = "quiet-link"; b.id = "rate-remove"; b.type = "button"; b.textContent = "Remove my rating"; box.appendChild(b); wireRemove(b); }
            } catch (e) {
              status.className = "rate-status err";
              status.textContent = { own_work: "You cannot rate your own work.", no_device: "Reload the page and try again.", rate_limited: "Too many ratings from this device right now.", not_published: "This workflow is not open for ratings." }[e.message] || "Could not save. Try again.";
            }
          }));
          const wireRemove = (b) => b.addEventListener("click", async () => {
            const r = await post("/api/v1/workflows/" + box.dataset.workflow + "/rating", { method: "DELETE" });
            if (r.ok) { stars.forEach((x) => { x.classList.remove("picked"); x.setAttribute("aria-pressed", "false"); }); status.className = "rate-status"; status.textContent = "Rating removed."; b.remove(); }
          });
          const existing = document.getElementById("rate-remove"); if (existing) wireRemove(existing);
        }
        const form = document.getElementById("report-form");
        if (form) form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const s = document.getElementById("report-status"); s.className = "rate-status"; s.textContent = "Sending";
          const r = await post("/api/v1/workflows/" + form.dataset.workflow + "/report", { method: "POST", body: JSON.stringify({ reason: form.reason.value, detail: form.detail.value }) });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.ok) { s.textContent = d.duplicate ? "You already reported this." : "Thanks. A moderator will look."; form.querySelector("button").disabled = true; }
          else { s.className = "rate-status err"; s.textContent = d.error === "rate_limited" ? "Too many reports from this device." : "Could not send. Reload and try again."; }
        });
        document.querySelectorAll(".save-btn").forEach((saveBtn) => saveBtn.addEventListener("click", async () => {
          const s = saveBtn.parentElement.querySelector(".rate-status"); s.className = "rate-status"; s.textContent = "Saving";
          try {
            const r = await post("/api/v1/workflows/" + saveBtn.dataset.workflow + "/save", { method: "POST" });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            document.querySelectorAll(".save-btn").forEach((b) => { b.textContent = d.saved ? "Saved ✓" : "Save this workflow"; });
            document.querySelectorAll(".save-btn").forEach((b) => { const st = b.parentElement.querySelector(".rate-status"); if (st) st.textContent = d.saves ? d.saves + (d.saves === 1 ? " save" : " saves") : ""; });
          } catch (err) {
            s.className = "rate-status err";
            if (err && err.message === "sign_in_required") {
              s.innerHTML = 'Sign in to keep this workflow on every device. <a href="/creator" style="color:#8f6b2d;font-weight:700">Sign in with Google</a>';
            } else {
              s.textContent = "Could not save. Reload and try again.";
            }
          }
        }));
        const copyBtn = document.getElementById("copy-prompt");
        if (copyBtn) copyBtn.addEventListener("click", async () => {
          const t = document.getElementById("prompt-text").textContent;
          const s = document.getElementById("copy-status"); s.className = "rate-status"; s.textContent = "Copying";
          const done = () => { s.textContent = "Copied. Paste it into Muse."; setTimeout(() => { s.textContent = ""; }, 2500); };
          try { await navigator.clipboard.writeText(t); done(); }
          catch (_) {
            const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
            try { document.execCommand("copy"); done(); } catch (_) { s.className = "rate-status err"; s.textContent = "Copy failed. Select the text manually."; }
            ta.remove();
          }
        });
        document.querySelectorAll(".follow-btn").forEach((btn) => btn.addEventListener("click", async () => {
          const handle = btn.dataset.handle;
          const wasFollowing = btn.classList.contains("on");
          btn.disabled = true;
          try {
            const r = await post("/api/v1/creators/" + encodeURIComponent(handle) + "/follow", { method: wasFollowing ? "DELETE" : "POST" });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            document.querySelectorAll(".follow-btn").forEach((b) => {
              b.classList.toggle("on", d.following);
              b.textContent = d.following ? "Following" : "Follow";
              b.disabled = false;
            });
          } catch (_) {
            btn.disabled = false;
          }
        }));
        const cform = document.getElementById("comment-form");
        if (cform) cform.addEventListener("submit", async (e) => {
          e.preventDefault();
          const s = document.getElementById("comment-status"); s.className = "rate-status"; s.textContent = "Posting";
          const r = await post("/api/v1/workflows/" + cform.dataset.workflow + "/comments", { method: "POST", body: JSON.stringify({ body: cform.body.value }) });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.ok) { location.reload(); }
          else { s.className = "rate-status err"; s.textContent = d.error === "rate_limited" ? "Too many comments right now. Wait a bit." : "Could not post. Try again."; }
        });
        document.querySelectorAll(".like-btn").forEach((b) => b.addEventListener("click", async () => {
          const r = await post("/api/v1/comments/" + b.dataset.comment + "/like", { method: "POST" });
          if (r.status === 401) { window.location.href = "/creator"; return; }
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) return;
          b.classList.toggle("on", d.liked); b.setAttribute("aria-pressed", String(d.liked));
          b.textContent = "Like" + (d.likes ? " (" + d.likes + ")" : "");
        }));
        document.querySelectorAll(".report-comment").forEach((b) => b.addEventListener("click", async () => {
          if (!window.confirm("Report this comment as inappropriate?")) return;
          const r = await post("/api/v1/comments/" + b.dataset.comment + "/report", { method: "POST", body: JSON.stringify({ reason: "other" }) });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.ok) { b.disabled = true; b.textContent = d.duplicate ? "Already reported" : "Reported"; }
        }));
      })();`;
  const jsonld = {
    "@context": "https://schema.org", "@type": "HowTo", name: w.title, description: w.summary, url: SITE + "/workflows/" + w.slug,
    author: { "@type": c.editorial ? "Organization" : "Person", name: c.displayName, url: SITE + "/creators/" + c.handle },
    datePublished: w.publishedAt, dateModified: w.updatedAt,
    step: parts.steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, text: typeof s === "string" ? s : s.body })),
    ...(w.ratingCount >= 3 ? { aggregateRating: { "@type": "AggregateRating", ratingValue: w.average, ratingCount: w.ratingCount, bestRating: 5, worstRating: 1 } } : {}),
  };
  return { status: 200, html: layout({ title, description, path: "/workflows/" + w.slug, ogType: "article", current: "/workflows", body, script, jsonld, noindex: row.status !== "published" || Boolean(row.hidden_at) || row.creator_status !== "active" }) };
}

async function pageCreator(handle, req) {
  const row = await creatorByHandle(handle);
  if (!row || row.status === "removed") return { status: 404, html: notFoundPage("creator") };
  const c = publicCreator(row);
  const isMod = deps.isAdmin(req);
  const hidden = row.status === "deactivated";
  const viewer = await creatorFromRequest(req).catch(() => null);
  let following = false;
  let followerCount = 0;
  {
    const fc = await pool.query("SELECT count(*) AS n FROM creator_follows WHERE followed_id = $1", [row.id]);
    followerCount = Number(fc.rows[0].n);
    if (viewer && viewer.id !== row.id) {
      const f = await pool.query("SELECT 1 FROM creator_follows WHERE follower_id = $1 AND followed_id = $2", [viewer.id, row.id]);
      following = Boolean(f.rows[0]);
    }
  }
  const canFollow = viewer && viewer.id !== row.id && !row.is_editorial;
  const { rows } = hidden && !isMod ? { rows: [] } : await listWorkflows({ handle: c.handle, sort: "top", page: 1 });
  const title = `${c.displayName} (@${c.handle}) on Built with Muse`;
  const description = c.bio || `Muse workflows published by ${c.displayName}: ${c.workflowCount} workflows, ${c.ratingCount} community ratings.`;
  const body = `
        <section class="hero">
          <div>
            <div class="eyebrow">Creator</div>
            <div class="profile-head">${avatarHtml(c)}<div><h1 class="title-case" style="margin:0 0 4px">${esc(c.displayName)}</h1><p class="lead" style="font-size:16px">@${esc(c.handle)}${c.editorial ? ' <span class="badge editorial">Editorial</span>' : ""}${hidden ? ' <span class="badge off">Deactivated</span>' : ""}</p></div>${canFollow ? `<div style="margin-left:auto"><button class="follow-btn lg${following ? " on" : ""}" type="button" data-handle="${esc(c.handle)}">${following ? "Following" : "Follow"}</button></div>` : ""}</div>
            ${c.bio ? `<p class="lead">${esc(c.bio)}</p>` : ""}
            <div class="meta"><span>Joined ${esc(new Date(c.joinedAt).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }))}</span>${followerCount ? `<span>${followerCount} follower${followerCount === 1 ? "" : "s"}</span>` : ""}${c.websiteUrl ? `<span><a href="${esc(c.websiteUrl)}" target="_blank" rel="noopener noreferrer nofollow">${esc(c.websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a></span>` : ""}${[["xUrl", "X"], ["youtubeUrl", "YouTube"], ["instagramUrl", "Instagram"], ["tiktokUrl", "TikTok"]].filter(([k]) => c[k]).map(([k, label]) => `<span><a href="${esc(c[k])}" target="_blank" rel="noopener noreferrer nofollow">${label}</a></span>`).join("")}</div>
          </div>
          <aside class="hero-aside">
            <div class="k">Reputation</div>
            <div class="stat-row"><div class="stat"><b>${esc(creatorScoreLabel(c))}</b><span>Score</span></div><div class="stat"><b>${c.ratingCount}</b><span>Ratings</span></div><div class="stat"><b>${c.workflowCount}</b><span>Workflows</span></div></div>
            <p style="margin:12px 0 0;font-size:14px">${c.ratingCount ? "Weighted across every rating this creator has received. Small samples lean on the pool average." : "No ratings yet. The score appears once people rate this creator's work."}</p>
          </aside>
        </section>
        ${c.editorial ? `<div class="callout"><strong>Researched, not community authored</strong>These workflows were written up by the Built with Muse team from public reports and Meta's announcements.</div>` : ""}
        ${hidden ? `<div class="callout"><strong>Deactivated</strong>This creator has deactivated their account. Their workflows are no longer listed.</div>` : ""}
        <div class="section-title"><h2>Published workflows</h2><p>Top rated first</p></div>
        ${rows.length ? `<div class="grid">${rows.map(cardHtml).join("")}</div>` : `<div class="empty">Nothing published yet.</div>`}`;
  const jsonld = { "@context": "https://schema.org", "@type": c.editorial ? "Organization" : "Person", name: c.displayName, url: SITE + "/creators/" + c.handle, description };
  const followScript = `
      (() => {
        const post = (path, options) => fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, ...options });
        document.querySelectorAll(".follow-btn").forEach((btn) => btn.addEventListener("click", async () => {
          const handle = btn.dataset.handle;
          const wasFollowing = btn.classList.contains("on");
          btn.disabled = true;
          try {
            const r = await post("/api/v1/creators/" + encodeURIComponent(handle) + "/follow", { method: wasFollowing ? "DELETE" : "POST" });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            btn.classList.toggle("on", d.following);
            btn.textContent = d.following ? "Following" : "Follow";
          } catch (_) {}
          btn.disabled = false;
        }));
      })();`;
  return { status: 200, html: layout({ title, description, path: "/creators/" + c.handle, ogType: "profile", current: "/workflows", body, script: SESSION_JS + ACCOUNT_JS + followScript, jsonld, noindex: hidden }) };
}

// Top creators by weighted score. Editorial accounts are excluded so the
// seeded staff content never outranks real community creators.
async function pageLeaderboard() {
  const r = await pool.query(
    `SELECT c.*, s.workflow_count, s.rating_count, s.average, s.weighted_score
     FROM creator_profiles c LEFT JOIN creator_stats s ON s.creator_id = c.id
     WHERE c.status = 'active' AND NOT c.is_editorial AND coalesce(s.workflow_count, 0) > 0
     ORDER BY coalesce(s.weighted_score, 0) DESC, coalesce(s.rating_count, 0) DESC LIMIT 50`
  );
  const rows = r.rows.map(publicCreator);
  const title = "Top Muse workflow creators | Built with Muse";
  const description = "The creators behind the highest rated Muse workflows, ranked by community ratings.";
  const body = `
        <section class="hero">
          <div>
            <div class="eyebrow">Leaderboard</div>
            <h1>Top creators.</h1>
            <p class="lead">Ranked by the weighted score across every rating their workflows received. Small samples lean on the pool average, so new creators are not punished for having few ratings.</p>
          </div>
          <aside class="hero-aside">
            <div class="k">Join the board</div>
            <p>Publish a workflow, collect ratings from people who try it, and your name climbs here.</p>
            <a class="cta full" href="/creator">Publish a workflow</a>
          </aside>
        </section>
        ${rows.length ? `<div class="board">${rows.map((c, i) => `
          <a class="board-row" href="/creators/${esc(c.handle)}">
            <span class="rank">${i + 1}</span>
            ${avatarHtml(c, "48px")}
            <span class="who"><b>${esc(c.displayName)}</b><span>@${esc(c.handle)}</span></span>
            <span class="nums"><b>${esc(creatorScoreLabel(c))}</b><span>${c.ratingCount} rating${c.ratingCount === 1 ? "" : "s"} · ${c.workflowCount} workflow${c.workflowCount === 1 ? "" : "s"}</span></span>
          </a>`).join("")}</div>`
        : `<div class="empty">No ranked creators yet. Publish the first workflow.</div>`}`;
  return { status: 200, html: layout({ title, description, path: "/creators", current: "/creators", body, script: SESSION_JS + ACCOUNT_JS }) };
}

// The pool's own sitemap. public/sitemap.xml is a static file that Vercel
// serves before any rewrite, and it is edited by hand, so the dynamic pages
// get a second sitemap that robots.txt lists alongside it.
async function sitemapXml() {
  const workflows = (await pool.query(`SELECT w.slug, w.updated_at ${WORKFLOW_FROM} WHERE ${DISCOVERABLE} ORDER BY w.published_at DESC LIMIT 5000`)).rows;
  const creators = (await pool.query(`SELECT handle, updated_at FROM creator_profiles WHERE status = 'active' AND EXISTS (SELECT 1 FROM workflows w WHERE w.creator_id = creator_profiles.id AND w.status = 'published')`)).rows;
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const urls = [`  <url><loc>${SITE}/workflows</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`, `  <url><loc>${SITE}/creators</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`]
    .concat(workflows.map((w) => `  <url><loc>${SITE}/workflows/${esc(w.slug)}</loc><lastmod>${day(w.updated_at)}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`))
    .concat(creators.map((c) => `  <url><loc>${SITE}/creators/${esc(c.handle)}</loc><lastmod>${day(c.updated_at)}</lastmod><changefreq>weekly</changefreq><priority>0.5</priority></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

// ---------------------------------------------------------------------------
// The request handler. Returns true when it handled the request.
async function handle(req, res, url, ctx) {
  const { reply, ip, ua, body: readBody } = ctx;
  // Deterministic schema readiness: never run a query before the creator
  // tables (and the referral foreign keys) exist.
  if (schemaReady) await schemaReady;
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "v1", ...]
  const deviceId = deps.deviceFromCookie(req);
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  // Same origin check for every write: a cross site form cannot set this header.
  if (mutating && req.headers["x-requested-with"] !== "fetch") return reply(403, { ok: false, error: "forbidden" });

  // ----- pages -----
  if (parts[1] === "pages") {
    const html = async (out) => { res.writeHead(out.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(out.html); };
    if (parts[2] === "workflows" && parts.length === 3) return html({ status: 200, html: await pageIndex(url) });
    if (parts[2] === "workflows" && parts.length === 4) return html(await pageWorkflow(decodeURIComponent(parts[3]).toLowerCase(), req));
    if (parts[2] === "creators" && parts.length === 3) return html(await pageLeaderboard());
    if (parts[2] === "creators" && parts.length === 4) return html(await pageCreator(decodeURIComponent(parts[3]), req));
    if (parts[2] === "creator" && parts.length === 3) return html({ status: 200, html: dashboardPage() });
    if (parts[2] === "sitemap") {
      const xml = await sitemapXml();
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" });
      return res.end(xml);
    }
    return html({ status: 404, html: notFoundPage("page") });
  }

  // ----- admin -----
  if (parts[1] === "admin" && parts[2] === "pool") {
    const who = deps.adminIdentity(req);
    if (!who) return reply(401, { ok: false, error: "unauthorized" });
    const actor = who.email || "token";
    if (req.method === "GET" && parts[3] === "overview") {
      const r = await pool.query(`SELECT
        (SELECT count(*) FROM workflows WHERE status = 'published') AS published,
        (SELECT count(*) FROM workflows WHERE status = 'published' AND hidden_at IS NOT NULL) AS hidden,
        (SELECT count(*) FROM workflows WHERE status = 'draft') AS drafts,
        (SELECT count(*) FROM creator_profiles WHERE status = 'active') AS creators,
        (SELECT count(*) FROM workflow_ratings) AS ratings,
        (SELECT count(*) FROM workflow_ratings WHERE created_at > now() - interval '1 day') AS ratings_24h,
        (SELECT count(*) FROM workflow_reports WHERE status = 'open') AS open_reports,
        (SELECT count(*) FROM workflows WHERE published_at > now() - interval '1 day') AS published_24h`);
      return reply(200, { ok: true, ...Object.fromEntries(Object.entries(r.rows[0]).map(([k, v]) => [k, Number(v)])) });
    }
    if (req.method === "GET" && parts[3] === "reports") {
      const r = await pool.query(`SELECT rp.id, rp.reason, rp.detail, rp.status, rp.created_at, left(rp.device_id, 8) AS device, w.id AS workflow_id, w.slug, w.title, w.status AS workflow_status, w.hidden_at, c.handle,
          (SELECT count(*) FROM workflow_reports x WHERE x.workflow_id = w.id AND x.status = 'open') AS open_count
        FROM workflow_reports rp JOIN workflows w ON w.id = rp.workflow_id JOIN creator_profiles c ON c.id = w.creator_id
        ORDER BY (rp.status = 'open') DESC, rp.created_at DESC LIMIT 200`);
      return reply(200, { ok: true, rows: r.rows });
    }
    if (req.method === "GET" && parts[3] === "workflows") {
      const status = ["draft", "published", "unpublished", "removed", "hidden"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "published";
      const where = status === "hidden" ? "w.status = 'published' AND w.hidden_at IS NOT NULL" : "w.status = $1";
      const r = await pool.query(`SELECT w.id, w.slug, w.title, w.status, w.hidden_at, w.published_at, w.updated_at, w.exclude_from_reputation, c.handle, c.status AS creator_status, s.rating_count, s.average
        FROM workflows w JOIN creator_profiles c ON c.id = w.creator_id LEFT JOIN workflow_stats s ON s.workflow_id = w.id WHERE ${where} ORDER BY w.updated_at DESC LIMIT 300`, status === "hidden" ? [] : [status]);
      return reply(200, { ok: true, rows: r.rows });
    }
    if (req.method === "GET" && parts[3] === "creators") {
      const r = await pool.query(`SELECT c.id, c.handle, c.display_name, c.email, c.status, c.is_editorial, c.created_at, s.workflow_count, s.rating_count, s.weighted_score
        FROM creator_profiles c LEFT JOIN creator_stats s ON s.creator_id = c.id ORDER BY c.created_at DESC LIMIT 300`);
      return reply(200, { ok: true, rows: r.rows });
    }
    if (req.method === "POST" && parts[3] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[4] || "")) {
      const body = await readBody();
      const id = parts[4];
      if (parts[5] === "hide") { await pool.query("UPDATE workflows SET hidden_at = coalesce(hidden_at, now()) WHERE id = $1", [id]); await event("admin_hide", { workflowId: id, actor }); return reply(200, { ok: true }); }
      if (parts[5] === "restore") { await pool.query("UPDATE workflows SET hidden_at = NULL, status = CASE WHEN status = 'removed' THEN 'published' ELSE status END, removed_reason = NULL, exclude_from_reputation = false WHERE id = $1", [id]); await pool.query("UPDATE workflow_reports SET status = 'dismissed' WHERE workflow_id = $1 AND status = 'open'", [id]); await event("admin_restore", { workflowId: id, actor }); return reply(200, { ok: true }); }
      if (parts[5] === "remove") {
        const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
        if (!reason) return reply(400, { ok: false, error: "reason_required" });
        await pool.query("UPDATE workflows SET status = 'removed', removed_reason = $2, exclude_from_reputation = $3, updated_at = now() WHERE id = $1", [id, reason, Boolean(body.excludeFromReputation)]);
        await pool.query("UPDATE workflow_reports SET status = 'resolved' WHERE workflow_id = $1 AND status = 'open'", [id]);
        await event("admin_remove", { workflowId: id, actor, detail: { reason, exclude: Boolean(body.excludeFromReputation) } });
        return reply(200, { ok: true });
      }
    }
    if (req.method === "POST" && parts[3] === "reports" && /^\d+$/.test(parts[4] || "") && ["resolve", "dismiss"].includes(parts[5])) {
      await pool.query("UPDATE workflow_reports SET status = $2 WHERE id = $1", [Number(parts[4]), parts[5] === "resolve" ? "resolved" : "dismissed"]);
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && parts[3] === "creators" && /^[0-9a-f-]{36}$/.test(parts[4] || "") && parts[5] === "status") {
      const body = await readBody();
      if (!["active", "deactivated", "removed"].includes(body.status)) return reply(400, { ok: false, error: "bad_status" });
      await pool.query("UPDATE creator_profiles SET status = $2, updated_at = now() WHERE id = $1", [parts[4], body.status]);
      await event("admin_creator_status", { creatorId: parts[4], actor, detail: { status: body.status } });
      return reply(200, { ok: true });
    }
    return reply(404, { ok: false, error: "not_found" });
  }

  if (parts[1] !== "v1") return false;

  // ----- public reads -----
  if (req.method === "GET" && parts[2] === "categories") {
    const r = await pool.query("SELECT slug, name FROM categories WHERE active ORDER BY position");
    return reply(200, { ok: true, categories: r.rows }, { "Cache-Control": "public, max-age=300" });
  }
  if (req.method === "GET" && parts[2] === "workflows" && parts.length === 3) {
    const sort = ["top", "most", "new"].includes(url.searchParams.get("sort")) ? url.searchParams.get("sort") : "top";
    const category = (url.searchParams.get("category") || "").replace(/[^a-z-]/g, "").slice(0, 40);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
    const page = Math.max(1, Math.min(200, Number(url.searchParams.get("page")) || 1));
    const { rows, hasMore, total } = await listWorkflows({ sort, category, q, page });
    return reply(200, { ok: true, total, page, hasMore, workflows: rows.map(publicWorkflow) }, { "Cache-Control": "public, max-age=30" });
  }
  if (req.method === "GET" && parts[2] === "workflows" && parts.length === 4) {
    const row = await workflowBySlug(decodeURIComponent(parts[3]).toLowerCase());
    if (!row || row.status !== "published" || row.hidden_at || row.creator_status === "removed") return reply(404, { ok: false, error: "not_found" });
    const parts_ = await loadParts(row.id);
    return reply(200, { ok: true, workflow: { ...publicWorkflow(row), problem: row.problem, result: row.result, prompt: row.prompt, proofUrl: row.proof_url, ...parts_ } }, { "Cache-Control": "public, max-age=30" });
  }
  if (req.method === "GET" && parts[2] === "creators" && parts.length === 4) {
    const row = await creatorByHandle(decodeURIComponent(parts[3]));
    if (!row || row.status === "removed") return reply(404, { ok: false, error: "not_found" });
    const c = publicCreator(row);
    const { rows } = row.status === "active" ? await listWorkflows({ handle: c.handle, page: 1 }) : { rows: [] };
    return reply(200, { ok: true, creator: c, workflows: rows.map(publicWorkflow) }, { "Cache-Control": "public, max-age=30" });
  }

  // ----- auth -----
  if (parts[2] === "auth") {
    if (req.method === "GET" && parts[3] === "config") {
      return reply(200, { ok: true, clientId: deps.GOOGLE_CLIENT_ID, submissionsOpen: (await setting("submissions_open", "true")) === "true" });
    }
    if (req.method === "POST" && parts[3] === "google") {
      if (await overLimit("submissions", "ip_hash", ip, RATE.login.ip)) return reply(429, { ok: false, error: "rate_limited" });
      await pool.query("INSERT INTO submissions (kind, ip_hash) VALUES ('creator_login', $1)", [ip]);
      const body = await readBody();
      let payload;
      try {
        payload = await deps.verifyGoogleIdToken(body.credential);
      } catch (err) {
        return reply(401, { ok: false, error: "bad_token" });
      }
      const email = String(payload.email).toLowerCase();
      const existing = await pool.query("SELECT * FROM creator_profiles WHERE lower(email) = $1", [email]);
      const profile = existing.rows[0];
      if (profile) {
        if (profile.status === "removed") return reply(403, { ok: false, error: "account_removed" });
        if (profile.status === "deactivated") return reply(403, { ok: false, error: "account_deactivated" });
        await pool.query("UPDATE creator_profiles SET google_sub = coalesce(google_sub, $2), last_seen_at = now() WHERE id = $1", [profile.id, String(payload.sub || "")]);
        await rememberDevice(profile.id, deviceId);
        await event("login", { creatorId: profile.id, deviceId });
        return reply(200, { ok: true, signedIn: true, handle: profile.handle, needsHandle: !profile.handle_claimed }, { "Set-Cookie": cookie(req, CREATOR_COOKIE, signBody("creator", { cid: profile.id }, SESSION_SECONDS), SESSION_SECONDS) });
      }
      const open = (await setting("submissions_open", "true")) === "true";
      if (!open) return reply(403, { ok: false, error: "submissions_closed" });
      // First Google sign in: create the minimal profile immediately, with an
      // auto handle the owner can replace later. Code claimers get an account
      // without ever seeing creator onboarding.
      const autoName = String(payload.name || "").slice(0, 60).trim() || "Muse member";
      const autoPicture = typeof payload.picture === "string" && /^https:\/\//.test(payload.picture) ? payload.picture.slice(0, 500) : null;
      let autoHandle = "";
      for (let i = 0; i < 5 && !autoHandle; i++) {
        const candidate = "user_" + crypto.randomBytes(4).toString("hex");
        const taken = await pool.query("SELECT 1 FROM creator_profiles WHERE lower(handle) = lower($1)", [candidate]);
        if (!taken.rows[0]) autoHandle = candidate;
      }
      if (!autoHandle) return reply(500, { ok: false, error: "server_error" });
      const created = await pool.query(
        `INSERT INTO creator_profiles (email, google_sub, handle, display_name, avatar_url, handle_claimed, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, false, now())
         ON CONFLICT (lower(email)) DO NOTHING RETURNING id, handle`,
        [email, String(payload.sub || "") || null, autoHandle, autoName, autoPicture]
      );
      if (!created.rows[0]) {
        // A concurrent sign in won the race; sign in against the winner.
        const again = await pool.query("SELECT * FROM creator_profiles WHERE lower(email) = $1", [email]);
        const winner = again.rows[0];
        if (!winner) return reply(500, { ok: false, error: "server_error" });
        if (winner.status === "removed") return reply(403, { ok: false, error: "account_removed" });
        if (winner.status === "deactivated") return reply(403, { ok: false, error: "account_deactivated" });
        await pool.query("UPDATE creator_profiles SET google_sub = coalesce(google_sub, $2), last_seen_at = now() WHERE id = $1", [winner.id, String(payload.sub || "")]);
        await rememberDevice(winner.id, deviceId);
        await event("login", { creatorId: winner.id, deviceId });
        return reply(200, { ok: true, signedIn: true, handle: winner.handle, needsHandle: !winner.handle_claimed }, { "Set-Cookie": cookie(req, CREATOR_COOKIE, signBody("creator", { cid: winner.id }, SESSION_SECONDS), SESSION_SECONDS) });
      }
      await rememberDevice(created.rows[0].id, deviceId);
      await event("signup", { creatorId: created.rows[0].id, deviceId });
      return reply(200, { ok: true, signedIn: true, handle: created.rows[0].handle, needsHandle: true }, { "Set-Cookie": cookie(req, CREATOR_COOKIE, signBody("creator", { cid: created.rows[0].id }, SESSION_SECONDS), SESSION_SECONDS) });
    }
    if (req.method === "POST" && parts[3] === "logout") {
      return reply(200, { ok: true }, { "Set-Cookie": [clearCookie(req, CREATOR_COOKIE), clearCookie(req, SIGNUP_COOKIE)] });
    }
    return reply(404, { ok: false, error: "not_found" });
  }

  // ----- profile creation from the signup cookie -----
  if (req.method === "POST" && parts[2] === "me" && parts[3] === "profile" && parts.length === 4 && !(await creatorFromRequest(req))) {
    const signup = readSigned("signup", deps.parseCookies(req)[SIGNUP_COOKIE]);
    if (!signup || !signup.email) return reply(401, { ok: false, error: "sign_in_first" });
    const body = await readBody();
    const errors = [];
    const handle = typeof body.handle === "string" ? body.handle.trim() : "";
    if (!HANDLE_RE.test(handle)) errors.push("handle_invalid");
    else if (RESERVED_HANDLES.has(handle.toLowerCase())) errors.push("handle_reserved");
    const displayName = text(body.displayName, LIMITS.displayName, "display_name", errors);
    const bio = text(body.bio, LIMITS.bio, "bio", errors, { required: false });
    const website = validUrl(body.websiteUrl, "website", errors);
    if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
    const taken = await pool.query("SELECT 1 FROM creator_profiles WHERE lower(handle) = lower($1)", [handle]);
    if (taken.rows[0]) return reply(409, { ok: false, error: "handle_taken" });
    const r = await pool.query(
      `INSERT INTO creator_profiles (email, google_sub, handle, display_name, bio, avatar_url, website_url, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (lower(email)) DO NOTHING RETURNING id, handle`,
      [signup.email, signup.sub || null, handle, displayName, bio, body.useGoogleAvatar === false ? null : signup.picture || null, website]
    );
    if (!r.rows[0]) return reply(409, { ok: false, error: "email_taken" });
    await rememberDevice(r.rows[0].id, deviceId);
    await event("signup", { creatorId: r.rows[0].id, deviceId });
    return reply(200, { ok: true, handle: r.rows[0].handle }, { "Set-Cookie": [cookie(req, CREATOR_COOKIE, signBody("creator", { cid: r.rows[0].id }, SESSION_SECONDS), SESSION_SECONDS), clearCookie(req, SIGNUP_COOKIE)] });
  }

  // ----- device writes: ratings and reports -----
  if (parts[2] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && (parts[4] === "rating" || parts[4] === "report")) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    if (!deviceId) return reply(403, { ok: false, error: "no_device" });
    const row = await workflowById(parts[3]);
    if (!row || row.status !== "published" || row.creator_status === "removed") return reply(404, { ok: false, error: "not_published" });
    const creator = await creatorFromRequest(req);
    if (creator) await rememberDevice(creator.id, deviceId);
    const own = (creator && creator.id === row.creator_id) || (await isOwnerDevice(row.creator_id, deviceId));
    if (parts[4] === "rating") {
      if (own) return reply(403, { ok: false, error: "own_work" });
      if (req.method === "PUT") {
        const body = await readBody();
        const score = Number(body.score);
        if (!Number.isInteger(score) || score < 1 || score > 5) return reply(400, { ok: false, error: "bad_score" });
        if (await overLimit("workflow_ratings", "device_id", deviceId, RATE.rating.device)) return reply(429, { ok: false, error: "rate_limited" });
        if (await overLimit("workflow_ratings", "ip_hash", ip, RATE.rating.ip)) return reply(429, { ok: false, error: "rate_limited" });
        const r = await pool.query(
          `INSERT INTO workflow_ratings (workflow_id, device_id, rater_creator_id, score, ip_hash) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workflow_id, device_id) DO UPDATE SET score = EXCLUDED.score, rater_creator_id = coalesce(EXCLUDED.rater_creator_id, workflow_ratings.rater_creator_id), updated_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [row.id, deviceId, creator ? creator.id : null, score, ip]
        );
        await event(r.rows[0].inserted ? "rating_create" : "rating_update", { workflowId: row.id, deviceId, creatorId: creator ? creator.id : null, detail: { score } });
        return reply(200, { ok: true, yourRating: score, ...(await stats(row.id)) });
      }
      if (req.method === "DELETE") {
        const r = await pool.query("DELETE FROM workflow_ratings WHERE workflow_id = $1 AND device_id = $2 RETURNING id", [row.id, deviceId]);
        if (r.rows[0]) await event("rating_delete", { workflowId: row.id, deviceId });
        return reply(200, { ok: true, yourRating: null, ...(await stats(row.id)) });
      }
      if (req.method === "GET") {
        const r = await pool.query("SELECT score FROM workflow_ratings WHERE workflow_id = $1 AND device_id = $2", [row.id, deviceId]);
        return reply(200, { ok: true, yourRating: r.rows[0] ? r.rows[0].score : null, ownWork: own, ...(await stats(row.id)) });
      }
      return reply(405, { ok: false, error: "method" });
    }
    if (req.method === "POST") {
      const body = await readBody();
      const reason = REPORT_REASONS.includes(body.reason) ? body.reason : null;
      if (!reason) return reply(400, { ok: false, error: "bad_reason" });
      const detail = typeof body.detail === "string" ? body.detail.replace(DASH_RE, "-").trim().slice(0, LIMITS.detail[1]) : null;
      if (await overLimit("workflow_reports", "device_id", deviceId, RATE.report.device)) return reply(429, { ok: false, error: "rate_limited" });
      if (await overLimit("workflow_reports", "ip_hash", ip, RATE.report.ip)) return reply(429, { ok: false, error: "rate_limited" });
      const r = await pool.query(
        "INSERT INTO workflow_reports (workflow_id, device_id, reporter_creator_id, reason, detail, ip_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (workflow_id, device_id) DO NOTHING RETURNING id",
        [row.id, deviceId, creator ? creator.id : null, reason, detail || null, ip]
      );
      if (!r.rows[0]) return reply(200, { ok: true, duplicate: true });
      await event("report", { workflowId: row.id, deviceId, creatorId: creator ? creator.id : null, detail: { reason } });
      // Automatic hide only past a clear burst from distinct devices.
      const threshold = Number(await setting("report_hide_threshold", "3")) || 3;
      const distinct = await pool.query("SELECT count(DISTINCT device_id) AS n FROM workflow_reports WHERE workflow_id = $1 AND status = 'open'", [row.id]);
      if (Number(distinct.rows[0].n) >= threshold && !row.hidden_at) {
        await pool.query("UPDATE workflows SET hidden_at = now() WHERE id = $1", [row.id]);
        await event("auto_hide", { workflowId: row.id, detail: { reports: Number(distinct.rows[0].n) } });
      }
      return reply(200, { ok: true });
    }
    return reply(405, { ok: false, error: "method" });
  }

  // ----- comments: reading and reporting are device level, writing needs a creator below -----
  if (parts[2] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "comments" && parts.length === 5) {
    const row = await workflowById(parts[3]);
    if (!row || row.status !== "published" || row.creator_status === "removed") return reply(404, { ok: false, error: "not_published" });
    if (req.method !== "GET") return reply(405, { ok: false, error: "method" });
    return reply(200, { ok: true, comments: await listComments(row.id, null) });
  }
  if (req.method === "POST" && parts[2] === "comments" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "report" && parts.length === 5) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    if (!deviceId) return reply(403, { ok: false, error: "no_device" });
    const c = await pool.query("SELECT wc.id, w.status AS wstatus FROM workflow_comments wc JOIN workflows w ON w.id = wc.workflow_id WHERE wc.id = $1 AND wc.hidden_at IS NULL", [parts[3]]);
    if (!c.rows[0] || c.rows[0].wstatus !== "published") return reply(404, { ok: false, error: "not_found" });
    const body = await readBody();
    const reason = REPORT_REASONS.includes(body.reason) ? body.reason : null;
    if (!reason) return reply(400, { ok: false, error: "bad_reason" });
    if (await overLimit("comment_reports", "device_id", deviceId, RATE.report.device)) return reply(429, { ok: false, error: "rate_limited" });
    const r = await pool.query("INSERT INTO comment_reports (comment_id, device_id, reason) VALUES ($1, $2, $3) ON CONFLICT (comment_id, device_id) DO NOTHING RETURNING id", [parts[3], deviceId, reason]);
    if (!r.rows[0]) return reply(200, { ok: true, duplicate: true });
    await event("comment_report", { creatorId: null, deviceId, detail: { comment: parts[3], reason } });
    const distinct = await pool.query("SELECT count(DISTINCT device_id) AS n FROM comment_reports WHERE comment_id = $1", [parts[3]]);
    if (Number(distinct.rows[0].n) >= 3) {
      await pool.query("UPDATE workflow_comments SET hidden_at = now() WHERE id = $1 AND hidden_at IS NULL", [parts[3]]);
      await event("comment_auto_hide", { deviceId, detail: { comment: parts[3], reports: Number(distinct.rows[0].n) } });
    }
    return reply(200, { ok: true });
  }

  // ----- everything below needs a creator session -----
  const creator = await creatorFromRequest(req);
  if (!creator) return reply(401, { ok: false, error: "sign_in_required" });

  // ----- saves: one account, every device -----
  if (req.method === "POST" && parts[2] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "save") {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    const row = await workflowById(parts[3]);
    if (!row || row.status !== "published" || row.creator_status === "removed") return reply(404, { ok: false, error: "not_published" });
    const existing = await pool.query("SELECT 1 FROM workflow_saves WHERE workflow_id = $1 AND creator_id = $2", [row.id, creator.id]);
    let saved;
    if (existing.rows[0]) {
      await pool.query("DELETE FROM workflow_saves WHERE workflow_id = $1 AND creator_id = $2", [row.id, creator.id]);
      saved = false;
    } else {
      // Adopt the save from before they signed in so the count stays honest.
      if (deviceId) await pool.query("DELETE FROM workflow_saves WHERE workflow_id = $1 AND device_id = $2 AND creator_id IS NULL", [row.id, deviceId]);
      await pool.query("INSERT INTO workflow_saves (workflow_id, creator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [row.id, creator.id]);
      saved = true;
    }
    const n = await pool.query("SELECT count(*) AS n FROM workflow_saves WHERE workflow_id = $1", [row.id]);
    await event(saved ? "save" : "unsave", { workflowId: row.id, creatorId: creator.id, deviceId });
    return reply(200, { ok: true, saved, saves: Number(n.rows[0].n) });
  }
  // ----- follows: one account follows another creator -----
  if (parts[2] === "creators" && parts[3] && parts[4] === "follow" && parts.length === 5) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    const target = await creatorByHandle(decodeURIComponent(parts[3]).toLowerCase());
    if (!target || target.status !== "active") return reply(404, { ok: false, error: "not_found" });
    if (target.id === creator.id) return reply(400, { ok: false, error: "own_profile" });
    if (target.is_editorial) return reply(400, { ok: false, error: "editorial" });
    if (req.method === "POST") {
      await pool.query("INSERT INTO creator_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [creator.id, target.id]);
    } else if (req.method === "DELETE") {
      await pool.query("DELETE FROM creator_follows WHERE follower_id = $1 AND followed_id = $2", [creator.id, target.id]);
    } else {
      return reply(405, { ok: false, error: "method_not_allowed" });
    }
    const mine = await pool.query("SELECT 1 FROM creator_follows WHERE follower_id = $1 AND followed_id = $2", [creator.id, target.id]);
    const count = await pool.query("SELECT count(*) AS n FROM creator_follows WHERE followed_id = $1", [target.id]);
    return reply(200, { ok: true, following: Boolean(mine.rows[0]), followers: Number(count.rows[0].n) });
  }
  if (req.method === "GET" && parts[2] === "me" && parts[3] === "saves" && parts.length === 4) {
    const r = await pool.query(
      `SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} JOIN workflow_saves sv ON sv.workflow_id = w.id WHERE sv.creator_id = $1 AND ${DISCOVERABLE} ORDER BY sv.created_at DESC LIMIT 100`,
      [creator.id]
    );
    return reply(200, { ok: true, workflows: r.rows.map(publicWorkflow) });
  }

  // ----- my referral codes: everything the owner needs to keep a code alive -----
  if (req.method === "GET" && parts[2] === "me" && parts[3] === "codes" && parts.length === 4) {
    const r = await pool.query(
      `SELECT c.id, c.code, c.invite_link, c.source, c.owner_invites, c.last_verified_at, c.reports, c.redeemed, c.retired_at, c.created_at,
              (SELECT count(*) FROM claims cl WHERE cl.code_id = c.id) AS claimed_by,
              (SELECT count(*) FROM redemptions rd WHERE rd.code_id = c.id) AS confirmed
         FROM codes c
        WHERE c.owner_creator_id = $1
        ORDER BY c.retired_at NULLS FIRST, c.created_at DESC`,
      [creator.id]
    );
    return reply(200, {
      ok: true,
      codes: r.rows.map((x) => ({
        id: x.id,
        code: x.code,
        inviteLink: x.invite_link,
        source: x.source,
        ownerInvites: x.owner_invites,
        verifiedDays: x.last_verified_at ? Math.floor((Date.now() - new Date(x.last_verified_at).getTime()) / 86400000) : null,
        reports: Number(x.reports || 0),
        confirmed: Number(x.confirmed || 0),
        claimedBy: Number(x.claimed_by || 0),
        retired: Boolean(x.retired_at),
      })),
    });
  }
  if (creator.status !== "active") return reply(403, { ok: false, error: "account_" + creator.status }, { "Set-Cookie": clearCookie(req, CREATOR_COOKIE) });
  await rememberDevice(creator.id, deviceId);

  // ----- comments: posting and liking need a creator session -----
  if (parts[2] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "comments" && parts.length === 5 && req.method === "POST") {
    const row = await workflowById(parts[3]);
    if (!row || row.status !== "published" || row.creator_status === "removed") return reply(404, { ok: false, error: "not_published" });
    const body = await readBody();
    const errors = [];
    const commentBody = text(body.body, [1, 500], "comment", errors);
    if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
    if (await overLimit("workflow_comments", "creator_id", creator.id, { hour: 10, day: 50 })) return reply(429, { ok: false, error: "rate_limited" });
    const r = await pool.query("INSERT INTO workflow_comments (workflow_id, creator_id, body) VALUES ($1, $2, $3) RETURNING id, created_at", [row.id, creator.id, commentBody]);
    await event("comment_create", { workflowId: row.id, creatorId: creator.id, deviceId });
    return reply(200, {
      ok: true,
      comment: { id: r.rows[0].id, body: commentBody, createdAt: r.rows[0].created_at, creator: { handle: creator.handle, displayName: creator.display_name, avatarUrl: creator.avatar_url }, likes: 0, liked: false },
    });
  }
  if (req.method === "POST" && parts[2] === "comments" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "like" && parts.length === 5) {
    const c = await pool.query("SELECT wc.id, w.status AS wstatus FROM workflow_comments wc JOIN workflows w ON w.id = wc.workflow_id WHERE wc.id = $1 AND wc.hidden_at IS NULL", [parts[3]]);
    if (!c.rows[0] || c.rows[0].wstatus !== "published") return reply(404, { ok: false, error: "not_found" });
    const existing = await pool.query("SELECT 1 FROM comment_likes WHERE comment_id = $1 AND creator_id = $2", [parts[3], creator.id]);
    let liked;
    if (existing.rows[0]) {
      await pool.query("DELETE FROM comment_likes WHERE comment_id = $1 AND creator_id = $2", [parts[3], creator.id]);
      liked = false;
    } else {
      await pool.query("INSERT INTO comment_likes (comment_id, creator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [parts[3], creator.id]);
      liked = true;
    }
    const n = await pool.query("SELECT count(*) AS n FROM comment_likes WHERE comment_id = $1", [parts[3]]);
    await event(liked ? "comment_like" : "comment_unlike", { creatorId: creator.id, deviceId, detail: { comment: parts[3] } });
    return reply(200, { ok: true, liked, likes: Number(n.rows[0].n) });
  }

  if (parts[2] === "me") {
    if (req.method === "GET" && parts.length === 3) {
      const full = await creatorByHandle(creator.handle);
      const mine = (await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE w.creator_id = $1 AND w.status <> 'removed' ORDER BY w.updated_at DESC`, [creator.id])).rows;
      const removed = (await pool.query("SELECT id, title, removed_reason FROM workflows WHERE creator_id = $1 AND status = 'removed'", [creator.id])).rows;
      return reply(200, { ok: true, creator: { ...publicCreator(full), email: creator.email, handleChangedAt: creator.handle_changed_at, needsHandle: !creator.handle_claimed }, workflows: mine.map((r) => ({ ...publicWorkflow(r), hidden: Boolean(r.hidden_at) })), removed, submissionsOpen: (await setting("submissions_open", "true")) === "true" });
    }
    if (req.method === "PATCH" && parts[3] === "profile") {
      const body = await readBody();
      const errors = [];
      const displayName = text(body.displayName, LIMITS.displayName, "display_name", errors);
      const bio = text(body.bio, LIMITS.bio, "bio", errors, { required: false });
      const website = validUrl(body.websiteUrl, "website", errors);
      const avatar = validAvatar(body.avatarUrl, errors);
      const xUrl = validUrl(body.xUrl, "x", errors);
      const youtubeUrl = validUrl(body.youtubeUrl, "youtube", errors);
      const instagramUrl = validUrl(body.instagramUrl, "instagram", errors);
      const tiktokUrl = validUrl(body.tiktokUrl, "tiktok", errors);
      let handle = creator.handle;
      let handleChanged = false;
      if (typeof body.handle === "string" && body.handle.trim() && body.handle.trim().toLowerCase() !== creator.handle.toLowerCase()) {
        handle = body.handle.trim();
        handleChanged = true;
        if (!HANDLE_RE.test(handle)) errors.push("handle_invalid");
        else if (RESERVED_HANDLES.has(handle.toLowerCase())) errors.push("handle_reserved");
        if (creator.handle_changed_at && Date.now() - new Date(creator.handle_changed_at).getTime() < HANDLE_COOLDOWN_DAYS * 86400000) errors.push("handle_cooldown");
      }
      if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
      if (handleChanged) {
        const taken = await pool.query("SELECT 1 FROM creator_profiles WHERE lower(handle) = lower($1) AND id <> $2", [handle, creator.id]);
        if (taken.rows[0]) return reply(409, { ok: false, error: "handle_taken" });
      }
      await pool.query(
        `UPDATE creator_profiles SET display_name = $2, bio = $3, website_url = $4, avatar_url = $5, handle = $6, handle_changed_at = CASE WHEN $7 THEN now() ELSE handle_changed_at END, handle_claimed = CASE WHEN $7 THEN true ELSE handle_claimed END, x_url = $8, youtube_url = $9, instagram_url = $10, tiktok_url = $11, updated_at = now() WHERE id = $1`,
        [creator.id, displayName, bio, website, avatar === null && body.avatarUrl === "" ? null : avatar || creator.avatar_url, handle, handleChanged, xUrl, youtubeUrl, instagramUrl, tiktokUrl]
      );
      await event("profile_update", { creatorId: creator.id, detail: { handleChanged } });
      return reply(200, { ok: true, handle });
    }
    if (req.method === "POST" && parts[3] === "deactivate") {
      await pool.query("UPDATE creator_profiles SET status = 'deactivated', updated_at = now() WHERE id = $1", [creator.id]);
      await event("deactivate", { creatorId: creator.id });
      return reply(200, { ok: true }, { "Set-Cookie": clearCookie(req, CREATOR_COOKIE) });
    }
    if (req.method === "GET" && parts[3] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[4] || "")) {
      const row = await workflowById(parts[4]);
      if (!row || row.creator_id !== creator.id) return reply(404, { ok: false, error: "not_found" });
      const value = await fullWorkflowValue(row);
      return reply(200, { ok: true, workflow: { id: row.id, slug: row.slug, status: row.status, hidden: Boolean(row.hidden_at), publishedAt: row.published_at, updatedAt: row.updated_at, ...value } });
    }
    return reply(404, { ok: false, error: "not_found" });
  }

  if (parts[2] === "workflows") {
    if (req.method === "POST" && parts.length === 3) {
      const body = await readBody();
      const count = await pool.query("SELECT count(*) AS n FROM workflows WHERE creator_id = $1 AND status <> 'removed'", [creator.id]);
      if (Number(count.rows[0].n) >= PUBLISH_CAP.drafts) return reply(429, { ok: false, error: "too_many_workflows" });
      const publish = body.publish === true;
      const { value, errors } = parseWorkflow(body, { complete: publish });
      if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
      if (publish) {
        if ((await setting("submissions_open", "true")) !== "true") return reply(403, { ok: false, error: "submissions_closed" });
        if (!(await publishAllowed(creator))) return reply(429, { ok: false, error: "publish_limit" });
      }
      const created = await createWorkflow(creator, value, { status: publish ? "published" : "draft" });
      await event(publish ? "publish" : "draft_create", { creatorId: creator.id, workflowId: created.id });
      return reply(200, { ok: true, id: created.id, slug: created.slug, status: publish ? "published" : "draft" });
    }
    if (/^[0-9a-f-]{36}$/.test(parts[3] || "")) {
      const row = await workflowById(parts[3]);
      if (!row || row.creator_id !== creator.id) return reply(404, { ok: false, error: "not_found" });
      if (row.status === "removed") return reply(403, { ok: false, error: "removed" });
      if (req.method === "PATCH" && parts.length === 4) {
        const body = await readBody();
        const { value, errors } = parseWorkflow(body, { complete: row.status === "published" });
        if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
        const slug = await updateWorkflow(row, value, creator.id);
        await event("edit", { creatorId: creator.id, workflowId: row.id });
        return reply(200, { ok: true, slug });
      }
      if (req.method === "POST" && parts[4] === "publish") {
        if ((await setting("submissions_open", "true")) !== "true") return reply(403, { ok: false, error: "submissions_closed" });
        const { errors } = parseWorkflow(await fullWorkflowValue(row), { complete: true });
        if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
        if (row.status !== "published" && !(await publishAllowed(creator))) return reply(429, { ok: false, error: "publish_limit" });
        await pool.query("UPDATE workflows SET status = 'published', published_at = coalesce(published_at, now()), updated_at = now() WHERE id = $1", [row.id]);
        await event("publish", { creatorId: creator.id, workflowId: row.id });
        return reply(200, { ok: true, slug: row.slug });
      }
      if (req.method === "POST" && parts[4] === "unpublish") {
        await pool.query("UPDATE workflows SET status = 'unpublished', updated_at = now() WHERE id = $1 AND status = 'published'", [row.id]);
        await event("unpublish", { creatorId: creator.id, workflowId: row.id });
        return reply(200, { ok: true });
      }
    }
  }
  return reply(404, { ok: false, error: "not_found" });
}

module.exports = { init, handle, parseWorkflow, createWorkflow, uniqueSlug, slugify, creatorFromRequest };
