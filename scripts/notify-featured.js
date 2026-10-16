"use strict";

// Sends the Step 7 featured notification for the current Featured pick.
//
// FEATURED_SLUGS in lib/creators.js is a hand edited list: there is no
// rotation job and no admin control for it, so the notification cannot
// fire by itself. When the pick changes, the editor updates FEATURED_SLUGS
// and then runs this script once:
//
//   RESEND_API_KEY=... SUPABASE_DB_URL=... node scripts/notify-featured.js
//
// Options:
//   --slug <slug>   notify for one slug instead of every FEATURED_SLUGS entry
//   --end <label>   the date the featured week ends, as the reader should
//                   see it (default: seven days from today, spelled out)
//
// Without RESEND_API_KEY the email module logs a skip and sends nothing,
// so a dry run is safe: it still prints who would be emailed.

const { Pool } = require("pg");
const { FEATURED_SLUGS } = require("../lib/creators");
const { sendFeaturedNotification } = require("../lib/email");

// Same connection handling as lib/api.js: the Supabase pooler certificate
// chain is not trusted by Node by default, and the URL sslmode parameter
// would override an explicit ssl setting, so strip it and decide here.
function makePool(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  return new Pool({
    connectionString: url.toString(),
    max: 2,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function defaultEndLabel() {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("SUPABASE_DB_URL or DATABASE_URL must be set");
    process.exit(1);
  }
  const only = argValue("--slug");
  const slugs = only ? [only] : FEATURED_SLUGS;
  const endDate = argValue("--end") || defaultEndLabel();
  const pool = makePool(connectionString);
  try {
    for (const slug of slugs) {
      const r = await pool.query(
        `SELECT w.slug, w.title, c.email, c.display_name, c.handle
           FROM workflows w JOIN creator_profiles c ON c.id = w.creator_id
          WHERE w.slug = $1 AND w.status = 'published'`,
        [slug]
      );
      const row = r.rows[0];
      if (!row) {
        console.error(`no published workflow found for slug ${slug}`);
        continue;
      }
      const result = await sendFeaturedNotification(
        { email: row.email, displayName: row.display_name, handle: row.handle },
        { slug: row.slug, title: row.title, endDate }
      );
      console.log(slug, "->", row.email, JSON.stringify(result));
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
