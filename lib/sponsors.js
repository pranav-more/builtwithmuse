"use strict";

// Paid homepage sponsor slots. Four slots: hand-placed sponsors (FIXED) keep
// their positions, every other slot is sold through Dodo Payments and fills
// itself when the payment webhook arrives, then empties when the paid days
// run out. Nothing a buyer sends decides what is fulfilled: the pending row
// we store at checkout holds the name, link, product and length.

const crypto = require("crypto");
const track = require("./track");

const SLOT_COUNT = 4;
const FIXED = [];
const PRODUCTS = {
  sponsor_7d: { productId: "pdt_0Npeo5EHurpDU5OlXrplz", days: 7, cents: 5000, label: "1 week" },
  sponsor_30d: { productId: "pdt_0Npeo5F7HMUpHMKUAOHvz", days: 30, cents: 15000, label: "1 month" },
};
const DODO_API = process.env.DODO_API_BASE || "https://live.dodopayments.com";
const SITE = process.env.SITE_URL || "https://builtwithmuse.com";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sponsorships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  logo TEXT,
  email TEXT NOT NULL,
  sku TEXT NOT NULL,
  days INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'ended', 'unverified')),
  checkout_session_id TEXT UNIQUE,
  payment_id TEXT UNIQUE,
  amount_cents INT,
  currency TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  ended_reason TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorships_live_idx ON sponsorships (status, starts_at, ends_at);
CREATE TABLE IF NOT EXISTS dodo_events (
  id TEXT PRIMARY KEY,
  type TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sponsor_clicks ADD COLUMN IF NOT EXISTS sponsorship_id UUID;
CREATE TABLE IF NOT EXISTS sponsor_daily (
  day DATE NOT NULL,
  key TEXT NOT NULL,
  impressions INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
ALTER TABLE sponsor_clicks ADD COLUMN IF NOT EXISTS country TEXT, ADD COLUMN IF NOT EXISTS device TEXT, ADD COLUMN IF NOT EXISTS page TEXT, ADD COLUMN IF NOT EXISTS referrer TEXT;
CREATE INDEX IF NOT EXISTS sponsor_clicks_sponsorship_idx ON sponsor_clicks (sponsorship_id);
ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
-- The sponsor funnel before checkout: visits to /sponsor (page_view) and
-- clicks on a sponsor call to action (cta). People only, crawlers skipped.
CREATE TABLE IF NOT EXISTS sponsor_events (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  cta TEXT,
  page TEXT,
  ref TEXT,
  utm_source TEXT,
  visitor TEXT,
  country TEXT,
  device TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsor_events_type_idx ON sponsor_events (type, created_at DESC);
CREATE TABLE IF NOT EXISTS sponsor_seen (
  ip_hash TEXT NOT NULL,
  day DATE NOT NULL,
  PRIMARY KEY (ip_hash, day)
);
`;

const paidCapacity = SLOT_COUNT - FIXED.length;

// The four slots as they are right now.
async function currentSlots(pool) {
  const paid = await pool.query(
    `SELECT id, name, url, logo, ends_at FROM sponsorships
     WHERE status = 'paid' AND starts_at <= now() AND ends_at > now()
     ORDER BY starts_at, created_at LIMIT $1`,
    [paidCapacity]
  );
  const taken = new Set(FIXED.map((f) => f.slot));
  const free = [];
  for (let s = 1; s <= SLOT_COUNT; s++) if (!taken.has(s)) free.push(s);
  const slots = [];
  for (let s = 1; s <= SLOT_COUNT; s++) {
    const fixed = FIXED.find((f) => f.slot === s);
    if (fixed) { slots.push({ slot: s, name: fixed.name, url: fixed.url, logo: fixed.logo, sponsorshipId: null }); continue; }
    const p = paid.rows[free.indexOf(s)];
    slots.push(p ? { slot: s, name: p.name, url: p.url, logo: p.logo, sponsorshipId: p.id, endsAt: p.ends_at } : { slot: s, name: null, url: null, logo: null, sponsorshipId: null });
  }
  return slots;
}

// When a new paid slot can start: now if a slot is free, else when the
// earliest booked one ends (queued buyers line up behind each other).
async function nextStart(pool) {
  const r = await pool.query("SELECT ends_at FROM sponsorships WHERE status = 'paid' AND ends_at > now() ORDER BY ends_at");
  if (r.rows.length < paidCapacity) return new Date();
  return new Date(r.rows[r.rows.length - paidCapacity].ends_at);
}

// Public view of the slots. Click and impression numbers are private to each
// sponsor (their stats link) and to admins; they are never shown here.
async function list(pool) {
  const slots = await currentSlots(pool);
  const open = slots.filter((s) => !s.name).length;
  const next = open ? null : await nextStart(pool);
  // What the slots delivered in the last 30 days, shown on /sponsor next to the audience numbers.
  const proof = await pool.query(
    `SELECT (SELECT coalesce(sum(impressions), 0)::int FROM sponsor_daily WHERE day > current_date - 30) AS impressions,
            (SELECT count(*)::int FROM sponsor_clicks WHERE created_at > now() - interval '30 days') AS clicks`
  ).then((r) => r.rows[0]).catch(() => null);
  // Every paid sponsorship, newest first: the public sponsor history on /sponsor.
  const history = await pool.query(
    `SELECT name, url, logo, sku, starts_at, ends_at,
            CASE WHEN ends_at <= now() OR status = 'ended' THEN 'ended'
                 WHEN starts_at > now() THEN 'upcoming' ELSE 'live' END AS state
       FROM sponsorships
      WHERE status IN ('paid', 'ended') AND starts_at IS NOT NULL
      ORDER BY starts_at DESC, created_at DESC LIMIT 40`
  ).then((r) => r.rows.map((h) => ({
    name: h.name, url: h.url, logo: h.logo, state: h.state,
    plan: PRODUCTS[h.sku] ? PRODUCTS[h.sku].label : null,
    startsAt: h.starts_at, endsAt: h.ends_at,
  }))).catch(() => []);
  return {
    proof,
    history,
    slots: slots.map((s) => ({ slot: s.slot, name: s.name, url: s.url, logo: s.logo })),
    open,
    nextOpening: next,
    products: Object.entries(PRODUCTS).map(([sku, p]) => ({ sku, label: p.label, price: p.cents / 100 })),
  };
}

const slotKey = (s) => (s.sponsorshipId ? String(s.sponsorshipId) : `fixed-${s.slot}`);

// One impression per visitor per day for every filled slot, recorded when
// the sponsor box scrolls into view on the homepage.
async function seen(pool, ipHash) {
  const first = await pool.query(
    "INSERT INTO sponsor_seen (ip_hash, day) VALUES ($1, current_date) ON CONFLICT DO NOTHING RETURNING ip_hash",
    [ipHash]
  );
  if (!first.rows.length) return false;
  const filled = (await currentSlots(pool)).filter((s) => s.name);
  for (const s of filled) {
    await pool.query(
      "INSERT INTO sponsor_daily (day, key, impressions) VALUES (current_date, $1, 1) ON CONFLICT (day, key) DO UPDATE SET impressions = sponsor_daily.impressions + 1",
      [slotKey(s)]
    );
  }
  await pool.query("DELETE FROM sponsor_seen WHERE day < current_date - 2");
  return true;
}

// Private stats link for a buyer: an HMAC of the sponsorship id.
function statsToken(id) {
  const secret = process.env.SPONSOR_STATS_SECRET || process.env.DEVICE_SECRET || process.env.ADMIN_TOKEN || "";
  return crypto.createHmac("sha256", `sponsor-stats:${secret}`).update(String(id)).digest("hex").slice(0, 32);
}
function statsUrl(id) {
  return `${SITE}/sponsor-stats?s=${id}&t=${statsToken(id)}`;
}
function validToken(id, token) {
  const a = Buffer.from(statsToken(id));
  const b = Buffer.from(String(token || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function stats(pool, id, token) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || "")) || !validToken(id, token)) return null;
  const r = await pool.query("SELECT id, name, url, logo, email, sku, days, status, starts_at, ends_at, created_at FROM sponsorships WHERE id = $1", [id]);
  const sp = r.rows[0];
  if (!sp) return null;
  const live = (await currentSlots(pool)).find((s) => s.sponsorshipId === sp.id);
  const [imp, clk, countries, devices] = await Promise.all([
    pool.query("SELECT day, impressions FROM sponsor_daily WHERE key = $1 ORDER BY day", [sp.id]),
    pool.query("SELECT created_at::date AS day, count(*)::int AS n FROM sponsor_clicks WHERE sponsorship_id = $1 GROUP BY 1 ORDER BY 1", [sp.id]),
    breakdown(pool, "country", "sponsorship_id = $1", [sp.id]),
    breakdown(pool, "device", "sponsorship_id = $1", [sp.id]),
  ]);
  const byDay = new Map();
  for (const row of imp.rows) byDay.set(row.day.toISOString().slice(0, 10), { impressions: row.impressions, clicks: 0 });
  for (const row of clk.rows) {
    const k = row.day.toISOString().slice(0, 10);
    byDay.set(k, { impressions: (byDay.get(k) || {}).impressions || 0, clicks: row.n });
  }
  const daily = [...byDay.entries()].sort().map(([day, v]) => ({ day, ...v }));
  const impressions = daily.reduce((t, d) => t + d.impressions, 0);
  const clicks = daily.reduce((t, d) => t + d.clicks, 0);
  const now = Date.now();
  const state = sp.status === "pending" ? "processing"
    : sp.status === "paid" && live ? "live"
    : sp.status === "paid" && sp.starts_at && new Date(sp.starts_at).getTime() > now ? "queued"
    : sp.status === "paid" ? "ended" : sp.status;
  return {
    name: sp.name, url: sp.url, logo: sp.logo, email: sp.email,
    plan: PRODUCTS[sp.sku] ? PRODUCTS[sp.sku].label : `${sp.days} days`,
    state, slot: live ? live.slot : null,
    startsAt: sp.starts_at, endsAt: sp.ends_at,
    impressions, clicks, ctr: impressions ? Math.round((clicks / impressions) * 1000) / 10 : 0,
    daily,
    countries,
    devices,
  };
}

// Top values of one click column (country or device) for the clicks matching
// `where`. Clicks from before these columns existed count as "Unknown".
async function breakdown(pool, column, where, params) {
  if (column !== "country" && column !== "device") {
    throw new Error("bad_column");
  }
  const r = await pool.query(
    `SELECT coalesce(${column}, 'Unknown') AS key, count(*)::int AS n FROM sponsor_clicks WHERE ${where} GROUP BY 1 ORDER BY n DESC, key LIMIT 6`,
    params
  );
  return r.rows;
}

// The sponsor edits their own slot from the private stats link: name, link,
// logo and receipt email. Allowed until the slot ends; the homepage picks the
// change up on its next refresh.
async function update(pool, id, token, body) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || "")) || !validToken(id, token)) return { status: 404, body: { ok: false, error: "This link is not valid." } };
  const r = await pool.query("SELECT status, ends_at FROM sponsorships WHERE id = $1", [id]);
  const sp = r.rows[0];
  if (!sp) return { status: 404, body: { ok: false, error: "This link is not valid." } };
  if (sp.status === "ended" || (sp.ends_at && new Date(sp.ends_at).getTime() < Date.now())) {
    return { status: 409, body: { ok: false, error: "This slot has ended. Book a new one to run again." } };
  }
  const details = parseDetails(body);
  if (details.error) return { status: 400, body: { ok: false, error: details.error } };
  await pool.query("UPDATE sponsorships SET name = $2, url = $3, logo = $4, email = $5 WHERE id = $1", [id, details.name, details.url, details.logo, details.email]);
  return { status: 200, body: { ok: true } };
}

// One outbound click on a filled slot, with where it came from: country (from
// Vercel's header), device (from the user agent) and the page it was on.
async function click(pool, slot, ipHash, info) {
  const slots = await currentSlots(pool);
  const s = slots.find((x) => x.slot === slot);
  if (!s || !s.name) {
    return false;
  }
  const i = info || {};
  await pool.query(
    "INSERT INTO sponsor_clicks (slot, ip_hash, sponsorship_id, country, device, page, referrer) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [slot, ipHash, s.sponsorshipId, i.country || null, i.device || null, i.page || null, i.referrer || null]
  );
  return true;
}

const EVENT_TYPES = ["page_view", "cta"];

// A visit to /sponsor or a click on a sponsor call to action. Rate limited per
// visitor; returns false when the event was not stored.
async function event(pool, input) {
  if (!EVENT_TYPES.includes(input.type)) {
    return false;
  }
  const recent = await pool.query("SELECT count(*)::int AS n FROM sponsor_events WHERE visitor = $1 AND created_at > now() - interval '1 hour'", [input.visitor]);
  if (recent.rows[0].n >= 120) {
    return false;
  }
  await pool.query(
    "INSERT INTO sponsor_events (type, cta, page, ref, utm_source, visitor, country, device) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [input.type, input.cta || null, input.page || null, input.ref || null, input.utm_source || null, input.visitor, input.country || null, input.device || null]
  );
  return true;
}

const planLabel = (sku, days) => (PRODUCTS[sku] ? PRODUCTS[sku].label : `${days} days`);

// Everything the admin Sponsors tab shows. Checkouts started are rows in
// sponsorships (one per checkout, pending until paid); paid ones carry a
// payment id. Views and calls to action come from sponsor_events.
async function report(pool, days) {
  const d = days === 7 ? 7 : 30;
  const since = `now() - interval '${d} days'`;
  const [funnel, daily, ctas, refs, leads, runs] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT count(*)::int FROM sponsor_events WHERE type = 'page_view' AND created_at > ${since}) AS views,
         (SELECT count(DISTINCT visitor)::int FROM sponsor_events WHERE type = 'page_view' AND created_at > ${since}) AS view_visitors,
         (SELECT count(*)::int FROM sponsor_events WHERE type = 'cta' AND cta = 'checkout_submit' AND created_at > ${since}) AS checkout_clicks,
         (SELECT count(DISTINCT visitor)::int FROM sponsor_events WHERE type = 'cta' AND cta = 'checkout_submit' AND created_at > ${since}) AS checkout_click_visitors,
         (SELECT count(*)::int FROM sponsor_events WHERE type = 'cta' AND cta <> 'checkout_submit' AND created_at > ${since}) AS entry_clicks,
         (SELECT count(*)::int FROM sponsorships WHERE created_at > ${since}) AS checkouts,
         (SELECT count(*)::int FROM sponsorships WHERE payment_id IS NOT NULL AND status IN ('paid', 'ended') AND coalesce(paid_at, created_at) > ${since}) AS paid,
         (SELECT coalesce(sum(amount_cents), 0)::int FROM sponsorships WHERE payment_id IS NOT NULL AND status IN ('paid', 'ended') AND coalesce(ended_reason, '') NOT IN ('refund', 'dispute') AND coalesce(paid_at, created_at) > ${since}) AS revenue_cents,
         (SELECT coalesce(sum(impressions), 0)::int FROM sponsor_daily WHERE day > current_date - ${d}) AS impressions,
         (SELECT count(*)::int FROM sponsor_clicks WHERE created_at > ${since}) AS sponsor_clicks`
    ),
    pool.query(
      `WITH days AS (SELECT generate_series(current_date - ${d - 1}, current_date, interval '1 day')::date AS day)
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
         (SELECT count(*)::int FROM sponsor_events e WHERE e.type = 'page_view' AND e.created_at::date = days.day) AS views,
         (SELECT count(*)::int FROM sponsor_events e WHERE e.type = 'cta' AND e.cta = 'checkout_submit' AND e.created_at::date = days.day) AS ctas,
         (SELECT count(*)::int FROM sponsorships s WHERE s.created_at::date = days.day) AS checkouts,
         (SELECT count(*)::int FROM sponsorships s WHERE s.payment_id IS NOT NULL AND s.status IN ('paid', 'ended') AND coalesce(s.paid_at, s.created_at)::date = days.day) AS paid,
         (SELECT count(*)::int FROM sponsor_clicks c WHERE c.created_at::date = days.day) AS clicks,
         (SELECT coalesce(sum(impressions), 0)::int FROM sponsor_daily i WHERE i.day = days.day) AS impressions
       FROM days ORDER BY days.day`
    ),
    pool.query(`SELECT coalesce(cta, 'other') AS key, count(*)::int AS n FROM sponsor_events WHERE type = 'cta' AND created_at > ${since} GROUP BY 1 ORDER BY n DESC`),
    pool.query(`SELECT coalesce(utm_source, ref, 'direct or on site') AS key, count(*)::int AS n FROM sponsor_events WHERE type = 'page_view' AND created_at > ${since} GROUP BY 1 ORDER BY n DESC LIMIT 8`),
    pool.query(
      `SELECT lower(p.email) AS email,
              (array_agg(p.name ORDER BY p.created_at DESC))[1] AS name,
              (array_agg(p.url ORDER BY p.created_at DESC))[1] AS url,
              array_agg(DISTINCT p.sku) AS skus,
              count(*)::int AS attempts,
              min(p.created_at) AS first_at,
              max(p.created_at) AS last_at,
              EXISTS (SELECT 1 FROM sponsorships q WHERE lower(q.email) = lower(min(p.email)) AND q.payment_id IS NOT NULL AND q.status IN ('paid', 'ended')) AS paid_later
         FROM sponsorships p
        WHERE p.status = 'pending'
        GROUP BY lower(p.email)
        ORDER BY max(p.created_at) DESC
        LIMIT 500`
    ),
    pool.query(
      `SELECT s.id, s.name, s.url, s.email, s.sku, s.days, s.status, s.starts_at, s.ends_at, s.amount_cents, s.currency, s.ended_reason,
              (SELECT coalesce(sum(impressions), 0)::int FROM sponsor_daily x WHERE x.key = s.id::text) AS impressions,
              (SELECT count(*)::int FROM sponsor_clicks c WHERE c.sponsorship_id = s.id) AS clicks
         FROM sponsorships s
        WHERE s.payment_id IS NOT NULL AND s.status IN ('paid', 'ended')
        ORDER BY s.starts_at DESC NULLS LAST
        LIMIT 100`
    ),
  ]);

  const now = Date.now();
  const sponsors = [];
  for (const r of runs.rows) {
    const [byDay, countries, devices] = await Promise.all([
      pool.query("SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM sponsor_clicks WHERE sponsorship_id = $1 GROUP BY 1 ORDER BY 1", [r.id]),
      breakdown(pool, "country", "sponsorship_id = $1", [r.id]),
      breakdown(pool, "device", "sponsorship_id = $1", [r.id]),
    ]);
    const ended = r.status === "ended" || (r.ends_at && new Date(r.ends_at).getTime() <= now);
    const queued = !ended && r.starts_at && new Date(r.starts_at).getTime() > now;
    sponsors.push({
      id: r.id, name: r.name, url: r.url, plan: planLabel(r.sku, r.days),
      state: ended ? "ended" : queued ? "queued" : "live",
      startsAt: r.starts_at, endsAt: r.ends_at,
      impressions: r.impressions, clicks: r.clicks,
      ctr: r.impressions ? Math.round((r.clicks / r.impressions) * 1000) / 10 : 0,
      revenueCents: r.ended_reason === "refund" || r.ended_reason === "dispute" ? 0 : r.amount_cents || 0,
      currency: r.currency || "USD",
      clicksByDay: byDay.rows, countries, devices,
      statsUrl: statsUrl(r.id),
    });
  }
  // The hand-placed slot (staywith.pet in #1 until October 2026), counted under its own key.
  const fixedImp = await pool.query("SELECT coalesce(sum(impressions), 0)::int AS n FROM sponsor_daily WHERE key LIKE 'fixed-%'");
  const fixedClk = await pool.query("SELECT count(*)::int AS n, min(created_at) AS first_at, max(created_at) AS last_at FROM sponsor_clicks WHERE sponsorship_id IS NULL");
  if (fixedImp.rows[0].n || fixedClk.rows[0].n) {
    const [byDay, countries, devices] = await Promise.all([
      pool.query("SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM sponsor_clicks WHERE sponsorship_id IS NULL GROUP BY 1 ORDER BY 1"),
      breakdown(pool, "country", "sponsorship_id IS NULL", []),
      breakdown(pool, "device", "sponsorship_id IS NULL", []),
    ]);
    const imp = fixedImp.rows[0].n;
    const clk = fixedClk.rows[0].n;
    sponsors.push({
      id: "fixed", name: FIXED.length ? FIXED.map((f) => f.name).join(", ") : "Hand placed slot (staywith.pet)", url: null, plan: "Hand placed",
      state: FIXED.length ? "live" : "ended",
      startsAt: fixedClk.rows[0].first_at, endsAt: fixedClk.rows[0].last_at,
      impressions: imp, clicks: clk, ctr: imp ? Math.round((clk / imp) * 1000) / 10 : 0,
      revenueCents: 0, currency: "USD", clicksByDay: byDay.rows, countries, devices, statsUrl: null,
    });
  }

  return {
    days: d,
    funnel: funnel.rows[0],
    daily: daily.rows,
    ctas: ctas.rows,
    refs: refs.rows,
    leads: leads.rows.map((l) => ({
      email: l.email, name: l.name, url: l.url,
      products: l.skus.map((k) => planLabel(k, null)),
      attempts: l.attempts, firstAt: l.first_at, lastAt: l.last_at, paidLater: l.paid_later,
    })),
    sponsors,
  };
}

function cleanUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (/^(localhost|127\.|10\.|192\.168\.|0\.)/.test(u.hostname)) return null;
    return u.toString().slice(0, 500);
  } catch (_) {
    return null;
  }
}

// Starts a Dodo checkout. Returns { status, body } for the router.
// Name, link, logo and email from a form, cleaned the same way for a new
// checkout and for a sponsor editing their own slot. Returns { error } or the values.
function parseDetails(body) {
  const name = String((body && body.name) || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const url = cleanUrl(body && body.url);
  // A logo is either a link or an upload the browser has already squared and
  // shrunk to 128 px (a small PNG, JPEG or WebP data URL), as creator photos are.
  const rawLogo = body && typeof body.logo === "string" ? body.logo.trim() : "";
  const logo = !rawLogo
    ? null
    : /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(rawLogo) && rawLogo.length <= 200000
      ? rawLogo
      : cleanUrl(rawLogo);
  const email = String((body && body.email) || "").trim().toLowerCase().slice(0, 200);
  if (name.length < 2) return { error: "Add your product's name." };
  if (!url) return { error: "Add a link that starts with https://" };
  if (rawLogo && !logo) return { error: rawLogo.startsWith("data:") ? "That logo file is too big or not a PNG, JPEG or WebP." : "The logo link doesn't look right." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: "We need an email for the receipt." };
  return { name, url, logo, email };
}

async function checkout(pool, body, ipHash) {
  const product = PRODUCTS[body && body.sku];
  if (!product) return { status: 400, body: { ok: false, error: "Pick a week or a month." } };
  const details = parseDetails(body);
  if (details.error) return { status: 400, body: { ok: false, error: details.error } };
  const { name, url, logo, email } = details;
  if (!process.env.DODO_API_KEY) return { status: 503, body: { ok: false, error: "Checkout is unavailable right now." } };

  const recent = await pool.query("SELECT count(*)::int AS n FROM sponsorships WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'", [ipHash]);
  if (recent.rows[0].n >= 6) return { status: 429, body: { ok: false, error: "Too many tries. Please wait a bit." } };

  const row = await pool.query(
    "INSERT INTO sponsorships (name, url, logo, email, sku, days, ip_hash) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [name, url, logo, email, body.sku, product.days, ipHash]
  );
  const id = row.rows[0].id;
  const res = await fetch(`${DODO_API}/checkouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DODO_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      product_cart: [{ product_id: product.productId, quantity: 1 }],
      customer: { email, name },
      metadata: { sponsorship_id: id, sku: body.sku },
      return_url: `${statsUrl(id)}&paid=1`,
      cancel_url: `${SITE}/sponsor`,
      customization: { theme: "light", show_order_details: true },
      feature_flags: { allow_discount_code: true, allow_currency_selection: true },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.checkout_url) {
    console.error("[sponsors] checkout failed", res.status, JSON.stringify(data).slice(0, 300));
    await pool.query("DELETE FROM sponsorships WHERE id = $1 AND status = 'pending'", [id]);
    return { status: 502, body: { ok: false, error: "Checkout could not be started. Please try again." } };
  }
  await pool.query("UPDATE sponsorships SET checkout_session_id = $2 WHERE id = $1", [id, data.session_id || null]);
  return { status: 200, body: { ok: true, checkout_url: data.checkout_url } };
}

// Standard Webhooks signature, as Dodo signs: v1,<base64 HMAC-SHA256 of
// "id.timestamp.body"> with the base64 secret after "whsec_".
function verifySignature(headers, raw) {
  const key = process.env.DODO_WEBHOOK_KEY || "";
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sigs = String(headers["webhook-signature"] || "");
  if (!key || !id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const secret = Buffer.from(key.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", secret).update(`${id}.${ts}.${raw}`).digest();
  return sigs.split(" ").some((part) => {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

async function webhook(pool, headers, raw) {
  if (!verifySignature(headers, raw)) return { status: 401, body: { ok: false } };
  let event;
  try { event = JSON.parse(raw); } catch (_) { return { status: 400, body: { ok: false } }; }
  const first = await pool.query("INSERT INTO dodo_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id", [String(headers["webhook-id"]), event.type || null]);
  if (!first.rows.length) return { status: 200, body: { ok: true, duplicate: true } };
  const data = event.data || {};

  if (event.type === "payment.succeeded") {
    const meta = data.metadata || {};
    const found = await pool.query(
      "SELECT * FROM sponsorships WHERE (checkout_session_id IS NOT NULL AND checkout_session_id = $1) OR id::text = $2 LIMIT 1",
      [data.checkout_session_id || "", String(meta.sponsorship_id || "")]
    );
    const s = found.rows[0];
    if (!s) return { status: 200, body: { ok: true, ignored: true } };
    if (s.status !== "pending") return { status: 200, body: { ok: true } };
    const product = PRODUCTS[s.sku];
    const paid = Array.isArray(data.product_cart) ? data.product_cart.map((p) => p.product_id) : [];
    if (!product || (paid.length && !paid.includes(product.productId))) {
      console.error("[sponsors] paid product does not match", s.id, paid);
      await pool.query("UPDATE sponsorships SET status = 'unverified', payment_id = $2 WHERE id = $1", [s.id, data.payment_id || null]);
      return { status: 200, body: { ok: true } };
    }
    const start = await nextStart(pool);
    const end = new Date(start.getTime() + s.days * 86400000);
    await pool.query(
      "UPDATE sponsorships SET status = 'paid', payment_id = $2, amount_cents = $3, currency = $4, starts_at = $5, ends_at = $6, paid_at = now() WHERE id = $1 AND status = 'pending'",
      [s.id, data.payment_id || null, data.total_amount || null, data.currency || null, start, end]
    );
    return { status: 200, body: { ok: true } };
  }

  if (event.type === "refund.succeeded" || event.type === "dispute.opened") {
    await pool.query(
      "UPDATE sponsorships SET status = 'ended', ended_reason = $2, ends_at = LEAST(coalesce(ends_at, now()), now()) WHERE payment_id = $1",
      [data.payment_id || "", event.type === "refund.succeeded" ? "refund" : "dispute"]
    );
    return { status: 200, body: { ok: true } };
  }
  return { status: 200, body: { ok: true, ignored: true } };
}

async function adminList(pool) {
  const r = await pool.query(
    `SELECT s.id, s.name, s.url, s.email, s.sku, s.days, s.status, s.starts_at, s.ends_at, s.amount_cents, s.currency, s.created_at, s.ended_reason,
            (SELECT count(*)::int FROM sponsor_clicks c WHERE c.sponsorship_id = s.id) AS clicks,
            (SELECT coalesce(sum(impressions), 0)::int FROM sponsor_daily d WHERE d.key = s.id::text) AS impressions
     FROM sponsorships s WHERE s.status <> 'pending' OR s.created_at > now() - interval '2 days'
     ORDER BY s.created_at DESC LIMIT 200`
  );
  return r.rows.map((row) => ({ ...row, stats_url: statsUrl(row.id) }));
}

async function adminEnd(pool, id) {
  const r = await pool.query("UPDATE sponsorships SET status = 'ended', ended_reason = 'admin', ends_at = LEAST(coalesce(ends_at, now()), now()) WHERE id = $1 AND status = 'paid' RETURNING id", [id]);
  return r.rows.length > 0;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 262144) { reject(new Error("too_large")); req.destroy(); }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

module.exports = { SCHEMA, SLOT_COUNT, FIXED, PRODUCTS, list, click, event, report, seen, stats, statsUrl, checkout, update, webhook, adminList, adminEnd, readRaw, verifySignature, currentSlots };
