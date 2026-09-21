# builtwithmuse.com

Community site for sharing free Muse invite codes. Live at https://builtwithmuse.com (also https://getmusecode.com, which forwards there).

## Structure

- `public/index.html`: the whole site, one static page.
- `public/admin.html`: the moderator page, served at `/admin`.
- `public/blog/`: the blog. `index.html` lists posts; each post is its own file, served without the `.html` (Vercel `cleanUrls`). Add a post by copying an existing one, adding a card to the index and a line to `sitemap.xml`. Guides with a FAQ carry FAQPage JSON-LD.
- `api/index.js` and `lib/api.js`: the API, a Vercel serverless function backed by Postgres on Supabase. Every `/api/*` path is rewritten to it (see `vercel.json`).
- `server.js`: local development server that serves `public/` and the same API code. Not used in production.

No build step.

## Deploy

Vercel project `builtwithmuse` (personal account of pranavmore.psm@gmail.com) auto deploys the `main` branch of github.com/pranav-more/builtwithmuse. Every push to `main` goes live. Functions run in `sfo1`, next to the database.

Domains:
- builtwithmuse.com (primary). Registered at GoDaddy, nameservers point at Vercel (ns1 and ns2.vercel-dns.com), so DNS records live in the Vercel project. www redirects to the apex with a 308.
- getmusecode.com (301 forwards to builtwithmuse.com, including www). Forwarding is done by GoDaddy and does not involve Vercel.

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
- A device that reloads within 15 minutes gets the same code back rather than a new one. "Try another code" and "This code didn't work" ask for a fresh one; a device never gets the same code twice.
- "Not working" flags the code (visible as Flagged in the dashboard) and hands the visitor the latest available code; two flags from different people retire the code.
- When the pool is empty the page says so and points to sharing and the waitlist.
- After a visitor copies a code or presses any button on the code screen (or after 30 quiet seconds), a "Pay it forward" modal asks for their own invite code, with a form that posts to the same endpoint as the share page. It appears once per browser session.
- "I redeemed it" records a confirmation from the holder; such codes show as Verified on the home page pool and in the dashboard.
- The home page shows the pool itself through `GET /api/pool`: masked codes (first letter only), seat squares, open counts, Full and Pulled states. Never a code.
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

`public/sitemap.xml` lists the home page and the blog; `public/robots.txt` points at it and blocks `/api/`. The moderator page relies on its `noindex` meta tag. Add new blog posts to the sitemap.

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
- GoDaddy: domain registration for both domains and the getmusecode.com forwarding (jayeshmarathe2000jm@gmail.com)
- Google, polostudio.brand@gmail.com: Analytics, Search Console, Microsoft Clarity
