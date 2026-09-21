# builtwithmuse.com

Community site for sharing free Muse invite codes. Live at https://builtwithmuse.com (also https://getmusecode.com, which forwards there).

## Structure

Single static page: `index.html`. No build step, no backend.

## Deploy

Netlify auto deploys the `main` branch. Every push to `main` goes live.

Custom domains (set in Netlify, DNS in GoDaddy):
- builtwithmuse.com (primary)
- getmusecode.com (301 forwards to builtwithmuse.com, including www)

## Adding invite codes

Edit the `inviteCodes` array near the bottom of `index.html` and push. New codes appear in the pool immediately.

## Forms

Waitlist and code submissions POST to a Google Apps Script webhook that saves them to a Google Sheet. Waitlist entries go to the first sheet, code submissions go to the `code_submissions` sheet. The endpoint is the `FORM_ENDPOINT` constant in `index.html`.

## Analytics

- Google Analytics 4 measurement ID: G-C94847V6DS
- Search Console verified via the meta tag in `<head>`

## Copy rules

- No hyphen or dash characters in visible site copy (no em dashes, en dashes, or hyphenated compounds). Rewrite compounds naturally.
- The page runs a check on load that throws if forbidden punctuation appears in visible copy. If the page goes blank after an edit, look for a stray dash.
- Never promise a fixed token amount. The site is an independent community project, not affiliated with or endorsed by Meta.

## Accounts

- GitHub: jayeshmark
- Netlify site: rainbow-palmier-16b0b4
- GoDaddy: DNS and domain forwarding
- Google: Analytics, Search Console, Apps Script webhook
