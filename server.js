"use strict";

// builtwithmuse.com: serves the static page and a small API backed by Postgres.
//
// Public endpoints
//   POST /api/claim     hand out an invite code. Each code goes to at most
//                       max_claims people (2). The pick and the counter update
//                       happen in one statement with FOR UPDATE SKIP LOCKED, so
//                       concurrent visitors never receive the same code past
//                       its limit.
//   POST /api/report    flag a code that did not work; two flags retire it.
//   POST /api/codes     add a code to the pool.
//   POST /api/waitlist  join the country waitlist.
//   GET  /api/stats     pool size and waitlist count.
//   GET  /healthz
//
// Scraper controls, in layers: a signed HttpOnly device cookie issued with the
// page is required for a claim; claims are counted per device and per hashed
// IP in the database (hour and day windows); obvious non-browser user agents
// are refused; the forms carry a honeypot field; codes are only revealed on a
// click, never in the HTML.
//
// Admin endpoints need "Authorization: Bearer <ADMIN_TOKEN>".
//   GET    /api/admin/whoami            how the proxy presents the caller
//   GET    /api/admin/export.csv?table=codes|claims|waitlist|reports
//   POST   /api/admin/codes            { codes: ["ABC123", ...], source? }
//   POST   /api/admin/codes/retire     { code }
//   DELETE /api/admin/codes/:id
//   DELETE /api/admin/waitlist/:id

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DEVICE_SECRET = process.env.DEVICE_SECRET || "";
const MAX_CLAIMS = Number(process.env.MAX_CLAIMS_PER_CODE || 2);
const REUSE_WINDOW_MINUTES = Number(process.env.CLAIM_REUSE_MINUTES || 15);
const IP_SALT = process.env.IP_HASH_SALT || DEVICE_SECRET || "builtwithmuse";
const ROOT = __dirname;

const LIMITS = {
  claim: { device: { hour: 3, day: 6 }, ip: { hour: 8, day: 20 } },
  report: { device: { hour: 5, day: 10 }, ip: { hour: 10, day: 30 } },
  submit: { ip: { hour: 5, day: 20 } },
  waitlist: { ip: { hour: 5, day: 20 } },
};

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
if (!DEVICE_SECRET) {
  console.error("DEVICE_SECRET is not set");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: /sslmode=require/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

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
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_idx ON waitlist (lower(email));
`;

const CODE_RE = /^[A-Za-z0-9]{5,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BOT_UA = /\b(curl|wget|python|httpclient|okhttp|go-http-client|java\/|libwww|scrapy|bot|spider|crawler|headlesschrome|phantomjs|axios|node-fetch|undici)\b/i;
const DEVICE_COOKIE = "bwm_d";
const DEVICE_MAX_AGE = 60 * 60 * 24 * 365;

// Behind the platform proxy the client address arrives in a header. The
// rightmost X-Forwarded-For entry is the one the proxy itself appended, so a
// client cannot spoof it by sending its own header. X-Real-IP wins when set.
function clientIp(req) {
  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();
  const fwd = req.headers["x-forwarded-for"];
  const list = (Array.isArray(fwd) ? fwd.join(",") : fwd || "").split(",").map((v) => v.trim()).filter(Boolean);
  return list[list.length - 1] || req.socket.remoteAddress || "";
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
function deviceCookieHeader(req) {
  const id = crypto.randomBytes(16).toString("hex");
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
  return `${DEVICE_COOKIE}=${id}.${sign(id)}; Path=/; Max-Age=${DEVICE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`;
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

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const header = req.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (token.length !== ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
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
async function claimCode(client, deviceId, ip, fresh) {
  await client.query("BEGIN");
  try {
    if (!fresh) {
      // A refresh inside the window returns the same code instead of burning a new one.
      const recent = await client.query(
        `SELECT c.code, c.claims, c.max_claims, c.retired_at
           FROM claims cl JOIN codes c ON c.id = cl.code_id
          WHERE cl.device_id = $1 AND cl.created_at > now() - make_interval(mins => $2)
            AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.code_id = c.id AND r.device_id = $1)
          ORDER BY cl.created_at DESC LIMIT 1`,
        [deviceId, REUSE_WINDOW_MINUTES]
      );
      const row = recent.rows[0];
      if (row && !row.retired_at) {
        await client.query("COMMIT");
        return { code: row.code, remaining: Math.max(0, row.max_claims - row.claims), reused: true };
      }
    }
    const picked = await client.query(
      `WITH picked AS (
         SELECT id FROM codes
          WHERE retired_at IS NULL AND claims < max_claims
            AND id NOT IN (SELECT code_id FROM claims WHERE device_id = $1)
          ORDER BY created_at DESC, id DESC
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
    await client.query("INSERT INTO claims (code_id, device_id, ip_hash) VALUES ($1, $2, $3)", [row.id, deviceId, ip]);
    await client.query("COMMIT");
    return { code: row.code, remaining: row.max_claims - row.claims, reused: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function handleApi(req, res, url) {
  const reply = (status, body) => send(res, status, body);
  const ip = ipHash(req);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const ua = req.headers["user-agent"] || "";

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
        const result = await claimCode(client, deviceId, ip, Boolean(body.fresh));
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
    const inserted = await pool.query(
      "INSERT INTO reports (code_id, device_id, ip_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id",
      [codeId, deviceId, ip]
    );
    if (inserted.rows[0]) {
      await pool.query(
        `UPDATE codes SET reports = reports + 1,
                retired_at = CASE WHEN reports + 1 >= 2 THEN now() ELSE retired_at END
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
    const r = await pool.query(
      `INSERT INTO codes (code, invite_link, source) VALUES ($1, $2, 'user')
       ON CONFLICT (upper(code)) DO NOTHING RETURNING id`,
      [code.toUpperCase(), link || null]
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
    await pool.query(
      `INSERT INTO waitlist (email, country) VALUES ($1, $2)
       ON CONFLICT (lower(email)) DO UPDATE SET country = EXCLUDED.country`,
      [email, country]
    );
    return reply(200, { ok: true });
  }

  if (parts[1] === "admin") {
    if (!isAdmin(req)) return reply(401, { ok: false, error: "unauthorized" });

    if (req.method === "GET" && parts[2] === "whoami") {
      return reply(200, { ok: true, ip: clientIp(req), forwarded: req.headers["x-forwarded-for"] || null, realIp: req.headers["x-real-ip"] || null, proto: req.headers["x-forwarded-proto"] || null, ua: ua });
    }

    if (req.method === "GET" && parts[2] === "export.csv") {
      const table = url.searchParams.get("table") || "waitlist";
      if (!["codes", "claims", "waitlist", "reports"].includes(table)) return reply(400, { ok: false, error: "bad_table" });
      const r = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
      const columns = r.fields.map((f) => f.name);
      const lines = [columns.join(",")].concat(r.rows.map((row) => columns.map((c) => csvEscape(row[c])).join(",")));
      return send(res, 200, lines.join("\n") + "\n", { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${table}.csv"` });
    }

    if (req.method === "POST" && parts[2] === "codes" && parts.length === 3) {
      const body = await readJson(req);
      const codes = Array.isArray(body.codes) ? body.codes.map((c) => String(c).trim().toUpperCase()) : [];
      if (!codes.length || codes.some((c) => !CODE_RE.test(c))) return reply(400, { ok: false, error: "bad_codes" });
      const source = /^[a-z_]{1,20}$/.test(body.source || "") ? body.source : "admin";
      let added = 0;
      for (const code of codes) {
        const r = await pool.query(
          "INSERT INTO codes (code, source) VALUES ($1, $2) ON CONFLICT (upper(code)) DO NOTHING RETURNING id",
          [code, source]
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

const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

function serveStatic(req, res, url) {
  let file = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  if (file.includes("..") || /\.(js|json|md)$/.test(file) || file.startsWith("/.")) return send(res, 404, "Not found");
  const full = path.join(ROOT, file);
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");
    const isPage = full.endsWith("index.html");
    const headers = {
      "Content-Type": STATIC_TYPES[path.extname(full)] || "application/octet-stream",
      "Cache-Control": isPage ? "public, max-age=0, must-revalidate" : "public, max-age=3600",
      "Content-Length": stat.size,
    };
    // The page load is where a browser picks up its device cookie.
    if (isPage && !deviceFromCookie(req)) headers["Set-Cookie"] = deviceCookieHeader(req);
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") return send(res, 200, { ok: true });
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => {
      const status = err.message === "bad_json" || err.message === "too_large" ? 400 : 500;
      if (status === 500) console.error("api error", err);
      fail(res, status, status === 500 ? "server_error" : err.message);
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  serveStatic(req, res, url);
});

pool
  .query(SCHEMA)
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => console.log(`builtwithmuse listening on ${PORT}`));
  })
  .catch((err) => {
    console.error("schema init failed", err);
    process.exit(1);
  });

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
