# builtwithmuse.com

Community site for sharing free Muse invite codes. Live at https://builtwithmuse.com (also https://getmusecode.com, which forwards there).

## Structure

Single static page: `index.html`. No build step, no backend.

## Deploy

Vercel project `builtwithmuse` (personal account of pranavmore.psm@gmail.com) auto deploys the `main` branch of github.com/pranav-more/builtwithmuse. Every push to `main` goes live. No build step: framework preset "Other", output directory is the repo root.

Domains:
- builtwithmuse.com (primary). Registered at GoDaddy, nameservers point at Vercel (ns1 and ns2.vercel-dns.com), so DNS records live in the Vercel project. www redirects to the apex with a 308.
- getmusecode.com (301 forwards to builtwithmuse.com, including www). Forwarding is done by GoDaddy and does not involve Vercel.

Moved off Netlify on 2026-09-21; the old Netlify site and DNS zone were deleted.

## Adding invite codes

Edit the `inviteCodes` array near the bottom of `index.html` and push. New codes appear in the pool immediately.

## Forms

Waitlist and code submissions POST to a Google Apps Script webhook that saves them to a Google Sheet. Waitlist entries go to the first sheet, code submissions go to the `code_submissions` sheet. The endpoint is the `FORM_ENDPOINT` constant in `index.html`.

## Analytics

- Vercel Web Analytics is enabled on the project; the snippet at the end of `<head>` loads `/_vercel/insights/script.js`. Keep it.
- Google Analytics 4 measurement ID: G-C94847V6DS (GA account "Built With Muse", administered by polostudio.brand@gmail.com)
- Search Console property https://builtwithmuse.com/ is owned by polostudio.brand@gmail.com, verified via the meta tag in `<head>`. Do not remove that tag.

## Copy rules

- No hyphen or dash characters in visible site copy (no em dashes, en dashes, or hyphenated compounds). Rewrite compounds naturally.
- The page runs a check on load that throws if forbidden punctuation appears in visible copy. If the page goes blank after an edit, look for a stray dash.
- Never promise a fixed token amount. The site is an independent community project, not affiliated with or endorsed by Meta.

## Accounts

- GitHub: pranav-more (the original repo under jayeshmark is no longer deployed)
- Vercel: pranavmore.psm@gmail.com, project `builtwithmuse`
- GoDaddy: domain registration for both domains and the getmusecode.com forwarding (jayeshmarathe2000jm@gmail.com)
- Google, polostudio.brand@gmail.com: Analytics, Search Console
- Google, jayeshmarathe2000jm@gmail.com: Apps Script webhook and the Sheet it writes to
