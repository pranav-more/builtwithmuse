# builtwithmuse.com

Community site for sharing free Muse invite codes. Live at https://builtwithmuse.com (also https://getmusecode.com, which forwards there).

## Structure

- `public/index.html`: the whole site, one static page.
- `public/admin.html`: the moderator page, served at `/admin`.
- `public/use-cases/`: the use case library (hub at `/use-cases`, one file per use case, clean URLs, no trailing slash). Two more use cases are listed on the hub as coming soon until their pages exist.
- `public/og/`: 1200 by 630 share images, rendered from `~/Documents/builtwithmuse-design/og-template.html` in a browser. Every page references its own under `/og/`.
- `public/blog/`: the blog. `index.html` lists posts; each post is its own file, served without the `.html` (Vercel `cleanUrls`). Add a post by copying an existing one, adding a card to the index and a line to `sitemap.xml`. Guides with a FAQ carry FAQPage JSON-LD.
- `api/index.js` and `lib/api.js`: the API, a Vercel serverless function backed by Postgres on Supabase. Every `/api/*` path is rewritten to it (see `vercel.json`).
- `server.js`: local development server that serves `public/` and the same API code. Not used in production.

No build step.

Trust pages: `public/about.html` (/about: community pool, not Meta, who runs it) and `public/privacy.html` (/privacy: what is stored and why). Every page carries the "Independent community project. Not affiliated with or endorsed by Meta." pill at the bottom of the footer (Pranav rejected having it under the logo) and About, Privacy and Contact (mailto polostudio.brand@gmail.com) links in the footer. The Workflows view on the home page links to the two live use cases and out to usesundog.com/muse rather than hosting a workflow library.

## Deploy

Vercel project `builtwithmuse` (personal account of pranavmore.psm@gmail.com) auto deploys the `main` branch of github.com/pranav-more/builtwithmuse. Every push to `main` goes live. Functions run in `sfo1`, next to the database.

Domains:
- builtwithmuse.com (primary). Registered at GoDaddy, nameservers point at Vercel (ns1 and ns2.vercel-dns.com), so DNS records live in the Vercel project. www redirects to the apex with a 308.
- getmusecode.com and www.getmusecode.com are domains of the same Vercel project. GoDaddy keeps the nameservers and holds two A records (@ and www) pointing at Vercel's 76.76.21.21. The redirect itself is the host scoped rule in `vercel.json`: every path on either host answers a 301 to https://builtwithmuse.com/ and keeps the query string, so deep links and UTM links land on the invite code page. The old GoDaddy forwarding was removed on 2026-09-21 because it only handled the bare root, dropped query strings and answered HEAD with a 405.

Moved off Netlify on 2026-09-21; the old Netlify site is deleted and its DNS zone can go after 2026-09-23.

## Database

Supabase project `ixifjltslrhelbtzelkf` ("builtwithmuse", organization "Built with muse", Free plan) under jayeshmarathe2000jm@gmail.com, region West US (North California). The Data API is off; only Postgres is used. Tables: `codes`, `claims`, `reports`, `submissions`, `waitlist`. The function creates them on first use (`CREATE TABLE IF NOT EXISTS`).

Environment variables on Vercel (production and preview):
- `SUPABASE_DB_URL`: transaction pooler connection string (port 6543).
- `DEVICE_SECRET`: signs the device cookie. Changing it logs every browser out of its device identity.
- `ADMIN_TOKEN`: bearer token for the admin endpoints.
- `GOOGLE_CLIENT_ID`: OAuth client for moderator sign in.
- `ADMIN_EMAILS` (optional): comma separated moderator emails; see Moderation.

## How codes are handed out

- A visitor clicks "Get a code". The page calls `POST /api/claim`, which picks the newest available code and increments its counter in one statement (`FOR UPDATE SKIP LOCKED`), so concurrent visitors never receive the same code past its limit.
- Each code is handed to at most two people, then the next one is used. Newest submissions go first.
- One code per person: a device keeps the code it was given (`CLAIM_REUSE_MINUTES`, default 30 days). Reloading or pressing "Get a code" again returns the same code, and if the holder already pressed "I redeemed it" the page restores the success state. There is no countdown and no "codes go fast" copy; the claim card says the code is theirs until they flag it.
- "Not working" is the only way to get a different code. It flags the current one (visible as Flagged in the dashboard), shows a "Flagged" panel, and hands out the newest code with room left; a device never gets the same code twice, and two flags from different people retire a code. The per device claim limits (3 an hour, 6 a day) cap how much churn one person can cause.
- "I redeemed it" records a confirmation, marks the code Verified in the pool and the dashboard, and switches the card to a success state with one "Try this first" button (the recipe reel use case) and an "Add your invite" button.
- When the pool is empty the page says so and points to sharing and the waitlist.
- After a visitor copies a code or presses a button on the code screen (or after 30 quiet seconds), a "Pay it forward" modal asks for their own invite code, with a form that posts to the same endpoint as the share page. It appears once per browser session.
- The home page shows the pool itself through `GET /api/pool`: masked codes (first letter only), seat squares, Full and Broken states, and three health counts (codes open, used up, broken). Never a code.
- The referral mechanic is stated once, in plain words, on the share view and in the modal: when someone joins with your invite and redeems it in Settings within 48 hours, Muse credits tokens to both people, amount set by Muse (source: Muse's announcement on X, linked from the page). No token amount is ever quoted.
- The invite link on the share form is optional; the code alone is accepted.

## Scraper controls

- A signed HttpOnly device cookie from `POST /api/session` is required for claims and reports.
- Limits are kept in the database, per device and per IP: claims 3 per hour and 6 per day per device, 8 per hour and 20 per day per IP; submissions and waitlist joins 5 per hour and 20 per day per IP. Vercel sets the client IP headers itself, so they cannot be spoofed.
- Obvious non-browser user agents are refused. Both forms carry a honeypot field. Codes are never present in the HTML.

## Moderation

https://builtwithmuse.com/admin is the moderator dashboard: Google sign in only, for the emails in `ADMIN_EMAILS` (default: pranavmore.psm, polostudio.brand and jayeshmarathe2000jm at gmail.com). Sections: Overview (counts and the latest activity), Analytics (codes given out per day and per hour, submissions, waitlist joins and reports per day, pool health, top countries), Codes (search, filter, add, retire, restore, delete), Claims, Reports and Waitlist, each with CSV export. Every record stores the visitor's country, region and city from Vercel's geolocation headers.

Sign in uses the Google Cloud project `built-with-muse` (owned by polostudio.brand@gmail.com), OAuth client "builtwithmuse admin", client id in `GOOGLE_CLIENT_ID` on Vercel. The consent screen is in testing mode, so only its listed test users can sign in at all; add a new moderator both there (Google Auth Platform, Audience) and in `ADMIN_EMAILS`. Sessions are a signed cookie valid for seven days.

## Admin API

Scripts use `Authorization: Bearer <ADMIN_TOKEN>`; the moderator page uses its session cookie.

```
GET    /api/admin/export.csv?table=codes|claims|waitlist|reports
POST   /api/admin/codes            {"codes": ["ABC123", "..."], "source": "admin"}
POST   /api/admin/codes/retire     {"code": "ABC123"}
POST   /api/admin/codes/restore    {"code": "ABC123"}
GET    /api/admin/overview
GET    /api/admin/codes?status=all|available|used|retired&q=
GET    /api/admin/claims
GET    /api/admin/reports
GET    /api/admin/waitlist
DELETE /api/admin/codes/:id
DELETE /api/admin/waitlist/:id
GET    /api/admin/whoami
```

Adding codes in bulk:

```
curl -X POST https://builtwithmuse.com/api/admin/codes \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"codes":["ABC123","DEF456"]}'
```

## Local development

```
createdb builtwithmuse_dev
DATABASE_URL=postgres://localhost/builtwithmuse_dev DEVICE_SECRET=dev ADMIN_TOKEN=dev node server.js
```

Then open http://localhost:3000.

## Search

`public/sitemap.xml` lists the home page, the blog and the use case library; `public/robots.txt` points at it and blocks `/api/`. The moderator page relies on its `noindex` meta tag. Add new blog posts to the sitemap.

## Analytics

- Vercel Web Analytics is enabled on the project; the snippet at the end of `<head>` loads `/_vercel/insights/script.js`. Keep it.
- Microsoft Clarity project `ylnjyde5d9` ("Built with muse", under polostudio.brand@gmail.com); the tag is in `<head>`.
- Google Analytics 4 measurement ID: G-C94847V6DS (GA account "Built With Muse", administered by polostudio.brand@gmail.com)
- Search Console property https://builtwithmuse.com/ is owned by polostudio.brand@gmail.com, verified via the meta tag in `<head>`. Do not remove that tag.

## Design

"Carbon Blue", chosen 2026-09-21 from eight directions: bright blue `#1a56ff` ground with a carbon weave and a 48px grid drawn in CSS, white uppercase Archivo headlines, IBM Plex Sans body, JetBrains Mono for codes, navy `#0d1b3d` cards, mint `#7dffc6` for anything open or live, coral `#ff8f8f` for pulled or failed. Single theme by design. The blog uses the same tokens; the moderator page keeps its own neutral dashboard look. Public pages are laid out for phones first (stacked hero, scrollable nav, full width buttons under 640px).

## Copy rules

- No hyphen or dash characters in visible site copy (no em dashes, en dashes, or hyphenated compounds). Rewrite compounds naturally.
- The page runs a check on load that throws if forbidden punctuation appears in visible copy. If the page goes blank after an edit, look for a stray dash.
- Never promise a fixed token amount. The site is an independent community project, not affiliated with or endorsed by Meta.

## Accounts

- GitHub: pranav-more (jayeshmark has write access; the original repo under jayeshmark is no longer deployed)
- Vercel: pranavmore.psm@gmail.com, project `builtwithmuse`
- Supabase: jayeshmarathe2000jm@gmail.com, organization "Built with muse"
- GoDaddy: domain registration for both domains and the getmusecode.com A records (jayeshmarathe2000jm@gmail.com)
- Google, polostudio.brand@gmail.com: Analytics, Search Console, Microsoft Clarity

## Creator Pool

A reputation driven pool of Muse workflows (spec: `creator-pool-spec.pdf`,
25 September 2026). Creators sign in with Google, claim a handle, and publish
workflows as problem, steps, result. Anyone can rate once per device; the
weighted score (`workflow_stats`, `creator_stats` views) is computed from the
ratings and never stored.

- Schema: `sql/creator-pool.sql`, idempotent. Apply by hand with psql against
  the Supabase session pooler (`aws-0-us-west-1.pooler.supabase.com:5432`,
  user `postgres.ixifjltslrhelbtzelkf`, password in
  `~/.config/builtwithmuse/supabase-db-password`). Applied to production on
  2026-09-25.
- Code: `lib/creators.js` (API, pages, admin), `lib/pages.js` (layout),
  `lib/dashboard.js` (the /creator page). Routes: `/workflows`,
  `/workflows/:slug`, `/creators/:handle`, `/creator`, `/sitemap-pool.xml` are
  rewritten to the function (vercel.json) and forwarded by server.js locally.
- Seed: `seed/workflows.json` (14 editorial workflows owned by the
  `builtwithmuse` editorial profile). `SUPABASE_DB_URL=... node
  scripts/seed-workflows.js [--dry]`, idempotent by slug. Seeded in production
  on 2026-09-25.
- Settings live in `pool_settings`: `prior_weight` (5), `report_hide_threshold`
  (3 distinct devices), `submissions_open` (true).
- Moderation: the Creator pool tab in /admin, or `/api/admin/pool/*` with the
  admin token.
- Sign in uses the existing Google OAuth client (GCP project `built-with-muse`),
  published to production on 2026-09-25 so any Google account can sign in.
  Email magic links were not built: the site has no email sender.

