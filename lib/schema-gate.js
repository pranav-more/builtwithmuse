// Runs a block of idempotent schema SQL at most once per version of its text.
//
// Why this exists: the schema blocks used to run on every cold start. Each
// ALTER TABLE takes an AccessExclusiveLock even when it changes nothing, so
// two instances booting together deadlocked each other (40P01), and they
// deadlocked with ordinary page queries too, which then failed with a 500.
//
// Now a cold start costs one SELECT. The DDL runs only when the SQL text has
// changed since the last successful run (a deploy that edits a schema block),
// inside one transaction, behind one advisory lock shared by every block, so
// concurrent boots queue up instead of fighting and the losers find the work
// already done.

const crypto = require("crypto");

// Any fixed pair of ints; only has to be the same in every instance.
const LOCK_A = 20251113;
const LOCK_B = 1;

async function storedHash(db, name) {
  try {
    const r = await db.query("SELECT hash FROM schema_versions WHERE name = $1", [name]);
    return r.rows[0] ? r.rows[0].hash : null;
  } catch (err) {
    if (err.code === "42P01") return null; // schema_versions not created yet
    throw err;
  }
}

// Returns true when the SQL was applied, false when it was already current.
async function applySchemaOnce(pool, name, sql) {
  const hash = crypto.createHash("sha256").update(sql).digest("hex");
  if ((await storedHash(pool, name)) === hash) return false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_A, LOCK_B]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    // Another instance may have finished while this one waited for the lock.
    if ((await storedHash(client, name)) === hash) {
      await client.query("COMMIT");
      return false;
    }
    // Give up on a busy table instead of queueing every reader behind us;
    // the caller retries.
    await client.query("SET LOCAL lock_timeout = '8s'");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_versions (name, hash) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET hash = EXCLUDED.hash, applied_at = now()",
      [name, hash]
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applySchemaOnce };
