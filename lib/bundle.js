"use strict";

// TODO(muse-bundle): temporary, remove later. This whole file. Removing the bundle: delete it,
// test/bundle.test.js, and every line marked TODO(muse-bundle) (grep for it);
// unset BUNDLE_API_KEY. Ended bundle rows can stay in sponsorships as history.
//
// The Mac Apps Library bundle (since 2026-11-03). Mac Apps Library sells one
// $50 order: its own fast-tracked listing plus a week in one of our homepage
// sponsor slots. When the listing is approved it books the card here, through
// these endpoints, with a shared key (BUNDLE_API_KEY on both sides). This only
// runs in that direction for now: a sponsor bought on /sponsor never creates
// a Mac Apps Library listing.
//
// A bundle card is an ordinary paid row in sponsorships (source 'mal_bundle'),
// so it shows, counts, expires and frees its slot like any other sponsor. At
// most BUNDLE_MAX_CONCURRENT (default 2) of the 4 slots hold bundle cards at
// once, so regular sponsors are never crowded out. Nothing here touches the
// code pool or claim order.

const crypto = require("crypto");
const sponsors = require("./sponsors");

const SOURCE = "mal_bundle";
// A card runs one of these lengths; the sku records which.
const ALLOWED_DAYS = [7, 30];
const skuFor = (days) => `mal_bundle_${days}d`;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const CARD_DAYS = num(process.env.BUNDLE_CARD_DAYS, 7);
const PARTNER_CAP = num(process.env.BUNDLE_MAX_CONCURRENT, 2);
// Mac Apps Library only offers the bundle while a card can start within this many days.
const MAX_WAIT_DAYS = num(process.env.BUNDLE_MAX_WAIT_DAYS, 7);
const CLOSING_STATUSES = { order_refunded: "refund", order_disputed: "dispute", order_cancelled: "partner_cancelled" };

function authorised(req) {
  const key = process.env.BUNDLE_API_KEY || "";
  // A short or missing key would be guessable, so it switches the endpoints off.
  if (key.length < 32) return false;
  const given = String(req.headers["x-api-key"] || "");
  return Boolean(key) && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
}

const validOrderId = (v) => typeof v === "string" && /^[A-Za-z0-9_:-]{6,100}$/.test(v);

function cardState(row) {
  const now = Date.now();
  if (row.status !== "paid" || new Date(row.ends_at).getTime() <= now) return "ended";
  return new Date(row.starts_at).getTime() > now ? "queued" : "live";
}

function cardBody(row) {
  return {
    ok: true,
    bundle_order_id: row.bundle_order_id,
    sponsor_card_id: row.id,
    status: cardState(row),
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    stats_url: sponsors.statsUrl(row.id),
  };
}

// When a bundle card booked now would start.
async function availability(pool, daysParam) {
  const days = daysParam === undefined || daysParam === null || daysParam === "" ? CARD_DAYS : Number(daysParam);
  if (!ALLOWED_DAYS.includes(days)) return { status: 400, body: { ok: false, error: "bad_days" } };
  const start = await sponsors.earliestStart(pool, days, { partner: true, partnerCap: PARTNER_CAP });
  return {
    status: 200,
    body: {
      ok: true,
      starts_at: start,
      days,
      max_wait_days: MAX_WAIT_DAYS,
      available: start.getTime() - Date.now() <= MAX_WAIT_DAYS * 86400000,
    },
  };
}

// Books the card. The listing is already approved and paid for by the time
// this is called, so it never refuses for lack of room: a full calendar
// queues the card at the next opening instead of stranding the buyer.
async function provision(pool, body) {
  const b = body || {};
  if (!validOrderId(b.bundle_order_id)) return { status: 400, body: { ok: false, error: "bad_bundle_order_id" } };
  const key = String(b.idempotency_key || "");
  if (key !== `${b.bundle_order_id}:mal_to_bwm`) return { status: 400, body: { ok: false, error: "bad_idempotency_key" } };
  const details = sponsors.parseDetails({ name: b.product_name, url: b.url, logo: b.logo_url, email: b.contact_email });
  if (details.error) return { status: 400, body: { ok: false, error: details.error } };
  const days = b.days === undefined ? CARD_DAYS : Number(b.days);
  if (!ALLOWED_DAYS.includes(days)) return { status: 400, body: { ok: false, error: "bad_days" } };

  const existing = await pool.query("SELECT * FROM sponsorships WHERE idempotency_key = $1", [key]);
  if (existing.rows[0]) return { status: 200, body: { ...cardBody(existing.rows[0]), duplicate: true } };

  const recent = await pool.query(`SELECT count(*)::int AS n FROM sponsorships WHERE source = '${SOURCE}' AND created_at > now() - interval '1 hour'`);
  if (recent.rows[0].n >= 20) return { status: 429, body: { ok: false, error: "rate_limited" } };

  const row = await sponsors.withSlotLock(pool, async (db) => {
    const again = await db.query("SELECT * FROM sponsorships WHERE idempotency_key = $1", [key]);
    if (again.rows[0]) return again.rows[0];
    const cancelled = await db.query("SELECT 1 FROM bundle_cancellations WHERE bundle_order_id = $1", [b.bundle_order_id]);
    if (cancelled.rows.length) return null;
    const start = await sponsors.earliestStart(db, days, { partner: true, partnerCap: PARTNER_CAP });
    const end = new Date(start.getTime() + days * 86400000);
    const r = await db.query(
      `INSERT INTO sponsorships (name, url, logo, email, sku, days, status, source, bundle_order_id, idempotency_key, starts_at, ends_at, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7, $8, $9, $10, $11, now()) RETURNING *`,
      [details.name, details.url, details.logo, details.email, skuFor(days), days, SOURCE, b.bundle_order_id, key, start, end]
    );
    return r.rows[0];
  });
  if (!row) return { status: 409, body: { ok: false, bundle_order_id: b.bundle_order_id, status: "cancelled", error: "order_cancelled" } };
  return { status: 201, body: cardBody(row) };
}

// Mac Apps Library reporting on its side of an order. A refund, dispute or
// cancellation ends the card at once (or drops it from the queue) and frees
// the slot; an ended card never comes back.
async function status(pool, body) {
  const b = body || {};
  if (!validOrderId(b.bundle_order_id)) return { status: 400, body: { ok: false, error: "bad_bundle_order_id" } };
  if (b.status === "check") {
    const found = await pool.query("SELECT * FROM sponsorships WHERE bundle_order_id = $1 AND source = $2", [b.bundle_order_id, SOURCE]);
    return found.rows[0] ? { status: 200, body: cardBody(found.rows[0]) } : { status: 404, body: { ok: false, error: "no_card" } };
  }
  const reason = CLOSING_STATUSES[b.status];
  if (!reason) return { status: 400, body: { ok: false, error: "bad_status" } };
  // Under the slot lock, so a booking in flight either lands first (and is
  // ended here) or runs after and finds the tombstone.
  const row = await sponsors.withSlotLock(pool, async (db) => {
    await db.query("INSERT INTO bundle_cancellations (bundle_order_id, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING", [b.bundle_order_id, reason]);
    const ended = await db.query(
      "UPDATE sponsorships SET status = 'ended', ended_reason = $2, ends_at = LEAST(ends_at, now()) WHERE bundle_order_id = $1 AND source = $3 AND status = 'paid' RETURNING *",
      [b.bundle_order_id, reason, SOURCE]
    );
    if (ended.rows[0]) return ended.rows[0];
    const found = await db.query("SELECT * FROM sponsorships WHERE bundle_order_id = $1 AND source = $2", [b.bundle_order_id, SOURCE]);
    return found.rows[0] || null;
  });
  // Nothing was booked (the listing was never approved): nothing to end.
  if (!row) return { status: 200, body: { ok: true, bundle_order_id: b.bundle_order_id, status: "none" } };
  return { status: 200, body: cardBody(row) };
}

module.exports = { authorised, availability, provision, status, SOURCE, ALLOWED_DAYS, CARD_DAYS, PARTNER_CAP, MAX_WAIT_DAYS };
