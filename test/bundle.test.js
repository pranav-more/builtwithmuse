"use strict";

// TODO(muse-bundle): temporary, remove later. This whole file.

// Needs a scratch Postgres: BUNDLE_TEST_DATABASE_URL=postgres://localhost/bwm_bundle_test npm test
// Skipped without it.

const test = require("node:test");
const assert = require("node:assert");

const DB = process.env.BUNDLE_TEST_DATABASE_URL;

test("Mac Apps Library bundle cards", { skip: !DB && "set BUNDLE_TEST_DATABASE_URL" }, async (t) => {
  process.env.BUNDLE_API_KEY = "k".repeat(40);
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DB });
  const sponsors = require("../lib/sponsors");
  const bundle = require("../lib/bundle");
  await pool.query("DROP TABLE IF EXISTS bundle_cancellations, sponsorships, dodo_events, sponsor_clicks, sponsor_daily, sponsor_events, sponsor_seen CASCADE");
  await pool.query("CREATE TABLE sponsor_clicks (id BIGSERIAL PRIMARY KEY, slot INT, ip_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await pool.query(sponsors.SCHEMA);

  const order = (n) => ({
    bundle_order_id: `mal_test_${n}`,
    idempotency_key: `mal_test_${n}:mal_to_bwm`,
    product_name: `App ${n}`,
    tagline: "A Mac app",
    url: `https://app${n}.example.com`,
    logo_url: "https://example.com/logo.png",
    contact_email: `maker${n}@example.com`,
  });
  const regular = async (name, startOffsetDays, days) => {
    const s = new Date(Date.now() + startOffsetDays * 86400000);
    await pool.query(
      "INSERT INTO sponsorships (name, url, email, sku, days, status, payment_id, starts_at, ends_at) VALUES ($1, 'https://x.example.com', 'a@b.co', 'sponsor_7d', $2, 'paid', $1, $3, $4)",
      [name, days, s, new Date(s.getTime() + days * 86400000)]
    );
  };

  await t.test("auth is required", () => {
    assert.equal(bundle.authorised({ headers: {} }), false);
    assert.equal(bundle.authorised({ headers: { "x-api-key": "wrong-key" } }), false);
    assert.equal(bundle.authorised({ headers: { "x-api-key": "k".repeat(39) + "j" } }), false);
    assert.equal(bundle.authorised({ headers: { "x-api-key": "k".repeat(40) } }), true);
    process.env.BUNDLE_API_KEY = "short";
    assert.equal(bundle.authorised({ headers: { "x-api-key": "short" } }), false);
    process.env.BUNDLE_API_KEY = "k".repeat(40);
  });

  await t.test("bad input is refused before anything is booked", async () => {
    assert.equal((await bundle.provision(pool, { ...order(0), url: "javascript:alert(1)" })).status, 400);
    assert.equal((await bundle.provision(pool, { ...order(0), idempotency_key: "other" })).status, 400);
    assert.equal((await bundle.provision(pool, { ...order(0), contact_email: "" })).status, 400);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorships")).rows[0].n, 0);
  });

  await t.test("a card is created once, however often the call is retried", async () => {
    const first = await bundle.provision(pool, order(1));
    assert.equal(first.status, 201);
    assert.equal(first.body.status, "live");
    const again = await Promise.all([bundle.provision(pool, order(1)), bundle.provision(pool, order(1))]);
    for (const r of again) assert.equal(r.body.sponsor_card_id, first.body.sponsor_card_id);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorships")).rows[0].n, 1);
  });

  await t.test("at most two bundle cards run at once; the third queues", async () => {
    const second = await bundle.provision(pool, order(2));
    assert.equal(second.body.status, "live");
    const third = await bundle.provision(pool, order(3));
    assert.equal(third.body.status, "queued");
    const firstEnds = (await pool.query("SELECT min(ends_at) AS e FROM sponsorships")).rows[0].e;
    assert.equal(new Date(third.body.starts_at).getTime(), new Date(firstEnds).getTime());
  });

  await t.test("never more than four at once, with regular sponsors in the mix", async () => {
    await regular("reg-a", 0, 30);
    await regular("reg-b", 0, 30);
    const avail = await bundle.availability(pool);
    const fourth = await bundle.provision(pool, order(4));
    assert.equal(new Date(fourth.body.starts_at).getTime(), new Date(avail.body.starts_at).getTime());
    const rows = (await pool.query("SELECT starts_at, ends_at, source FROM sponsorships WHERE status = 'paid'")).rows;
    const edges = rows.flatMap((r) => [new Date(r.starts_at).getTime(), new Date(r.ends_at).getTime() - 1]);
    for (const p of edges) {
      const live = rows.filter((r) => new Date(r.starts_at).getTime() <= p && new Date(r.ends_at).getTime() > p);
      assert.ok(live.length <= 4, `${live.length} cards live at once`);
      assert.ok(live.filter((r) => r.source === "mal_bundle").length <= 2);
    }
    // The homepage only ever shows four.
    assert.equal((await sponsors.currentSlots(pool)).filter((s) => s.name).length, 4);
  });

  await t.test("concurrent bookings never oversell", async () => {
    await Promise.all([5, 6, 7, 8].map((n) => bundle.provision(pool, order(n))));
    const rows = (await pool.query("SELECT starts_at, ends_at, source FROM sponsorships WHERE status = 'paid'")).rows;
    for (const r of rows) {
      const p = new Date(r.starts_at).getTime();
      const live = rows.filter((x) => new Date(x.starts_at).getTime() <= p && new Date(x.ends_at).getTime() > p);
      assert.ok(live.length <= 4);
      assert.ok(live.filter((x) => x.source === "mal_bundle").length <= 2);
    }
  });

  await t.test("a card leaves the homepage on its end date and frees the slot", async () => {
    const id = (await pool.query("SELECT id FROM sponsorships WHERE bundle_order_id = 'mal_test_1'")).rows[0].id;
    await pool.query("UPDATE sponsorships SET ends_at = now() - interval '1 second' WHERE id = $1", [id]);
    const slots = await sponsors.currentSlots(pool);
    assert.ok(!slots.some((s) => s.sponsorshipId === id));
    const check = await bundle.status(pool, { bundle_order_id: "mal_test_1", status: "check" });
    assert.equal(check.body.status, "ended");
  });

  await t.test("a refund ends the card and it never comes back", async () => {
    const out = await bundle.status(pool, { bundle_order_id: "mal_test_2", status: "order_refunded" });
    assert.equal(out.body.status, "ended");
    const again = await bundle.provision(pool, order(2));
    assert.equal(again.body.status, "ended");
    const none = await bundle.status(pool, { bundle_order_id: "mal_never_booked", status: "order_refunded" });
    assert.equal(none.body.status, "none");
    // ...and a booking that arrives after that refund never goes live.
    const late = await bundle.provision(pool, { ...order(99), bundle_order_id: "mal_never_booked", idempotency_key: "mal_never_booked:mal_to_bwm" });
    assert.equal(late.status, 409);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorships WHERE bundle_order_id = 'mal_never_booked'")).rows[0].n, 0);
  });

  await t.test("a refund racing a booking leaves no live card", async () => {
    for (let i = 0; i < 10; i++) {
      const o = { ...order(200 + i) };
      await Promise.all([bundle.provision(pool, o), bundle.status(pool, { bundle_order_id: o.bundle_order_id, status: "order_refunded" })]);
      const live = await pool.query("SELECT count(*)::int AS n FROM sponsorships WHERE bundle_order_id = $1 AND status = 'paid'", [o.bundle_order_id]);
      assert.equal(live.rows[0].n, 0);
    }
  });

  await t.test("a 30-day card runs 30 days; other lengths are refused", async () => {
    await pool.query("UPDATE sponsorships SET status = 'ended', ends_at = now() WHERE status = 'paid'");
    const month = await bundle.provision(pool, { ...order(300), days: 30 });
    assert.equal(month.status, 201);
    assert.equal(Math.round((new Date(month.body.ends_at) - new Date(month.body.starts_at)) / 86400000), 30);
    const row = (await pool.query("SELECT sku, days FROM sponsorships WHERE id = $1", [month.body.sponsor_card_id])).rows[0];
    assert.deepEqual(row, { sku: "mal_bundle_30d", days: 30 });
    assert.equal((await bundle.provision(pool, { ...order(301), days: 14 })).status, 400);
    assert.equal((await bundle.availability(pool, "30")).body.days, 30);
    assert.equal((await bundle.availability(pool, "9")).status, 400);
  });

  await t.test("a regular Dodo sponsor still books around bundle cards", async () => {
    const start = await sponsors.earliestStart(pool, 7);
    assert.ok(start instanceof Date);
    const rows = (await pool.query("SELECT starts_at, ends_at FROM sponsorships WHERE status = 'paid'")).rows;
    const s = start.getTime();
    const e = s + 7 * 86400000;
    const points = [s, ...rows.map((r) => new Date(r.starts_at).getTime()).filter((x) => x > s && x < e)];
    for (const p of points) {
      assert.ok(rows.filter((r) => new Date(r.starts_at).getTime() <= p && new Date(r.ends_at).getTime() > p).length < 4);
    }
  });

  await pool.end();
});
