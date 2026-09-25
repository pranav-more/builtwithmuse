"use strict";

// builtwithmuse.com API, backed by Postgres on Supabase. Used by the Vercel
// serverless function in api/ and by the local dev server in server.js.
//
// Public endpoints
//   POST /api/session   issue the device cookie (the page calls it on load).
//   POST /api/claim     hand out an invite code. Each code goes to at most
//                       max_claims people (2). The owner's own codes are
//                       handed out first, until their slots run out. The pick and the counter update
//                       happen in one statement with FOR UPDATE SKIP LOCKED, so
//                       concurrent visitors never receive the same code past
//                       its limit. A device keeps the code it was given: a
//                       plain claim returns the same code again, and a new one
//                       is handed out only with { fresh: true }, which the page
//                       sends after the holder flags the code as not working.
//   POST /api/report    flag a code that did not work; two flags retire it.
//   POST /api/redeemed  a holder confirms the code worked (shows as Verified).
//   GET  /api/pool      masked public view of the pool for the home page.
//   POST /api/codes     add a code to the pool.
//   POST /api/waitlist  join the country waitlist.
//   GET  /api/stats     pool size and waitlist count.
//   GET  /api/healthz
//
// Scraper controls, in layers: a signed HttpOnly device cookie from /api/session
// is required for a claim; claims are counted per device and per hashed
// IP in the database (hour and day windows); obvious non-browser user agents
// are refused; the forms carry a honeypot field; codes are only revealed on a
// click, never in the HTML.
//
// Admin endpoints need "Authorization: Bearer <ADMIN_TOKEN>" or a moderator
// session from Google sign-in (POST /api/admin/login with a Google ID token
// for an email in ADMIN_EMAILS). The /admin page uses the latter.
//   GET    /api/admin/whoami            how the proxy presents the caller
//   GET    /api/admin/export.csv?table=codes|claims|waitlist|reports
//   POST   /api/admin/codes            { codes: ["ABC123", ...], source? }
//   POST   /api/admin/codes/retire     { code }
//   DELETE /api/admin/codes/:id
//   DELETE /api/admin/waitlist/:id

const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DEVICE_SECRET = process.env.DEVICE_SECRET || "";
const MAX_CLAIMS = Number(process.env.MAX_CLAIMS_PER_CODE || 2);
// How long a device keeps the code it was handed (one code per person). The
// page only asks for a fresh one after a "not working" flag.
const REUSE_WINDOW_MINUTES = Number(process.env.CLAIM_REUSE_MINUTES || 30 * 24 * 60);
const IP_SALT = process.env.IP_HASH_SALT || DEVICE_SECRET || "builtwithmuse";

// Only a local page on another port ever calls this API cross origin.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean);

const LIMITS = {
  claim: { device: { hour: 3, day: 6 }, ip: { hour: 8, day: 20 } },
  report: { device: { hour: 5, day: 10 }, ip: { hour: 10, day: 30 } },
  submit: { ip: { hour: 5, day: 20 } },
  waitlist: { ip: { hour: 5, day: 20 } },
  login: { ip: { hour: 10, day: 40 } },
};

// Prefer an explicitly provided external database over the platform one.
const DATABASE_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";
if (!DATABASE_URL) {
  console.error("SUPABASE_DB_URL or DATABASE_URL must be set");
  process.exit(1);
}
if (!DEVICE_SECRET) {
  console.error("DEVICE_SECRET is not set");
  process.exit(1);
}

// Supabase's pooler presents a certificate chain Node does not trust by
// default, and pg lets the URL's sslmode override an explicit ssl setting, so
// strip the parameter and decide here: TLS without chain verification for any
// remote host, plain TCP for localhost.
function makePool(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  return new Pool({
    connectionString: url.toString(),
    max: process.env.VERCEL ? 2 : 10,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
}
let pool = makePool(DATABASE_URL);
// Jayesh's own referral codes, confirmed by him. 70Z09F is his personal code
// (29 invites remaining in his Muse app as of 2026-09-23). These are seeded
// into the pool on boot with priority 1 and a claim budget of
// OWNER_MAX_CLAIMS, so his invites are exhausted before anyone else's codes
// are handed out. Append new codes he sends; he updates the budget number as
// his Muse invite balance changes.
const OWNER_CODES = ["70Z09F"];
// Total hand-out budget for the owner's code = codes already handed out (29) + his current remaining invites (26). Update this number whenever he reports a new remaining count; never set it below the already handed out count.

// Owner budget 52: 28 handed out + 24 remaining per Muse app on 2026-09-25
const OWNER_MAX_CLAIMS = 52;

  
  
  
  
  
  
  
  
const SCHEMA = `
CREATE TABLE IF NOT EXISTS codes (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  invite_link TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  claims INT NOT NULL DEFAULT 0,
  max_claims INT NOT NULL DEFAULT ${MAX_CLAIMS},
  reports INT NOT NULL DEFAULT 0,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS codes_code_upper_idx ON codes (upper(code));
CREATE INDEX IF NOT EXISTS codes_available_idx ON codes (created_at DESC) WHERE retired_at IS NULL;
CREATE TABLE IF NOT EXISTS claims (
  id SERIAL PRIMARY KEY,
  code_id INT NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claims_device_idx ON claims (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS claims_ip_idx ON claims (ip_hash, created_at DESC);
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  code_id INT NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_once_idx ON reports (code_id, device_id);
CREATE INDEX IF NOT EXISTS reports_device_idx ON reports (device_id, created_at DESC);
CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submissions_ip_idx ON submissions (kind, ip_hash, created_at DESC);
CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  country TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE codes ADD COLUMN IF NOT EXISTS country TEXT, ADD COLUMN IF NOT EXISTS region TEXT, ADD COLUMN IF NOT EXISTS city TEXT, ADD COLUMN IF NOT EXISTS redeemed INT NOT NULL DEFAULT 0;
-- Owner priority: Jayesh's own codes are claimed before anyone else's.
ALTER TABLE codes ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS redemptions (
  id SERIAL PRIMARY KEY,
  code_id INT NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS redemptions_once_idx ON redemptions (code_id, device_id);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS country TEXT, ADD COLUMN IF NOT EXISTS region TEXT, ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS country TEXT, ADD COLUMN IF NOT EXISTS region TEXT, ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS country_code TEXT, ADD COLUMN IF NOT EXISTS region TEXT, ADD COLUMN IF NOT EXISTS city TEXT;
`;

const CODE_RE = /^[A-Za-z0-9]{5,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BOT_UA = /\b(curl|wget|python|httpclient|okhttp|go-http-client|java\/|libwww|scrapy|bot|spider|crawler|headlesschrome|phantomjs|axios|node-fetch|undici)\b/i;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "pranavmore.psm@gmail.com,polostudio.brand@gmail.com,jayeshmarathe2000jm@gmail.com")
  .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ADMIN_COOKIE = "bwm_admin";
const ADMIN_SESSION_SECONDS = 7 * 24 * 60 * 60;
const DEVICE_COOKIE = "bwm_d";
const DEVICE_MAX_AGE = 60 * 60 * 24 * 365;

// Behind Vercel the client address arrives in headers Vercel sets itself
// (x-real-ip, and x-forwarded-for with the client as its last entry), so a
// caller cannot spoof them by sending its own values. Local dev has neither.
function clientIp(req) {
  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();
  const fwd = req.headers["x-forwarded-for"];
  const list = (Array.isArray(fwd) ? fwd.join(",") : fwd || "").split(",").map((v) => v.trim()).filter(Boolean);
  return list[list.length - 1] || req.socket.remoteAddress || "";
}
// Vercel adds the visitor's location to every request; nothing else is looked up.
function geo(req) {
  const pick = (name) => { const v = req.headers[name]; if (!v) return null; try { return decodeURIComponent(String(v)).slice(0, 80); } catch (_) { return String(v).slice(0, 80); } };
  return { country: pick("x-vercel-ip-country"), region: pick("x-vercel-ip-country-region"), city: pick("x-vercel-ip-city") };
}
function ipHash(req) {
  return crypto.createHash("sha256").update(IP_SALT + clientIp(req)).digest("hex").slice(0, 32);
}

function sign(id) {
  return crypto.createHmac("sha256", DEVICE_SECRET).update(id).digest("base64url").slice(0, 27);
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
// Returns the device id when the cookie is present and its signature checks out.
function deviceFromCookie(req) {
  const raw = parseCookies(req)[DEVICE_COOKIE] || "";
  const [id, sig] = raw.split(".");
  if (!id || !sig || !/^[a-f0-9]{32}$/.test(id)) return null;
  const expected = sign(id);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return id;
}
function isSecure(req) {
  return req.headers["x-forwarded-proto"] === "https" || Boolean(req.socket.encrypted);
}
function deviceCookieHeader(req) {
  const id = crypto.randomBytes(16).toString("hex");
  // The page and the API share an origin, so Lax is right; Secure over https.
  const secure = isSecure(req) ? "; Secure" : "";
  return `${DEVICE_COOKIE}=${id}.${sign(id)}; Path=/; Max-Age=${DEVICE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`;
}
function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  if (!ok) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function send(res, status, body, extra = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(payload);
}
function fail(res, status, error) {
  send(res, status, { ok: false, error });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8192) {
        reject(new Error("too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

// Google ID token verification against Google's published keys (RS256), with
// no extra dependency. The keys are cached per process for six hours.
let googleJwks = { keys: [], fetchedAt: 0 };
async function googleKeys(force) {
  if (!force && googleJwks.keys.length && Date.now() - googleJwks.fetchedAt < 6 * 3600_000) return googleJwks.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  const body = await res.json();
  googleJwks = { keys: body.keys || [], fetchedAt: Date.now() };
  return googleJwks.keys;
}
function fromB64url(text) {
  return Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
async function verifyGoogleIdToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("bad_token");
  const header = JSON.parse(fromB64url(parts[0]).toString("utf8"));
  const payload = JSON.parse(fromB64url(parts[1]).toString("utf8"));
  if (header.alg !== "RS256") throw new Error("bad_token");
  let key = (await googleKeys(false)).find((k) => k.kid === header.kid);
  if (!key) key = (await googleKeys(true)).find((k) => k.kid === header.kid);
  if (!key) throw new Error("bad_token");
  const publicKey = crypto.createPublicKey({ key, format: "jwk" });
  const valid = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), publicKey, fromB64url(parts[2]));
  if (!valid) throw new Error("bad_token");
  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_CLIENT_ID || payload.aud !== GOOGLE_CLIENT_ID) throw new Error("bad_audience");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) throw new Error("bad_issuer");
  if (!payload.exp || payload.exp < now - 60) throw new Error("expired");
  if (!payload.email || payload.email_verified !== true) throw new Error("unverified_email");
  return payload;
}

// Admin session: a signed cookie carrying the moderator's email and an expiry.
function adminKey() {
  return crypto.createHash("sha256").update("admin:" + DEVICE_SECRET).digest();
}
function adminCookieHeader(req, email) {
  const body = Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS })).toString("base64url");
  const sig = crypto.createHmac("sha256", adminKey()).update(body).digest("base64url");
  const secure = isSecure(req) ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${body}.${sig}; Path=/; Max-Age=${ADMIN_SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}
function adminCookieClear(req) {
  const secure = isSecure(req) ? "; Secure" : "";
  return `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}
function adminFromCookie(req) {
  const raw = parseCookies(req)[ADMIN_COOKIE] || "";
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", adminKey()).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data.email || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (!ADMIN_EMAILS.includes(String(data.email).toLowerCase())) return null;
    return data.email;
  } catch (_) {
    return null;
  }
}

// Admin access: the bearer token (scripts) or a moderator session cookie. A
// cookie session may change things only through fetch calls that send the
// custom header, which a cross-site form cannot.
function adminIdentity(req) {
  if (ADMIN_TOKEN) {
    const header = req.headers.authorization || "";
    const token = header.replace(/^Bearer\s+/i, "");
    if (token.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) return { method: "token", email: null };
  }
  const email = adminFromCookie(req);
  if (email) {
    if (req.method !== "GET" && req.headers["x-requested-with"] !== "fetch") return null;
    return { method: "google", email };
  }
  return null;
}
function isAdmin(req) {
  return Boolean(adminIdentity(req));
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Counts rows in the last hour and day for one column value, against the limits given.
async function overLimit(db, table, column, value, limit) {
  const r = await db.query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour,
            count(*) AS day
       FROM ${table}
      WHERE ${column} = $1 AND created_at > now() - interval '1 day'`,
    [value]
  );
  return Number(r.rows[0].hour) >= limit.hour || Number(r.rows[0].day) >= limit.day;
}
async function submissionLimitedByKind(kind, ip) {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour, count(*) AS day
       FROM submissions WHERE kind = $1 AND ip_hash = $2 AND created_at > now() - interval '1 day'`,
    [kind, ip]
  );
  if (Number(r.rows[0].hour) >= LIMITS[kind].ip.hour || Number(r.rows[0].day) >= LIMITS[kind].ip.day) return true;
  await pool.query("INSERT INTO submissions (kind, ip_hash) VALUES ($1, $2)", [kind, ip]);
  return false;
}

// Claim a code for a device. Returns { code, remaining } or null when the pool is empty.
async function claimCode(client, deviceId, ip, fresh, where) {
  await client.query("BEGIN");
  try {
    if (!fresh) {
      // The device's current code comes back instead of burning a new one, unless
      // it has been retired or this device flagged it.
      const recent = await client.query(
        `SELECT c.code, c.claims, c.max_claims, c.retired_at,
                EXISTS (SELECT 1 FROM redemptions rd WHERE rd.code_id = c.id AND rd.device_id = $1) AS redeemed
           FROM claims cl JOIN codes c ON c.id = cl.code_id
          WHERE cl.device_id = $1 AND cl.created_at > now() - make_interval(mins => $2)
            AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.code_id = c.id AND r.device_id = $1)
          ORDER BY cl.created_at DESC LIMIT 1`,
        [deviceId, REUSE_WINDOW_MINUTES]
      );
      const row = recent.rows[0];
      if (row && !row.retired_at) {
        await client.query("COMMIT");
        return { code: row.code, remaining: Math.max(0, row.max_claims - row.claims), reused: true, redeemed: Boolean(row.redeemed) };
      }
    }
    const picked = await client.query(
      `WITH picked AS (
         SELECT id FROM codes
          WHERE retired_at IS NULL AND claims < max_claims
            AND id NOT IN (SELECT code_id FROM claims WHERE device_id = $1)
          ORDER BY priority DESC, created_at DESC, id DESC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE codes c SET claims = c.claims + 1
         FROM picked WHERE c.id = picked.id
       RETURNING c.id, c.code, c.claims, c.max_claims`,
      [deviceId]
    );
    const row = picked.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    await client.query("INSERT INTO claims (code_id, device_id, ip_hash, country, region, city) VALUES ($1, $2, $3, $4, $5, $6)", [row.id, deviceId, ip, where.country, where.region, where.city]);
    await client.query("COMMIT");
    return { code: row.code, remaining: row.max_claims - row.claims, reused: false, redeemed: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function handleApi(req, res, url) {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  const reply = (status, body, extra = {}) => send(res, status, body, { ...cors, ...extra });
  const ip = ipHash(req);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const ua = req.headers["user-agent"] || "";

  // The page (served elsewhere) calls this once on load to pick up its device cookie.
  if (req.method === "POST" && url.pathname === "/api/session") {
    if (!ua || BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    if (deviceFromCookie(req)) return reply(200, { ok: true, fresh: false });
    return reply(200, { ok: true, fresh: true }, { "Set-Cookie": deviceCookieHeader(req) });
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    const r = await pool.query(
      `SELECT
         (SELECT count(*) FROM codes WHERE retired_at IS NULL AND claims < max_claims) AS available,
         (SELECT count(*) FROM codes) AS submitted,
         (SELECT count(*) FROM waitlist) AS waitlist`
    );
    const row = r.rows[0];
    return reply(200, { ok: true, available: Number(row.available), submitted: Number(row.submitted), waitlist: Number(row.waitlist) });
  }

  // Public view of the pool: masked codes and seat counts only, never a code.
  if (req.method === "GET" && url.pathname === "/api/pool") {
    const r = await pool.query(
      `SELECT left(code, 1) AS first, least(length(code) - 1, 5) AS dots, claims, max_claims, reports, redeemed,
              (retired_at IS NOT NULL) AS pulled, created_at
         FROM codes
        ORDER BY (retired_at IS NULL AND claims < max_claims) DESC, priority DESC, (retired_at IS NULL) DESC, created_at DESC
        LIMIT 12`
    );
    const totals = (await pool.query(
      `SELECT count(*) FILTER (WHERE retired_at IS NULL AND claims < max_claims) AS codes,
              coalesce(sum(max_claims - claims) FILTER (WHERE retired_at IS NULL AND claims < max_claims), 0) AS open,
              count(*) FILTER (WHERE retired_at IS NULL AND claims >= max_claims) AS used,
              count(*) FILTER (WHERE retired_at IS NOT NULL) AS broken,
              count(*) FILTER (WHERE redeemed > 0) AS verified
         FROM codes`
    )).rows[0];
    return reply(200, {
      ok: true,
      openSlots: Number(totals.open),
      openCodes: Number(totals.codes),
      usedCodes: Number(totals.used),
      brokenCodes: Number(totals.broken),
      verifiedCodes: Number(totals.verified),
      rows: r.rows.map((row) => ({
        label: row.first.toUpperCase() + "\u2022".repeat(Math.max(1, Number(row.dots))),
        seats: row.max_claims, used: row.claims, verified: row.redeemed > 0,
        state: row.pulled ? "pulled" : row.claims >= row.max_claims ? "full" : "open",
      })),
    }, { "Cache-Control": "public, max-age=20" });
  }

  if (req.method === "POST" && url.pathname === "/api/redeemed") {
    const deviceId = deviceFromCookie(req);
    if (!deviceId) return reply(403, { ok: false, error: "no_device" });
    const body = await readJson(req);
    const code = String(body.code || "").trim();
    if (!CODE_RE.test(code)) return reply(400, { ok: false, error: "bad_request" });
    // Only a device that was handed this code may confirm it worked.
    const found = await pool.query(
      `SELECT c.id FROM codes c WHERE upper(c.code) = upper($1)
          AND EXISTS (SELECT 1 FROM claims cl WHERE cl.code_id = c.id AND cl.device_id = $2)`,
      [code, deviceId]
    );
    if (!found.rows[0]) return reply(404, { ok: false, error: "unknown_code" });
    const inserted = await pool.query("INSERT INTO redemptions (code_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id", [found.rows[0].id, deviceId]);
    if (inserted.rows[0]) await pool.query("UPDATE codes SET redeemed = redeemed + 1 WHERE id = $1", [found.rows[0].id]);
    return reply(200, { ok: true });
  }

  if (req.method === "POST" && (url.pathname === "/api/claim" || url.pathname === "/api/report")) {
    if (!ua || BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    const deviceId = deviceFromCookie(req);
    if (!deviceId) return reply(403, { ok: false, error: "no_device" });
    const body = await readJson(req);

    if (url.pathname === "/api/claim") {
      if (await overLimit(pool, "claims", "device_id", deviceId, LIMITS.claim.device)) return reply(429, { ok: false, error: "rate_limited" });
      if (await overLimit(pool, "claims", "ip_hash", ip, LIMITS.claim.ip)) return reply(429, { ok: false, error: "rate_limited" });
      const client = await pool.connect();
      try {
        const result = await claimCode(client, deviceId, ip, Boolean(body.fresh), geo(req));
        if (!result) return reply(404, { ok: false, error: "no_codes" });
        return reply(200, { ok: true, ...result });
      } finally {
        client.release();
      }
    }

    const code = String(body.code || "").trim();
    if (!CODE_RE.test(code)) return reply(400, { ok: false, error: "bad_request" });
    if (await overLimit(pool, "reports", "device_id", deviceId, LIMITS.report.device)) return reply(429, { ok: false, error: "rate_limited" });
    if (await overLimit(pool, "reports", "ip_hash", ip, LIMITS.report.ip)) return reply(429, { ok: false, error: "rate_limited" });
    // Only a device that was handed this code may report it.
    const found = await pool.query(
      `SELECT c.id FROM codes c
        WHERE upper(c.code) = upper($1)
          AND EXISTS (SELECT 1 FROM claims cl WHERE cl.code_id = c.id AND cl.device_id = $2)`,
      [code, deviceId]
    );
    if (!found.rows[0]) return reply(404, { ok: false, error: "unknown_code" });
    const codeId = found.rows[0].id;
    const where = geo(req);
    const inserted = await pool.query(
      "INSERT INTO reports (code_id, device_id, ip_hash, country, region, city) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id",
      [codeId, deviceId, ip, where.country, where.region, where.city]
    );
    if (inserted.rows[0]) {
      await pool.query(
        `UPDATE codes SET reports = reports + 1,
                retired_at = CASE WHEN reports + 1 >= 2 AND source <> 'owner' THEN now() ELSE retired_at END
          WHERE id = $1`,
        [codeId]
      );
    }
    return reply(200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/codes") {
    const body = await readJson(req);
    if (body.website) return reply(200, { ok: true, added: false }); // honeypot
    const code = String(body.code || "").trim();
    const link = String(body.inviteLink || "").trim();
    if (!CODE_RE.test(code)) return reply(400, { ok: false, error: "bad_code" });
    if (link && (!/^https?:\/\//i.test(link) || link.length > 500)) return reply(400, { ok: false, error: "bad_link" });
    if (await submissionLimitedByKind("submit", ip)) return reply(429, { ok: false, error: "rate_limited" });
    const where = geo(req);
    const r = await pool.query(
      `INSERT INTO codes (code, invite_link, source, country, region, city) VALUES ($1, $2, 'user', $3, $4, $5)
       ON CONFLICT (upper(code)) DO NOTHING RETURNING id`,
      [code.toUpperCase(), link || null, where.country, where.region, where.city]
    );
    return reply(200, { ok: true, added: Boolean(r.rows[0]) });
  }

  if (req.method === "POST" && url.pathname === "/api/waitlist") {
    const body = await readJson(req);
    if (body.website) return reply(200, { ok: true }); // honeypot
    const email = String(body.email || "").trim();
    const country = String(body.country || "").trim();
    if (!EMAIL_RE.test(email) || email.length > 254) return reply(400, { ok: false, error: "bad_email" });
    if (!country || country.length > 100) return reply(400, { ok: false, error: "bad_country" });
    if (await submissionLimitedByKind("waitlist", ip)) return reply(429, { ok: false, error: "rate_limited" });
    const where = geo(req);
    await pool.query(
      `INSERT INTO waitlist (email, country, country_code, region, city) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lower(email)) DO UPDATE SET country = EXCLUDED.country, country_code = EXCLUDED.country_code, region = EXCLUDED.region, city = EXCLUDED.city`,
      [email, country, where.country, where.region, where.city]
    );
    return reply(200, { ok: true });
  }

  if (parts[1] === "admin") {
    // Public: the sign-in page needs the Google client id before anyone is signed in.
    if (req.method === "GET" && parts[2] === "config") return reply(200, { ok: true, clientId: GOOGLE_CLIENT_ID });

    if (req.method === "POST" && parts[2] === "login") {
      if (await submissionLimitedByKind("login", ip)) return reply(429, { ok: false, error: "rate_limited" });
      const body = await readJson(req);
      let payload;
      try {
        payload = await verifyGoogleIdToken(body.credential);
      } catch (err) {
        const known = ["bad_token", "bad_audience", "bad_issuer", "expired", "unverified_email"];
        return reply(401, { ok: false, error: known.includes(err.message) ? err.message : "bad_token" });
      }
      const email = String(payload.email).toLowerCase();
      if (!ADMIN_EMAILS.includes(email)) return reply(403, { ok: false, error: "not_a_moderator" });
      return reply(200, { ok: true, email }, { "Set-Cookie": adminCookieHeader(req, email) });
    }

    if (req.method === "POST" && parts[2] === "logout") return reply(200, { ok: true }, { "Set-Cookie": adminCookieClear(req) });

    const who = adminIdentity(req);
    if (!who) return reply(401, { ok: false, error: "unauthorized" });

    if (req.method === "GET" && parts[2] === "me") return reply(200, { ok: true, ...who });

    if (req.method === "GET" && parts[2] === "overview") {
      const r = await pool.query(
        `SELECT
           (SELECT count(*) FROM codes WHERE retired_at IS NULL AND claims < max_claims) AS available,
           (SELECT count(*) FROM codes WHERE retired_at IS NULL AND claims >= max_claims) AS used_up,
           (SELECT count(*) FROM codes WHERE retired_at IS NOT NULL) AS retired,
           (SELECT count(*) FROM codes) AS total_codes,
           (SELECT count(*) FROM codes WHERE created_at > now() - interval '1 day') AS codes_24h,
           (SELECT count(*) FROM claims WHERE created_at > now() - interval '1 hour') AS claims_1h,
           (SELECT count(*) FROM claims WHERE created_at > now() - interval '1 day') AS claims_24h,
           (SELECT count(*) FROM claims) AS claims_total,
           (SELECT count(*) FROM reports WHERE created_at > now() - interval '1 day') AS reports_24h,
           (SELECT count(*) FROM reports) AS reports_total,
           (SELECT count(*) FROM waitlist) AS waitlist,
           (SELECT count(*) FROM waitlist WHERE created_at > now() - interval '1 day') AS waitlist_24h,
           (SELECT count(DISTINCT device_id) FROM claims WHERE created_at > now() - interval '1 day') AS devices_24h`
      );
      const activity = await pool.query(
        `SELECT * FROM (
           SELECT 'claim' AS kind, cl.created_at, c.code, left(cl.device_id, 8) AS who, NULL::text AS detail, cl.country FROM claims cl JOIN codes c ON c.id = cl.code_id
           UNION ALL
           SELECT 'report', r.created_at, c.code, left(r.device_id, 8), NULL, r.country FROM reports r JOIN codes c ON c.id = r.code_id
           UNION ALL
           SELECT 'code', c.created_at, c.code, c.source, c.invite_link, c.country FROM codes c
           UNION ALL
           SELECT 'waitlist', w.created_at, NULL, w.country, w.email, w.country_code FROM waitlist w
         ) t ORDER BY created_at DESC LIMIT 40`
      );
      const counts = Object.fromEntries(Object.entries(r.rows[0]).map(([k, v]) => [k, Number(v)]));
      return reply(200, { ok: true, ...counts, activity: activity.rows });
    }

    if (req.method === "GET" && parts[2] === "analytics") {
      const days = Math.min(Math.max(Number(url.searchParams.get("days") || 14), 7), 90);
      const daily = await pool.query(
        `WITH d AS (SELECT generate_series((now() at time zone 'utc')::date - ($1::int - 1), (now() at time zone 'utc')::date, '1 day')::date AS day)
         SELECT d.day,
           (SELECT count(*) FROM claims WHERE (created_at at time zone 'utc')::date = d.day) AS claims,
           (SELECT count(DISTINCT device_id) FROM claims WHERE (created_at at time zone 'utc')::date = d.day) AS devices,
           (SELECT count(*) FROM codes WHERE (created_at at time zone 'utc')::date = d.day AND source = 'user') AS submissions,
           (SELECT count(*) FROM reports WHERE (created_at at time zone 'utc')::date = d.day) AS reports,
           (SELECT count(*) FROM waitlist WHERE (created_at at time zone 'utc')::date = d.day) AS waitlist
         FROM d ORDER BY d.day`,
        [days]
      );
      const hourly = await pool.query(
        `WITH h AS (SELECT generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), '1 hour') AS hour)
         SELECT h.hour, (SELECT count(*) FROM claims WHERE date_trunc('hour', created_at) = h.hour) AS claims FROM h ORDER BY h.hour`
      );
      const top = async (sql) => (await pool.query(sql)).rows;
      const countries = {
        claims: await top(`SELECT coalesce(country, 'Unknown') AS country, count(*) AS n FROM claims GROUP BY 1 ORDER BY n DESC LIMIT 10`),
        submissions: await top(`SELECT coalesce(country, 'Unknown') AS country, count(*) AS n FROM codes WHERE source = 'user' GROUP BY 1 ORDER BY n DESC LIMIT 10`),
        waitlist: await top(`SELECT coalesce(country_code, 'Unknown') AS country, count(*) AS n FROM waitlist GROUP BY 1 ORDER BY n DESC LIMIT 10`),
        waitlist_choice: await top(`SELECT country, count(*) AS n FROM waitlist GROUP BY 1 ORDER BY n DESC LIMIT 10`),
      };
      const pool_ = (await pool.query(
        `SELECT
           (SELECT count(*) FROM codes WHERE retired_at IS NULL AND claims < max_claims) AS available,
           (SELECT count(*) FROM codes WHERE retired_at IS NULL AND claims >= max_claims) AS used_up,
           (SELECT count(*) FROM codes WHERE retired_at IS NOT NULL) AS retired,
           (SELECT coalesce(sum(max_claims - claims), 0) FROM codes WHERE retired_at IS NULL AND claims < max_claims) AS seats_left,
           (SELECT count(*) FROM codes WHERE source = 'user') AS user_submitted,
           (SELECT count(*) FROM codes WHERE source <> 'user') AS added_by_us,
           (SELECT count(DISTINCT device_id) FROM claims) AS devices_total,
           (SELECT count(*) FROM claims) AS claims_total,
           (SELECT count(*) FROM reports) AS reports_total`
      )).rows[0];
      const num = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v])));
      return reply(200, { ok: true, days, daily: num(daily.rows), hourly: num(hourly.rows), countries: Object.fromEntries(Object.entries(countries).map(([k, v]) => [k, num(v)])), pool: Object.fromEntries(Object.entries(pool_).map(([k, v]) => [k, Number(v)])) });
    }

    if (req.method === "GET" && parts[2] === "codes" && parts.length === 3) {
      const status = url.searchParams.get("status") || "all";
      const q = (url.searchParams.get("q") || "").trim().toUpperCase();
      const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
      const where = [];
      const params = [];
      if (status === "available") where.push("c.retired_at IS NULL AND c.claims < c.max_claims");
      if (status === "used") where.push("c.retired_at IS NULL AND c.claims >= c.max_claims");
      if (status === "retired") where.push("c.retired_at IS NOT NULL");
      if (q) { params.push("%" + q + "%"); where.push(`upper(c.code) LIKE $${params.length}`); }
      params.push(limit);
      const r = await pool.query(
        `SELECT c.id, c.code, c.invite_link, c.source, c.claims, c.max_claims, c.reports, c.redeemed, c.retired_at, c.created_at, c.country, c.region, c.city,
                (SELECT max(created_at) FROM claims cl WHERE cl.code_id = c.id) AS last_claim_at
           FROM codes c ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY c.created_at DESC, c.id DESC LIMIT $${params.length}`,
        params
      );
      return reply(200, { ok: true, codes: r.rows });
    }

    if (req.method === "POST" && parts[2] === "codes" && parts[3] === "restore") {
      const body = await readJson(req);
      const code = String(body.code || "").trim();
      if (!CODE_RE.test(code)) return reply(400, { ok: false, error: "bad_code" });
      const r = await pool.query("UPDATE codes SET retired_at = NULL, reports = 0 WHERE upper(code) = upper($1) RETURNING id", [code]);
      if (r.rows[0]) await pool.query("DELETE FROM reports WHERE code_id = $1", [r.rows[0].id]);
      return reply(200, { ok: true, restored: Boolean(r.rows[0]) });
    }

    if (req.method === "GET" && (parts[2] === "claims" || parts[2] === "reports") && parts.length === 3) {
      const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
      const table = parts[2];
      const r = await pool.query(
        `SELECT t.id, t.created_at, c.code, c.retired_at, left(t.device_id, 8) AS device, left(t.ip_hash, 8) AS ip, t.country, t.region, t.city
           FROM ${table} t JOIN codes c ON c.id = t.code_id
          ORDER BY t.created_at DESC LIMIT $1`,
        [limit]
      );
      return reply(200, { ok: true, rows: r.rows });
    }

    if (req.method === "GET" && parts[2] === "waitlist" && parts.length === 3) {
      const limit = Math.min(Number(url.searchParams.get("limit") || 500), 2000);
      const r = await pool.query("SELECT id, email, country, country_code, region, city, created_at FROM waitlist ORDER BY created_at DESC LIMIT $1", [limit]);
      return reply(200, { ok: true, rows: r.rows });
    }

    if (req.method === "GET" && parts[2] === "whoami") {
      return reply(200, { ok: true, ip: clientIp(req), forwarded: req.headers["x-forwarded-for"] || null, realIp: req.headers["x-real-ip"] || null, proto: req.headers["x-forwarded-proto"] || null, ua: ua, ...geo(req) });
    }

    if (req.method === "GET" && parts[2] === "export.csv") {
      const table = url.searchParams.get("table") || "waitlist";
      if (!["codes", "claims", "waitlist", "reports"].includes(table)) return reply(400, { ok: false, error: "bad_table" });
      const r = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
      const columns = r.fields.map((f) => f.name);
      const lines = [columns.join(",")].concat(r.rows.map((row) => columns.map((c) => csvEscape(row[c])).join(",")));
      return send(res, 200, lines.join("\n") + "\n", { ...cors, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${table}.csv"` });
    }

    if (req.method === "POST" && parts[2] === "codes" && parts.length === 3) {
      const body = await readJson(req);
      const codes = Array.isArray(body.codes) ? body.codes.map((c) => String(c).trim().toUpperCase()) : [];
      if (!codes.length || codes.some((c) => !CODE_RE.test(c))) return reply(400, { ok: false, error: "bad_codes" });
      const source = /^[a-z_]{1,20}$/.test(body.source || "") ? body.source : "admin";
      const priority = source === "owner" ? 1 : 0;
      let added = 0;
      for (const code of codes) {
        const r = await pool.query(
          "INSERT INTO codes (code, source, priority) VALUES ($1, $2, $3) ON CONFLICT (upper(code)) DO NOTHING RETURNING id",
          [code, source, priority]
        );
        if (r.rows[0]) added += 1;
      }
      return reply(200, { ok: true, added, received: codes.length });
    }

    if (req.method === "POST" && parts[2] === "codes" && parts[3] === "retire") {
      const body = await readJson(req);
      const code = String(body.code || "").trim();
      if (!CODE_RE.test(code)) return reply(400, { ok: false, error: "bad_code" });
      const r = await pool.query("UPDATE codes SET retired_at = coalesce(retired_at, now()) WHERE upper(code) = upper($1) RETURNING id", [code]);
      return reply(200, { ok: true, retired: Boolean(r.rows[0]) });
    }

    if (req.method === "DELETE" && (parts[2] === "codes" || parts[2] === "waitlist") && /^\d+$/.test(parts[3] || "")) {
      const r = await pool.query(`DELETE FROM ${parts[2]} WHERE id = $1 RETURNING id`, [Number(parts[3])]);
      return reply(200, { ok: true, deleted: Boolean(r.rows[0]) });
    }
  }

  return reply(404, { ok: false, error: "not_found" });
}

// The database can take a moment to become reachable after a fresh boot, so
// keep trying for a while before giving up.
async function initSchema(attempts = 30) {
  const host = new URL(DATABASE_URL).hostname;
  
  for (let i = 1; i <= attempts; i++) {
    try {
      
      await pool.query(SCHEMA);
      // Seed the owner's codes on boot so his referrals are claimed before anyone else's.
      await pool.query("INSERT INTO codes (code, source, priority, max_claims) SELECT upper(c), 'owner', 1, $2 FROM unnest($1::text[]) AS t(c) ON CONFLICT (upper(code)) DO UPDATE SET source='owner', priority=1, max_claims=$2", [OWNER_CODES, OWNER_MAX_CLAIMS]);
      
      
      console.log(`database ready via ${host}`);
      return;
    } catch (err) {
      console.error(`schema init attempt ${i} (${host}) failed: ${err.code || ""} ${err.message}`);
      if (i === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(700 * i, 4000)));
    }
  }
}

// Serverless instances share one lazily initialised schema check per process.
let ready = null;
function ensureReady() {
  if (!ready) ready = initSchema(process.env.VERCEL ? 3 : 30).catch((err) => { ready = null; throw err; });
  return ready;
}

// Entry point shared by the Vercel function and the local server.
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  // On Vercel every /api/* request is rewritten to this function with the
  // original path carried in a query parameter (see vercel.json).
  const carried = url.searchParams.get("__path");
  if (carried !== null) {
    url.pathname = "/api/" + carried.replace(/^\/+/, "");
    url.searchParams.delete("__path");
  }
  if (url.pathname === "/api/healthz" || url.pathname === "/api/health") return send(res, 200, { ok: true });
  try {
    await ensureReady();
    await handleApi(req, res, url);
  } catch (err) {
    const status = err.message === "bad_json" || err.message === "too_large" ? 400 : 500;
    if (status === 500) console.error("api error", err);
    fail(res, status, status === 500 ? "server_error" : err.message);
  }
}

module.exports = { handle, ensureReady };
