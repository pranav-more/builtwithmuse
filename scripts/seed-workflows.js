"use strict";

// Seeds the Creator Pool with the editorial workflows in seed/workflows.json,
// through the same validation and tables a creator submission uses, so seed
// content never drifts from the real content path. Idempotent by slug.
//
//   SUPABASE_DB_URL=postgres://... node scripts/seed-workflows.js [--dry]

const fs = require("fs");
const path = require("path");

process.env.DEVICE_SECRET = process.env.DEVICE_SECRET || "seed";
const { ensureReady } = require("../lib/api");
const creators = require("../lib/creators");
const { Pool } = require("pg");

async function main() {
  const dry = process.argv.includes("--dry");
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "workflows.json"), "utf8"));
  await ensureReady();
  const url = new URL(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL);
  url.searchParams.delete("sslmode");
  const pool = new Pool({ connectionString: url.toString(), max: 2, ssl: ["localhost", "127.0.0.1"].includes(url.hostname) ? undefined : { rejectUnauthorized: false } });
  const editorial = (await pool.query("SELECT id, handle FROM creator_profiles WHERE is_editorial ORDER BY created_at LIMIT 1")).rows[0];
  if (!editorial) throw new Error("no editorial profile; run sql/creator-pool.sql first");
  let created = 0, skipped = 0, invalid = 0;
  for (const item of items) {
    const { value, errors } = creators.parseWorkflow(item, { complete: true });
    if (errors.length) { invalid += 1; console.error(`invalid: ${item.slug}: ${errors.join(", ")}`); continue; }
    const exists = (await pool.query("SELECT id FROM workflows WHERE slug = $1", [item.slug])).rows[0];
    if (exists) { skipped += 1; continue; }
    if (dry) { created += 1; console.log(`would create: ${item.slug}`); continue; }
    const row = await creators.createWorkflow({ id: editorial.id }, value, { status: "published" });
    // Keep the seed slug so links stay stable across environments.
    if (row.slug !== item.slug) await pool.query("UPDATE workflows SET slug = $2 WHERE id = $1", [row.id, item.slug]);
    await pool.query("INSERT INTO pool_events (kind, workflow_id, creator_id, actor, detail) VALUES ('seed', $1, $2, 'seed-script', $3)", [row.id, editorial.id, JSON.stringify({ source: item.source })]);
    created += 1;
    console.log(`created: ${item.slug}`);
  }
  console.log(JSON.stringify({ created, skipped, invalid, owner: editorial.handle, dry }));
  await pool.end();
  process.exit(invalid ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
