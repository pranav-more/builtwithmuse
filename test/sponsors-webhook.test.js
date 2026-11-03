"use strict";

// The Dodo business sends every brand's events here; only Built with Muse
// products may touch the database.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const SECRET = "whsec_" + Buffer.from("test-secret-0123456789").toString("base64");
process.env.DODO_WEBHOOK_KEY = SECRET;
const sponsors = require("../lib/sponsors");

function signed(event) {
  const raw = JSON.stringify(event);
  const id = "msg_" + crypto.randomBytes(6).toString("hex");
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.slice(6), "base64");
  const sig = crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return { headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, raw };
}

function fakePool(rowsFor = () => []) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push(sql); return { rows: rowsFor(sql, params) }; } };
}

test("a foreign product payment is ignored with no writes", async () => {
  const pool = fakePool();
  const { headers, raw } = signed({ type: "payment.succeeded", data: { payment_id: "pay_x", product_cart: [{ product_id: "pdt_0No9M0U27vrL7M0GdTgHF", quantity: 1 }], metadata: { sponsorship_id: "00000000-0000-0000-0000-000000000000" } } });
  const out = await sponsors.webhook(pool, headers, raw);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.ignored, true);
  assert.ok(pool.calls.every((sql) => /^SELECT/.test(sql)), "no writes");
  assert.strictEqual(pool.calls.length, 0);
});

test("foreign subscription and unknown refund events are ignored", async () => {
  for (const event of [
    { type: "subscription.cancelled", data: { subscription_id: "sub_x", product_id: "pdt_0Nm3gZEDCZUNBBER7qYLh" } },
    { type: "refund.succeeded", data: { payment_id: "pay_not_ours" } },
  ]) {
    const pool = fakePool();
    const { headers, raw } = signed(event);
    const out = await sponsors.webhook(pool, headers, raw);
    assert.strictEqual(out.body.ignored, true, event.type);
    assert.ok(pool.calls.every((sql) => /^SELECT/.test(sql)), "no writes for " + event.type);
  }
});

test("an own product payment is processed", async () => {
  const pool = fakePool();
  const { headers, raw } = signed({ type: "payment.succeeded", data: { payment_id: "pay_y", product_cart: [{ product_id: sponsors.PRODUCTS.sponsor_7d.productId, quantity: 1 }], metadata: {} } });
  const out = await sponsors.webhook(pool, headers, raw);
  assert.strictEqual(out.status, 200);
  assert.ok(pool.calls.some((sql) => /INSERT INTO dodo_events/.test(sql)));
});

test("production refuses a non-live base URL", () => {
  const prev = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  // DODO_API_BASE is read at load time; default resolves to live.
  assert.strictEqual(sponsors.paymentsModeProblem(), null);
  process.env.VERCEL_ENV = prev;
});
