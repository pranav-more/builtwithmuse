"use strict";

// Server rendered pages for the Creator Pool: the workflow index, workflow
// detail pages and creator profiles. They share the site's Carbon Blue look
// (same tokens, header and footer as the static pages) so a visitor cannot
// tell a rendered page from a static one.

const MARK = '<svg class="mark" viewBox="0 0 9 9" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M4 0h1v1H4zM1 1h1v1H1zM4 1h1v1H4zM7 1h1v1H7zM2 2h1v1H2zM4 2h1v1H4zM6 2h1v1H6zM3 3h1v1H3zM4 3h1v1H4zM5 3h1v1H5zM0 4h1v1H0zM1 4h1v1H1zM2 4h1v1H2zM3 4h1v1H3zM4 4h1v1H4zM5 4h1v1H5zM6 4h1v1H6zM7 4h1v1H7zM8 4h1v1H8zM3 5h1v1H3zM4 5h1v1H4zM5 5h1v1H5zM2 6h1v1H2zM4 6h1v1H4zM6 6h1v1H6zM1 7h1v1H1zM4 7h1v1H4zM7 7h1v1H7zM4 8h1v1H4z"/></svg>';
const SITE = "https://builtwithmuse.com";

function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const CSS = `
:root { color-scheme: light; --blue: #1a56ff; --blue-deep: #0f3fc4; --bg: #ffffff; --tint: #eef3ff; --navy: #ffffff; --navy-2: #eef3ff; --ink: #0b1220; --muted: #4b5675; --muted-2: #6b7699; --line: #dfe5f3; --line-soft: #eceff8; --mint: #1a56ff; --mint-ink: #ffffff; --coral: #d92d20; --coral-ink: #ffffff; --paper: #ffffff; --paper-ink: #0b1b4d; --paper-muted: #45538a; --paper-line: #c9d4f2; --shadow: 0 8px 24px rgba(11,18,32,.06); --radius: 10px; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; color: var(--ink); background-color: var(--bg);
  background-image: linear-gradient(rgba(11,18,32,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(11,18,32,.045) 1px, transparent 1px), linear-gradient(45deg, transparent 25%, transparent 25%, transparent 50%, transparent 50%, transparent 75%, transparent 75%), linear-gradient(-45deg, transparent 25%, transparent 25%, transparent 50%, transparent 50%, transparent 75%, transparent 75%);
  background-size: 48px 48px, 48px 48px, 6px 6px, 6px 6px; font-family: "IBM Plex Sans", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
h1, h2, h3 { font-family: "Archivo", sans-serif; letter-spacing: -0.025em; text-wrap: balance; }
.shell { width: min(1180px, calc(100% - 40px)); margin: 0 auto; padding: 0 0 48px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 20px 0; border-bottom: 1px solid var(--line); margin-bottom: 40px; }
.topbar { position: sticky; top: 0; z-index: 30; margin: 0 calc(50% - 50vw) 40px; padding: 16px calc(50vw - 50%); background: transparent; transition: background .25s ease, backdrop-filter .25s ease, box-shadow .25s ease; }
.topbar.scrolled { background: rgba(255,255,255,.88); backdrop-filter: blur(14px) saturate(140%); -webkit-backdrop-filter: blur(14px) saturate(140%); box-shadow: 0 10px 30px rgba(11,18,32,.08); }
.brand { font: 900 18px/1 "Archivo", sans-serif; letter-spacing: -0.02em; text-transform: uppercase; text-decoration: none; white-space: nowrap; display: inline-flex; align-items: center; gap: 10px; }
.brand .mark { width: 22px; height: 22px; flex: 0 0 auto; }
.nav { display: flex; gap: 4px; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.nav::-webkit-scrollbar { display: none; }
.nav a { flex: 0 0 auto; border: 1px solid transparent; border-radius: 8px; padding: 9px 13px; color: var(--muted); font-size: 14px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.nav a:hover { color: var(--ink); border-color: var(--line); }
.nav a[aria-current="page"] { background: #e6edff; color: var(--ink); border-color: var(--line); }
.account-slot { display: inline-flex; align-items: center; gap: 2px; margin-left: 8px; }
.account-slot img { width: 28px; height: 28px; border-radius: 50%; }
.account-slot a, .account-slot button { color: var(--muted); font-size: 14px; font-weight: 600; text-decoration: none; padding: 9px 8px; white-space: nowrap; background: none; border: 0; cursor: pointer; font-family: inherit; }
.account-slot a:hover, .account-slot button:hover { color: var(--ink); }
.nav a:focus-visible, .cta:focus-visible, .card:focus-visible, .menu-toggle:focus-visible, .star:focus-visible, .chip:focus-visible, .field input:focus-visible, .field textarea:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
.menu-toggle { display: none; width: 44px; height: 44px; border: 1px solid var(--line); border-radius: 8px; background: #eef3ff; padding: 0; flex-direction: column; align-items: center; justify-content: center; gap: 5px; }
.menu-toggle span { display: block; width: 20px; height: 2px; background: var(--ink); border-radius: 2px; transition: transform .18s ease, opacity .18s ease; }
.topbar.open .menu-toggle span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
.topbar.open .menu-toggle span:nth-child(2) { opacity: 0; }
.topbar.open .menu-toggle span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
.eyebrow { color: var(--muted-2); font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 16px; }
.hero { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(280px, .8fr); gap: 40px; align-items: end; padding: 12px 0 40px; border-bottom: 1px solid var(--line); margin-bottom: 36px; }
.hero h1 { font-size: clamp(34px, 5.6vw, 68px); line-height: .98; font-weight: 900; text-transform: uppercase; letter-spacing: -0.035em; margin: 0 0 14px; overflow-wrap: anywhere; }
.hero h1.title-case { text-transform: none; font-size: clamp(30px, 4.6vw, 54px); letter-spacing: -0.03em; }
.hero .lead { color: var(--muted); font-size: 18px; line-height: 1.55; max-width: 60ch; margin: 0; }
.hero .meta { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--muted-2); font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; margin-top: 18px; }
.hero .meta a { text-decoration: none; color: var(--ink); }
.hero .meta a:hover { color: var(--mint); }
.hero-aside { background: var(--navy); border: 1px solid var(--line); border-radius: var(--radius); padding: 22px; box-shadow: var(--shadow); }
.hero-aside .k { color: var(--muted-2); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 10px; }
.hero-aside p { margin: 0 0 14px; color: var(--muted); line-height: 1.5; }
.cta { display: inline-flex; align-items: center; justify-content: center; gap: 10px; padding: 13px 20px; border-radius: 8px; background: var(--blue); color: #fff; text-decoration: none; font-weight: 700; border: 2px solid var(--blue); }
.cta:hover { background: #e6edff; }
.cta.ghost { background: transparent; color: var(--ink); border-color: var(--blue); }
.cta.ghost:hover { background: #eceff8; }
.cta.full { width: 100%; }
.cta:disabled { opacity: .6; cursor: default; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; margin: 0 0 24px; }
.toolbar form { display: flex; gap: 8px; flex: 1 1 320px; }
.toolbar input[type=search] { flex: 1; min-width: 0; padding: 11px 14px; border: 1px solid var(--line); border-radius: 8px; background: #f3f6fd; color: var(--ink); }
.toolbar input::placeholder { color: #98a2c3; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; padding: 8px 12px; border: 1px solid var(--line-soft); border-radius: 999px; background: #f3f6fd; color: var(--muted); font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.chip:hover { color: var(--ink); border-color: var(--line); }
.chip[aria-current="true"] { background: var(--blue); color: #fff; border-color: var(--blue); }
.section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 36px 0 14px; }
.section-title h2 { margin: 0; font-size: 22px; }
.section-title p { margin: 0; color: var(--muted-2); font-size: 13px; font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
.card { display: flex; flex-direction: column; text-decoration: none; padding: 24px 26px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--navy); box-shadow: var(--shadow); min-height: 220px; }
.card:hover { border-color: var(--mint); }
.card .tag { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--mint); margin-bottom: 12px; }
.card h2, .card h3 { margin: 0 0 10px; font-size: 21px; line-height: 1.15; }
.card p { margin: 0 0 16px; color: var(--muted); line-height: 1.5; flex: 1; font-size: 15px; }
.card .by { color: var(--muted-2); font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.card .foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--muted-2); font-weight: 600; }
.rating { display: inline-flex; align-items: center; gap: 6px; color: var(--ink); font-weight: 700; }
.rating .stars { color: var(--mint); letter-spacing: 1px; font-size: 14px; }
.rating .new { display: inline-block; padding: 2px 8px; border-radius: 4px; background: rgba(26,86,255,.1); color: var(--mint); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
.empty { padding: 36px 24px; border: 1px dashed var(--line); border-radius: var(--radius); color: var(--muted); text-align: center; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 40px; align-items: start; }
article { background: var(--navy); border: 1px solid var(--line); border-radius: var(--radius); padding: clamp(22px, 4vw, 44px); box-shadow: var(--shadow); min-width: 0; }
article > * { max-width: 72ch; }
article p, article li { font-size: 17px; line-height: 1.7; color: var(--muted); overflow-wrap: anywhere; }
article p strong, article li strong { color: var(--ink); }
article p { margin: 0 0 18px; }
article h2 { font-size: 26px; margin: 36px 0 12px; color: var(--ink); }
article h2:first-child { margin-top: 0; }
article ul, article ol { padding-left: 22px; margin: 0 0 20px; }
article li { margin-bottom: 10px; }
article a { color: var(--mint); }
.steps { counter-reset: step; list-style: none; padding: 0 !important; display: grid; gap: 12px; }
.steps li { counter-increment: step; display: grid; grid-template-columns: 34px 1fr; gap: 14px; align-items: start; padding: 14px 16px; border: 1px solid var(--line-soft); border-radius: 8px; background: #f8fafe; margin: 0; }
.steps li::before { content: counter(step); width: 30px; height: 30px; border-radius: 50%; background: var(--blue); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 13px; }
.steps li strong { display: block; margin-bottom: 4px; }
.prompt { position: relative; padding: 18px 20px; border-radius: 8px; background: #f3f6fd; border: 1px solid var(--line-soft); font: 500 15px/1.6 "JetBrains Mono", monospace; color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 20px; }
.prompt-block { margin: 0; padding: 30px 0 8px; border-bottom: 1px solid var(--line); margin-bottom: 30px; }
.prompt-block .k { color: var(--muted-2); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 12px; }
.prompt-actions { display: flex; align-items: center; gap: 14px; margin: 0 0 10px; flex-wrap: wrap; }
.prompt-hint { color: var(--muted); font-size: 14px; margin: 0 0 6px; }
.prompt-quote { color: var(--muted-2); font-size: 14px; font-style: italic; margin: 0 0 16px; }
.end-actions { margin: 28px 0; padding: 12px 14px; border: 1px solid var(--line-soft); border-radius: var(--radius); background: #f8fafe; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.end-actions .stars-input { gap: 2px; }
.end-actions .star { width: 34px; height: 34px; font-size: 17px; border-radius: 8px; }
.end-div { width: 1px; align-self: stretch; background: var(--line-soft); }
.rate-note { color: var(--muted); font-size: 13px; }
.save-icon { width: 38px; height: 38px; flex: 0 0 auto; border: 1px solid var(--line-soft); border-radius: 8px; background: #f6f8fe; color: var(--muted-2); display: grid; place-items: center; padding: 0; }
.save-icon:hover { color: var(--ink); border-color: var(--line); }
.save-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linejoin: round; }
.save-icon.on { color: var(--mint); border-color: var(--mint); }
.save-icon.on svg { fill: currentColor; }
.hero.solo { grid-template-columns: minmax(0, 1fr); }
.follow-btn { background: #eef3ff; border: 1px solid var(--line); color: var(--ink); border-radius: 999px; padding: 4px 14px; font-size: 12px; font-weight: 700; letter-spacing: .04em; cursor: pointer; font-family: inherit; }
.follow-btn:hover:not(:disabled) { border-color: var(--mint); color: var(--mint); }
.follow-btn.on { background: var(--mint); border-color: var(--mint); color: var(--mint-ink); }
.follow-btn.lg { padding: 10px 22px; font-size: 14px; }
.follow-btn:disabled { opacity: .6; cursor: default; }
.callout { padding: 18px 22px; border: 1px solid rgba(26,86,255,.35); border-radius: 8px; background: rgba(26,86,255,.08); margin: 24px 0; color: var(--ink); }
.callout strong { display: block; margin-bottom: 4px; }
.rail { position: sticky; top: 92px; display: grid; gap: 16px; }
.rail-box { background: var(--navy); border: 1px solid var(--line); border-radius: var(--radius); padding: 22px; box-shadow: var(--shadow); }
.rail-box .k { color: var(--muted-2); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 10px; }
.rail-box h3 { margin: 0 0 8px; font-size: 20px; }
.rail-box p { margin: 0 0 14px; color: var(--muted); line-height: 1.5; font-size: 15px; }
.rail-box .cta { width: 100%; margin-top: 4px; }
.rail-box .link { display: block; color: var(--ink); text-decoration: none; font-weight: 600; padding: 9px 0; border-top: 1px solid var(--line-soft); font-size: 14px; }
.rail-box .link:hover { color: var(--mint); }
.rail-box .link small { display: block; color: var(--muted-2); font-weight: 500; }
.stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 0 0 6px; }
.stat { padding: 12px 10px; border: 1px solid var(--line-soft); border-radius: 8px; background: #f6f8fe; text-align: center; }
.stat b { display: block; font: 700 22px/1.1 "Archivo", sans-serif; }
.stat span { display: block; color: var(--muted-2); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin-top: 4px; }
.rate { display: grid; gap: 10px; }
.stars-input { display: flex; gap: 4px; }
.star { width: 40px; height: 40px; border: 1px solid var(--line-soft); border-radius: 8px; background: #f6f8fe; color: var(--muted-2); font-size: 20px; display: grid; place-items: center; }
.star:hover, .star.lit { color: var(--mint); border-color: var(--mint); }
.star.picked { background: var(--mint); color: var(--mint-ink); border-color: var(--mint); }
.rate-status { min-height: 20px; color: var(--muted); font-size: 14px; font-weight: 600; }
.rate-status.err { color: var(--coral); }
.quiet-link { background: none; border: 0; padding: 0; color: var(--muted-2); font-size: 13px; font-weight: 600; text-decoration: underline; cursor: pointer; }
.quiet-link:hover { color: var(--ink); }
.avatar { width: 72px; height: 72px; border-radius: 16px; background: var(--navy-2); border: 1px solid var(--line); display: grid; place-items: center; font: 900 28px "Archivo", sans-serif; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.profile-head { display: flex; gap: 18px; align-items: center; margin-bottom: 14px; }
.badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; background: #e6edff; color: var(--ink); vertical-align: middle; }
.badge.editorial { background: var(--mint); color: var(--mint-ink); }
.badge.off { background: var(--coral); color: var(--coral-ink); }
.badge.proof { background: var(--blue); color: #fff; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
.card .tags { font-size: 13px; color: var(--muted-2); margin: 8px 0 0; }
.proof-box { display: flex; align-items: center; gap: 12px; margin: 18px 0; padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: #f6f8fe; }
.proof-box a { font-weight: 600; }
.proof-shot { margin: 18px 0; }
.proof-shot img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: var(--radius); display: block; }
.proof-shot figcaption { margin-top: 8px; font-size: 13px; color: var(--muted); }
.board { display: flex; flex-direction: column; gap: 10px; }
.board-row { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--navy); text-decoration: none; color: var(--ink); }
.board-row:hover { border-color: var(--muted-2); }
.board-row .rank { font: 900 22px "Archivo", sans-serif; color: var(--muted-2); min-width: 34px; text-align: center; }
.board-row .who { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.board-row .who span { color: var(--muted); font-size: 13px; }
.board-row .nums { display: flex; flex-direction: column; align-items: flex-end; }
.board-row .nums span { color: var(--muted); font-size: 12px; white-space: nowrap; }
.comments { margin-top: 34px; }
.comment { border: 1px solid var(--line); border-radius: var(--radius); background: var(--navy); padding: 16px 18px; margin-bottom: 12px; }
.comment-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.comment-head div { display: flex; flex-direction: column; }
.comment-head span { color: var(--muted); font-size: 12px; }
.comment p { margin: 0 0 10px; }
.comment-foot { display: flex; gap: 14px; }
.like-btn.on { color: var(--mint); font-weight: 700; }
#comment-form textarea { width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: #f3f6fd; color: var(--ink); font: inherit; }
textarea::placeholder { color: var(--muted); opacity: 1; }
.save-report-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.save-report-row details { margin-top: 0; }
.report-box details { margin-top: 6px; }
.report-box summary { cursor: pointer; color: var(--muted-2); font-size: 13px; font-weight: 600; }
.report-box select, .report-box textarea { width: 100%; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: #f3f6fd; color: var(--ink); }
.report-box select option { color: #0b1b4d; background: #fff; }
.pager { display: flex; justify-content: center; gap: 10px; margin-top: 28px; }
.footer { margin-top: 64px; border-top: 1px solid var(--line); padding-top: 40px; }
.footer-cta { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 28px; align-items: center; background: var(--navy); border: 1px solid var(--line); border-radius: var(--radius); padding: 32px 36px; box-shadow: var(--shadow); }
.footer-cta h2 { margin: 0 0 8px; font-size: clamp(24px, 3.2vw, 34px); line-height: 1.05; font-weight: 900; text-transform: uppercase; letter-spacing: -0.03em; }
.footer-cta p { margin: 0; color: var(--muted); line-height: 1.5; max-width: 52ch; }
.footer-cta .eyebrow { margin-bottom: 10px; }
.cta.discord { white-space: nowrap; }
.cta.discord svg { width: 20px; height: 20px; }
.footer-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 28px 0 8px; }
.footer-links { display: flex; gap: 18px; flex-wrap: wrap; }
.footer-links a { color: var(--ink); text-decoration: none; font-weight: 600; font-size: 14px; }
.footer-links a:hover { color: var(--mint); text-decoration: underline; }
.strip { width: max-content; max-width: calc(100% - 24px); margin: 44px auto 0; border: 1px solid var(--line); border-radius: 999px; padding: 8px 14px; background: #f6f8fe; color: var(--muted); font-size: 12px; font-weight: 700; text-align: center; }

.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.card-head .who { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.2; }
.card-head .who b { font-size: 13px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-head .who span { font-size: 12px; color: var(--muted-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-head .tag { margin: 0; flex: 0 0 auto; }
.card .foot { flex-wrap: wrap; gap: 8px 12px; }
.card .counts { display: inline-flex; gap: 10px; color: var(--muted-2); font-weight: 600; }
.card .when { margin-left: auto; }
.creator-strip { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 8px; scrollbar-width: none; }
.creator-strip::-webkit-scrollbar { display: none; }
.creator-chip { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 10px; padding: 8px 14px 8px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--navy); text-decoration: none; }
.creator-chip:hover { border-color: var(--mint); }
.creator-chip span { display: flex; flex-direction: column; line-height: 1.15; }
.creator-chip b { font-size: 14px; }
.creator-chip small { color: var(--muted-2); font-size: 12px; }
.react-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 18px; }
.react-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; background: #f3f6fd; color: var(--ink); font-size: 13px; font-weight: 700; text-decoration: none; cursor: pointer; }
.react-btn .e { font-size: 15px; line-height: 1; }
.react-btn b { color: var(--muted-2); font-weight: 700; }
.react-btn b:empty { display: none; }
.react-btn:hover { border-color: var(--mint); }
.react-btn.on { background: var(--mint); border-color: var(--mint); color: var(--mint-ink); }
.react-btn.on b { color: var(--mint-ink); }
.react-btn:disabled { opacity: .6; cursor: default; }
.react-btn.muse-link { background: var(--blue); color: #fff; border-color: var(--blue); }
.react-btn.muse-link:hover { background: #e6edff; }
.profile-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.section-title .quiet-link { text-decoration: none; color: var(--muted-2); font-weight: 600; font-size: 13px; }
.section-title .quiet-link:hover { color: var(--ink); }
@media (max-width: 640px) { .profile-actions { margin-left: 0; width: 100%; } .card .when { margin-left: 0; } }

.nav-count { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; background: var(--tint); color: var(--blue-deep); font-size: 11px; font-weight: 700; vertical-align: 1px; }
.write-btn { display: inline-flex; align-items: center; padding: 9px 16px; border-radius: 8px; background: var(--blue); color: #fff; font-weight: 700; font-size: 14px; text-decoration: none; white-space: nowrap; margin-left: 8px; }
.write-btn:hover { background: #e6edff; }
.page-head { padding: 8px 0 26px; border-bottom: 1px solid var(--line); margin-bottom: 26px; }
.page-head h1, .page-head .h1-like { font-size: clamp(34px, 5vw, 60px); line-height: 1; font-weight: 900; text-transform: uppercase; letter-spacing: -0.035em; margin: 0 0 12px; }
.page-head .lead { margin: 0; }
.two-col { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 48px; align-items: start; }
.two-col .rail { position: sticky; top: 92px; display: grid; gap: 16px; border-left: 1px solid var(--line-soft); padding-left: 28px; }
.filter-row { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
.search-row { display: flex; gap: 8px; margin-bottom: 8px; }
.search-row input[type=search] { flex: 1; min-width: 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: #f3f6fd; color: var(--ink); }
.search-row input::placeholder { color: #98a2c3; }
.chip.solid[aria-current="true"] { background: var(--mint); color: var(--mint-ink); border-color: var(--mint); }
.rows { display: flex; flex-direction: column; }
.row, article.row { padding: 26px 0; border: 0; border-top: 1px solid var(--line-soft); border-radius: 0; background: transparent; box-shadow: none; }
.row > * { max-width: none; }
.row h2 a { color: inherit; }
.row .dek, .row-meta, .row-quote { color: var(--muted); }
.row:first-child, article.row:first-child { border-top: 0; padding-top: 10px; }
.row-who { display: inline-flex; align-items: center; gap: 10px; color: var(--muted); font-size: 14px; font-weight: 600; text-decoration: none; margin-bottom: 12px; }
.row-who:hover { color: var(--ink); }
.row h2 { margin: 0 0 8px; font-size: clamp(22px, 2.6vw, 30px); line-height: 1.12; letter-spacing: -0.025em; }
.row h2 a { text-decoration: none; }
.row h2 a:hover { color: var(--mint); }
.row .dek { margin: 0 0 12px; color: var(--muted); font-size: 16px; line-height: 1.55; max-width: 68ch; }
.row-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--muted-2); font-size: 13px; font-weight: 600; }
.row-meta .cat { color: var(--mint); text-decoration: none; }
.row-meta .save-btn.on { color: var(--mint); }
.row-quote { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 12px 16px; border-radius: 8px; background: #f3f6fd; color: var(--muted); font-size: 14px; text-decoration: none; max-width: 68ch; }
.row-quote:hover { background: #e6edff; color: var(--ink); }
.rank-list { list-style: none; margin: 0 0 8px; padding: 0; display: grid; gap: 10px; }
.rank-list li { display: flex; align-items: center; gap: 12px; font-size: 14px; }
.rank-list .rank { color: var(--muted-2); font: 700 14px "JetBrains Mono", monospace; width: 14px; }
.rank-list a { flex: 1; text-decoration: none; font-weight: 700; }
.rank-list a:hover { color: var(--mint); }
.rank-list .n { color: var(--muted-2); font-size: 12px; font-weight: 600; }
.rail-box.tint { background: #eef3ff; }
.rail-box.tint h3 { font-size: 22px; margin: 0 0 8px; }
.tint-panel { padding: 26px; border: 1px solid var(--line); border-radius: var(--radius); background: #f6f8fe; }
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.panel-head h2 { margin: 0 0 4px; font-size: 26px; }
.panel-head p { margin: 0; color: var(--muted); font-size: 14px; }
.top3 { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.top3-card { display: grid; gap: 12px; padding: 20px; background: var(--navy); text-decoration: none; border-left: 1px solid var(--line-soft); }
.top3-card:first-child { border-left: 0; }
.top3-card:hover { background: var(--navy-2); }
.top3-card .rank { font: 700 22px "JetBrains Mono", monospace; color: var(--mint); }
.top3-card .who { display: flex; align-items: center; gap: 10px; font-size: 16px; }
.top3-card small { color: var(--muted-2); font-size: 13px; font-weight: 600; }
.creator-rows { display: flex; flex-direction: column; border-top: 1px solid var(--line-soft); }
.creator-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 18px 0; border-bottom: 1px solid var(--line-soft); text-decoration: none; }
.creator-row:hover b { color: var(--mint); }
.creator-row .who { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.creator-row .who b { font: 700 20px "Archivo", sans-serif; letter-spacing: -0.02em; }
.creator-row .who .badge { width: max-content; }
.creator-row .stats { display: flex; gap: 28px; text-align: center; }
.creator-row .stats span { display: grid; gap: 2px; color: var(--muted-2); font-size: 12px; font-weight: 600; }
.creator-row .stats b { font: 700 20px "Archivo", sans-serif; color: var(--ink); }
.badge.soft { background: rgba(26,86,255,.1); color: var(--mint); text-transform: none; letter-spacing: 0; font-size: 12px; padding: 4px 10px; border-radius: 999px; }
.quote-band { margin: 48px calc(50% - 50vw) 0; padding: 56px calc(50vw - 50%); background: #f6f8fe; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 32px; flex-wrap: wrap; }
.quote-band p { margin: 0; font: 900 clamp(26px, 3.6vw, 44px)/1.05 "Archivo", sans-serif; letter-spacing: -0.03em; text-transform: uppercase; max-width: 22ch; }
.quote-band .hl { font-style: normal; background-image: linear-gradient(120deg, rgba(26,86,255,.22), rgba(26,86,255,.22)); background-repeat: no-repeat; background-size: 0% 100%; background-position: 0 0; padding: 0 .08em; margin: 0 -.08em; border-radius: 4px; transition: background-size 1.1s cubic-bezier(.2,.7,.2,1) .25s; }
.quote-band.seen .hl { background-size: 100% 100%; }
.quote-band .cta { position: relative; overflow: hidden; }
.quote-band .cta::after { content: ""; position: absolute; top: 0; bottom: 0; left: -60%; width: 40%; background: linear-gradient(100deg, transparent, rgba(255,255,255,.28), transparent); transform: skewX(-18deg); animation: quote-shine 9s ease-in-out infinite; animation-delay: 2.5s; }
@keyframes quote-shine { 0%, 88% { left: -60%; } 100% { left: 130%; } }
@media (prefers-reduced-motion: reduce) { .quote-band .hl { transition: none; background-size: 100% 100%; } .quote-band .cta::after { animation: none; } }
.profile-center { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 24px 0 30px; gap: 10px; }
.profile-center .avatar { width: 96px; height: 96px; border-radius: 50%; font-size: 34px; }
.profile-center h1 { margin: 6px 0 0; font-size: clamp(34px, 5vw, 56px); }
.profile-center .handle { margin: 0; color: var(--muted-2); font-weight: 600; }
.profile-center .bio { margin: 6px 0 0; color: var(--muted); font-size: 18px; line-height: 1.55; max-width: 56ch; }
.social-row { display: flex; gap: 18px; flex-wrap: wrap; justify-content: center; }
.social-row a { color: var(--mint); font-weight: 700; text-decoration: none; font-size: 14px; }
.profile-links { width: min(520px, 100%); margin: 6px 0 0; border-top: 1px solid var(--line); }
.profile-links a { display: flex; justify-content: space-between; align-items: center; padding: 12px 4px; border-bottom: 1px solid var(--line); color: var(--blue-deep); font-weight: 700; text-decoration: none; }
.profile-links a i { color: var(--muted-2); font-style: normal; }
.profile-links a:hover span { text-decoration: underline; }
.profile-stats { display: flex; gap: 22px; margin-top: 8px; color: var(--muted); font-size: 15px; }
.profile-stats b { color: var(--ink); }
.profile-center .profile-actions { margin: 10px 0 0; justify-content: center; }
.narrow { width: min(820px, 100%); margin: 0 auto; }
.callout.narrow { width: min(820px, 100%); margin: 0 auto 24px; }
.tabs { display: flex; gap: 22px; border-bottom: 1px solid var(--line); margin-bottom: 8px; }
.tab { background: none; border: 0; padding: 12px 2px; color: var(--muted); font-weight: 700; font-size: 15px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--mint); }
.about-box { padding: 22px 0; color: var(--muted); line-height: 1.6; }
.about-box p { margin: 0 0 12px; font-size: 16px; }
.about-box .muted { color: var(--muted-2); font-size: 14px; }
.about-box a { color: var(--mint); }
@media (max-width: 960px) { .two-col { grid-template-columns: 1fr; gap: 28px; } .two-col .rail { position: static; border-left: 0; padding-left: 0; } .top3 { grid-template-columns: 1fr; } .top3-card { border-left: 0; border-top: 1px solid var(--line-soft); } .top3-card:first-child { border-top: 0; } .creator-row { grid-template-columns: auto minmax(0, 1fr); } .creator-row .stats { grid-column: 1 / -1; justify-content: flex-start; } }
@media (max-width: 720px) { .footer-cta { grid-template-columns: 1fr; padding: 24px; } .cta.discord { width: 100%; } .strip { white-space: normal; } }
@media (max-width: 960px) { .layout { grid-template-columns: 1fr; } .rail { position: static; } .hero { grid-template-columns: 1fr; } }
@media (max-width: 640px) {
  .write-long { display: none; } .topbar { gap: 6px; padding-top: 10px; padding-bottom: 10px; } .brand { order: 0; font-size: 14px; gap: 6px; } .account, .acct { margin-left: 0 !important; } .menu-toggle { margin-left: 0 !important; } .brand .mark { width: 18px; height: 18px; } .menu-toggle { width: 38px; height: 38px; } .acct-btn { padding: 3px; gap: 0; } .acct-btn img, .acct-btn i { width: 24px; height: 24px; } .signin-btn { padding: 7px 10px; font-size: 13px; } .write-btn { order: 1; margin-left: auto; padding: 7px 9px; font-size: 13px; } .acct { order: 2; margin-left: 0; } .acct-btn svg { display: none; } .account { order: 2; } .menu-toggle { order: 3; margin-left: 4px; } #account-slot, .signin-btn { order: 2; } .nav { order: 5; }
  .shell { width: calc(100% - 32px); }
  .topbar { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; padding: 14px calc(50vw - 50%); margin: 0 calc(50% - 50vw) 28px; }
  .menu-toggle { display: flex; }
  .nav { display: none; flex-direction: column; width: 100%; flex-basis: 100%; margin: 4px 0 0; padding: 8px 0 4px; border-top: 1px solid var(--line-soft); overflow: visible; }
  .topbar.open .nav { display: flex; }
  .nav a { width: 100%; text-align: left; padding: 12px 10px; font-size: 16px; }
  .steps li { grid-template-columns: 28px 1fr; padding: 12px; }
  .stat-row { grid-template-columns: repeat(3, 1fr); }
}


.acct { position: relative; margin-left: 8px; }
.acct-btn { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px 4px 4px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--ink); font: 600 13px/1 "IBM Plex Sans", system-ui, sans-serif; cursor: pointer; }
.acct-btn:hover, .acct-btn[aria-expanded="true"] { border-color: var(--blue); }
.acct-btn img, .acct-btn i { width: 28px; height: 28px; border-radius: 50%; background: var(--tint); color: var(--blue-deep); display: inline-grid; place-items: center; font: 700 11px "Archivo", sans-serif; font-style: normal; overflow: hidden; }
.acct-btn img { object-fit: cover; }
.acct-btn .who { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acct-btn svg { width: 14px; height: 14px; color: var(--muted-2); }
.acct-menu { position: absolute; right: 0; top: calc(100% + 8px); min-width: 210px; padding: 6px; background: #fff; border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 12px 32px rgba(11,18,32,.12); z-index: 40; display: grid; }
.acct-menu[hidden] { display: none; }
.acct-menu a, .acct-menu button { display: block; width: 100%; text-align: left; padding: 10px 12px; border: 0; border-radius: 6px; background: none; color: var(--ink); font: 500 14px/1.2 "IBM Plex Sans", system-ui, sans-serif; text-decoration: none; cursor: pointer; }
.acct-menu a:hover, .acct-menu button:hover { background: var(--tint); color: var(--blue-deep); }
.acct-menu .sep { height: 1px; margin: 6px 4px; background: var(--line-soft); }
.acct-menu small { display: block; padding: 8px 12px 4px; color: var(--muted-2); font-size: 12px; }
@media (max-width: 640px) { .acct-btn .who { display: none; } .acct { order: 2; } }

.wild-cats { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; margin-bottom: 36px; }
.wild-tile { display: grid; gap: 6px; padding: 18px; border: 1px solid var(--line); border-radius: 10px; background: #fff; text-decoration: none; }
.wild-tile:hover { border-color: var(--blue); }
.wild-tile b { font: 700 18px "Archivo", sans-serif; letter-spacing: -0.02em; }
.wild-tile span { color: var(--muted); font-size: 14px; line-height: 1.45; }
.wild-tile small { color: var(--blue-deep); font-weight: 700; font-size: 12px; }
.wild-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 18px; align-items: start; }
.wild-grid.compact { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.wild-add { display: grid; grid-template-columns: 1fr 1.2fr; gap: 20px; align-items: center; padding: 22px 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--tint); margin-bottom: 30px; }
.wild-add h2 { margin: 0 0 6px; font: 700 20px "Archivo", sans-serif; letter-spacing: -0.02em; }
.wild-add p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.wild-add .cta { display: inline-block; padding: 10px 18px; border-radius: 8px; background: var(--blue); color: #fff; font-weight: 700; font-size: 14px; text-decoration: none; border: 0; cursor: pointer; }
.wild-add .cta:hover { background: var(--blue-deep); color: #fff; }
.wild-add .cta:disabled { opacity: .6; cursor: default; }
.wild-add-row { display: flex; gap: 10px; margin-top: 10px; }
.wild-add-row input { flex: 1; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 14px; }
.wild-add label { font-weight: 700; font-size: 13px; }
.wild-add-note { margin-top: 8px; font-size: 12px; }
.wild-add-status { margin-top: 8px; font-size: 13px; font-weight: 600; min-height: 18px; }
@media (max-width: 720px) { .wild-add { grid-template-columns: 1fr; } }
.post { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.post-caption { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.post-caption h3 { margin: 0; font: 700 15px/1.3 "IBM Plex Sans", system-ui, sans-serif; letter-spacing: 0; color: var(--muted); }
.post-caption h3 a { text-decoration: none; }
.post-caption h3 a:hover { color: var(--blue-deep); }
.post-cat { flex: 0 0 auto; padding: 3px 9px; border-radius: 999px; background: var(--tint); color: var(--blue-deep); font-size: 12px; font-weight: 700; text-decoration: none; }
.tweet { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px 14px; border: 1px solid #e3e6ea; border-radius: 16px; background: #fff; color: #0f1419; box-shadow: 0 1px 2px rgba(11,18,32,.04); font-family: "IBM Plex Sans", system-ui, sans-serif; }
.tweet-head { display: flex; align-items: center; gap: 10px; }
.tweet-avatar { width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(135deg, #1a56ff, #7aa2ff); color: #fff; display: grid; place-items: center; font: 700 14px "Archivo", sans-serif; flex: 0 0 auto; }
img.tweet-avatar { object-fit: cover; background: #eff3f4; }
.tweet-verified { width: 16px; height: 16px; vertical-align: -3px; margin-left: 3px; }
.tweet-media { display: grid; gap: 3px; border-radius: 14px; overflow: hidden; border: 1px solid #e3e6ea; position: relative; }
.tweet-media img { width: 100%; height: 100%; object-fit: cover; display: block; background: #eff3f4; }
.tweet-media.n1 img { max-height: 420px; }
.tweet-media.n2, .tweet-media.n3, .tweet-media.n4 { grid-template-columns: 1fr 1fr; }
.tweet-media.n2 img, .tweet-media.n3 img, .tweet-media.n4 img { height: 180px; }
.tweet-media.n3 img:first-child { grid-row: span 2; height: 100%; }
.tweet-media .play { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: 26px; text-shadow: 0 2px 10px rgba(0,0,0,.5); }
.tweet-media .play::before { content: ""; position: absolute; width: 64px; height: 64px; border-radius: 50%; background: rgba(15,20,25,.7); z-index: -1; }
.tweet-names { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.25; }
.tweet-names b { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tweet-names span { font-size: 14px; color: #536471; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tweet-mark { flex: 0 0 auto; color: #0f1419; display: inline-grid; place-items: center; }
.tweet-mark svg { width: 20px; height: 20px; }
.tweet-site { font-size: 12px; font-weight: 700; color: #536471; }
.tweet-text { margin: 0; font-size: 16px; line-height: 1.5; color: #0f1419; white-space: pre-line; overflow-wrap: anywhere; }
.tweet.summary .tweet-text { color: #3a4550; }
.tweet-summary-note { margin: -4px 0 0; font-size: 13px; color: #536471; }
.tweet-summary-note a { color: var(--blue-deep); }
.tweet-prompt { border: 1px solid #e3e6ea; border-radius: 12px; padding: 0 12px; background: #f7f9f9; }
.tweet-prompt summary { cursor: pointer; padding: 10px 0; font-weight: 700; font-size: 13px; color: var(--blue-deep); }
.tweet-prompt pre { margin: 0 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; font: 500 13px/1.5 "JetBrains Mono", monospace; color: #0f1419; }
.tweet-prompt .cta { margin-bottom: 12px; padding: 8px 14px; font-size: 13px; }
.tweet-actions { display: flex; align-items: center; gap: 22px; padding-top: 8px; border-top: 1px solid #eff3f4; color: #536471; font-size: 13px; }
.tweet-actions > span { display: inline-flex; align-items: center; gap: 6px; }
.tweet-actions svg { width: 18px; height: 18px; }
.tweet-submitter { font-size: 12px; }
.tweet-submitter a { color: inherit; font-weight: 600; }
.tweet-nostats { font-size: 12px; }
.tweet-open { margin-left: auto; color: var(--blue-deep); font-weight: 600; text-decoration: none; white-space: nowrap; }
.tweet-open:hover { text-decoration: underline; }
.wild-faq { margin-top: 44px; padding-top: 24px; border-top: 1px solid var(--line); max-width: 760px; }
.wild-faq h2 { font-size: 26px; margin: 0 0 8px; }
.wild-faq details { border-bottom: 1px solid var(--line-soft); }
.wild-faq summary { cursor: pointer; padding: 14px 0; font-weight: 700; }
.wild-faq p { margin: 0 0 16px; color: var(--muted); line-height: 1.6; }
.wild-disclaimer { margin-top: 36px; color: var(--muted-2); font-size: 13px; line-height: 1.5; }
.row.wild-row { padding: 0; border-top: 0; margin: 8px 0 18px; }
.row.wild-row .tweet { max-width: 640px; }
.row.wild-row .wild-label { display: block; margin: 18px 0 8px; color: var(--blue-deep); font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
/* Light theme: white ground, ink text, blue for actions and active states. */
body { background-image: none; }
.topbar { border-bottom-color: var(--line); }
.topbar.scrolled { background: rgba(255,255,255,.9); box-shadow: 0 10px 30px rgba(11,18,32,.06); }
.button, .cta, .write-btn, .btn.primary, .icon-button, .case-link, .add { background: var(--blue); color: #fff; border-color: var(--blue); }
.button:hover, .cta:hover, .write-btn:hover, .btn.primary:hover, .icon-button:hover, .react-btn.muse-link:hover, .case-link:hover, .add:hover { background: var(--blue-deep); border-color: var(--blue-deep); color: #fff; }
.button.ghost, .cta.ghost, .case-link.quiet { background: transparent; color: var(--blue-deep); border-color: var(--blue); }
.button.ghost:hover, .cta.ghost:hover, .case-link.quiet:hover { background: var(--tint); color: var(--blue-deep); border-color: var(--blue); }
.button.secondary, .button.small.secondary { background: var(--tint); color: var(--blue-deep); border: 2px solid var(--line); }
.button.secondary:hover { background: #e0e8ff; }
.button.discord, .cta.discord { background: var(--blue); color: #fff; }
.case-study { border: 1px solid var(--line); }
.nav a[aria-current="page"], .nav button[aria-selected="true"] { background: var(--tint); color: var(--blue-deep); border-color: transparent; }
.nav a:hover, .nav button:hover { color: var(--blue-deep); border-color: var(--line); }
.chip[aria-current="true"], .chip.solid[aria-current="true"] { background: var(--blue); color: #fff; border-color: var(--blue); }
.chip { background: #fff; border-color: var(--line); color: var(--muted); }
.chip:hover { color: var(--blue-deep); border-color: var(--blue); }
.follow-btn.on, .react-btn.on, .star.picked, .pill.published { background: var(--blue); color: #fff; border-color: var(--blue); }
.follow-btn.on b, .react-btn.on b { color: #fff; }
.save-icon.on { color: var(--blue); border-color: var(--blue); }
.badge.editorial, .badge.soft, .rating .new, .fmeta .new, .pool-tag.open, .case-tag { background: var(--tint); color: var(--blue-deep); }
.badge.off, .pool-tag.pulled { background: rgba(217,45,32,.1); color: var(--coral); }
.eyebrow, .card-label, .k, .live-tag { color: var(--blue-deep); }
.mini-number, .steps li::before { color: #fff; }
.quote-band, .tint-panel, .home-card.tint, .rail-box.tint, .callout { background: var(--tint); }
.preview-strip, .strip, .pool-list, .signin-card, .field input, .field select, .field textarea, .toolbar input, .search-row input, .report-box select, .report-box textarea, .invite-card, .home-card, .workflow-card, .rail-box, .card, .post, article, .panel, .item, .footer-cta, .nudge-card, .hero-aside, .stat, .comment { background: #fff; }
.field input::placeholder, .field textarea::placeholder, .toolbar input::placeholder, .search-row input::placeholder { color: #98a2c3; }
.prompt, .row-quote, .steps li, .code-row .preview-code, .assigned-code, .pool-health span, .top3-card, .creator-cell, .creator-chip, .about-box, .react-btn, .sharekit { background: #f6f8fe; }
.react-btn.muse-link { background: var(--blue); color: #fff; }
.nudge-backdrop { background: rgba(11,18,32,.5); }
.account-chip .who, .account .linklike, .account-slot a, .account-slot button { color: var(--muted); }
.message, .success-panel { background: rgba(26,86,255,.08); border-color: rgba(26,86,255,.35); }
.avatar { background: var(--tint); color: var(--blue-deep); border-color: var(--line); }
.brand { color: var(--ink); }
@media (prefers-reduced-motion: reduce) { .menu-toggle span { transition: none; } }
`;

const NAV = [
  ["/", "Home"],
  ["/workflows", "Feed"],
  ["/posts", "Social", "count"],
  ["/creators", "Creators"],
  ["/blog", "Blog"],
  ["/creator", "Profile"],
];

// The Social tab carries the number of public posts. Read lazily so the
// layout module does not load the dataset until a page is rendered.
function socialCount() {
  try { return require("./wild").load().total; } catch (_) { return ""; }
}
const FOOTER_CSS = ".site-footer { margin: 72px calc(50% - 50vw) -48px; padding: 56px calc(50vw - 50%) 36px; background: #0b1220; color: #fff; }\n.footer-grid { display: grid; grid-template-columns: 1fr 1.15fr 2fr; gap: 40px 48px; max-width: 1180px; margin: 0 auto; }\n.footer-col h3 { margin: 0 0 12px; font: 600 13px/1 \"IBM Plex Sans\", system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: #8e98b3; }\n.footer-col > a:not(.footer-brand), .footer-two a { display: block; padding: 5px 0; color: #d7deee; text-decoration: none; font-size: 15px; line-height: 1.4; }\n.footer-col > a:hover, .footer-two a:hover { color: #fff; text-decoration: underline; text-underline-offset: 3px; }\n.footer-brand { display: inline-flex; align-items: center; gap: 10px; margin: 0 0 24px; color: #fff; text-decoration: none; font: 900 16px/1 \"Archivo\", sans-serif; letter-spacing: -0.02em; text-transform: uppercase; }\n.footer-brand .mark { width: 20px; height: 20px; }\n.footer-about p { margin: 0 0 16px; color: #c9d1e3; font-size: 15px; line-height: 1.6; max-width: 60ch; }\n.footer-two { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }\n.footer-fine { font-size: 13px !important; color: #8e98b3 !important; margin: 20px 0 10px !important; }\n.footer-meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; font-size: 13px; color: #aab3c8; }\n.footer-meta a { color: #fff; text-decoration: none; }\n.footer-meta a:hover { text-decoration: underline; }\n@media (max-width: 900px) { .footer-grid { grid-template-columns: 1fr 1fr; } .footer-about { grid-column: 1 / -1; } }\n@media (max-width: 560px) { .site-footer { padding-top: 40px; } .footer-grid { grid-template-columns: 1fr; gap: 32px; } .footer-two { grid-template-columns: 1fr; } }";
function header(current) {
  const links = NAV.map(([href, label, extra]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${label}${extra === "count" ? `<span class="nav-count">${socialCount()}</span>` : ""}</a>`).join("\n          ");
  return `<header class="topbar">
        <a class="brand" href="/">${MARK}Built with Muse</a>
        <button class="menu-toggle" id="menu-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Open menu"><span></span><span></span><span></span></button>
        <nav class="nav" id="site-nav" aria-label="Site">
          ${links}
        </nav>
        <a class="write-btn" href="/creator#new">Publish<span class="write-long">&nbsp;a workflow</span></a>
        <span class="account-slot" id="account-slot"></span>
      </header>`;
}

function footer() {
  return `<footer class="site-footer">
      <div class="footer-grid">
        <div class="footer-col">
          <a class="footer-brand" href="/"><svg class="mark" viewBox="0 0 9 9" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M4 0h1v1H4zM1 1h1v1H1zM4 1h1v1H4zM7 1h1v1H7zM2 2h1v1H2zM4 2h1v1H4zM6 2h1v1H6zM3 3h1v1H3zM4 3h1v1H4zM5 3h1v1H5zM0 4h1v1H0zM1 4h1v1H1zM2 4h1v1H2zM3 4h1v1H3zM4 4h1v1H4zM5 4h1v1H5zM6 4h1v1H6zM7 4h1v1H7zM8 4h1v1H8zM3 5h1v1H3zM4 5h1v1H4zM5 5h1v1H5zM2 6h1v1H2zM4 6h1v1H4zM6 6h1v1H6zM1 7h1v1H1zM4 7h1v1H4zM7 7h1v1H7zM4 8h1v1H4z"/></svg>Built with Muse</a>
          <h3>Directory</h3>
          <a href="/">Get a code</a><a href="/#share">Share a code</a><a href="/workflows">Feed</a><a href="/posts">Social</a><a href="/creators">Creators</a><a href="/use-cases">Use cases</a><a href="/blog">Blog</a><a href="/creator#new">Publish a workflow</a><a href="/#mycodes">My codes</a>
        </div>
        <div class="footer-col">
          <h3>Social posts</h3>
          <a href="/posts/paying-bills">Paying bills</a><a href="/posts/spending-money">Where people spend money</a><a href="/posts/educational">Educational</a><a href="/posts/job-apply">Job applications</a><a href="/posts/dating">Dating</a><a href="/posts/travel">Travel</a><a href="/posts/food">Food</a><a href="/posts/home-and-family">Home and family</a><a href="/posts/health">Health</a><a href="/posts/work">Work</a><a href="/posts/calls-and-admin">Calls and paperwork</a><a href="/posts/fun">Fun</a>
        </div>
        <div class="footer-col footer-about">
          <h3>About</h3>
          <p>A community pool of Muse invite codes, and the workflows people build with Muse, Meta&#8217;s personal AI agent. Codes come from members who pass their invites on. Every post links to its source.</p>
          <div class="footer-two"><a href="/about">About</a><a href="/privacy">Privacy</a><a href="/blog/what-is-meta-muse">What is Meta Muse</a><a href="/blog/free-muse-invite-code">Free Muse invite code</a><a href="/blog/how-to-use-meta-muse-outside-us">Muse outside the US</a><a href="/blog/muse-vs-chatgpt">Muse vs ChatGPT</a><a href="/blog/muse-tokens-explained">Muse tokens explained</a><a href="mailto:polostudio.brand@gmail.com?subject=Sponsoring%20Built%20with%20Muse">Sponsor</a><a href="mailto:polostudio.brand@gmail.com">Contact</a><a href="https://usesundog.com/muse">Sundog workflow library &#8599;</a></div>
          <p class="footer-fine">Independent community project. Not affiliated with or endorsed by Meta. Token amounts are as Muse announced them.</p>
          <div class="footer-meta"><span>Made by <a href="/about">Pranav More and Jayesh Marathe</a></span><span aria-hidden="true">&#183;</span><span>&#169; 2026 Built with Muse</span></div>
        </div>
      </div>
    </footer>`;
}

const HEAD_SCRIPTS = `
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-C94847V6DS"></script>
    <script>window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag('js', new Date()); gtag('config', 'G-C94847V6DS');</script>
    <script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "ylnjyde5d9");</script>
    <script>window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };</script>
    <script defer src="/_vercel/insights/script.js"></script>`;

const MENU_SCRIPT = `<script>
      (() => {
        const bar = document.querySelector(".topbar");
        const toggle = document.getElementById("menu-toggle");
        if (!bar || !toggle) return;
        const set = (open) => { bar.classList.toggle("open", open); toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu"); };
        toggle.addEventListener("click", () => set(!bar.classList.contains("open")));
        bar.querySelectorAll(".nav a").forEach((item) => item.addEventListener("click", () => set(false)));
        document.addEventListener("keydown", (event) => { if (event.key === "Escape") set(false); });
        const onScroll = () => bar.classList.toggle("scrolled", window.scrollY > 8);
        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
      })();
    </script>`;

// One full page. `body` is the inside of <main>; `script` is inline page JS.
function layout({ title, description, path, ogType = "website", ogImage, jsonld, noindex = false, current, body, script = "", extraCss = "" }) {
  script = script + (arguments[0].extraScript || "");
  const canonical = SITE + path;
  const image = ogImage || SITE + "/og/home.png";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#ffffff" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    ${noindex ? '<meta name="robots" content="noindex, nofollow" />' : ""}
    <link rel="canonical" href="${esc(canonical)}" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta property="og:type" content="${ogType}" />
    <meta property="og:image" content="${esc(image)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${esc(image)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;900&family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" />
    <style>${CSS}${extraCss}</style><style>${FOOTER_CSS}</style>${HEAD_SCRIPTS}
    ${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}
  </head>
  <body>
    <div class="shell">
      ${header(current)}
      <main>
${body}
      </main>
      ${footer()}
    </div>
    ${MENU_SCRIPT}
    <script>(() => { const band = document.getElementById("quote-band"); if (!band) return; if (!("IntersectionObserver" in window)) { band.classList.add("seen"); return; } const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { band.classList.add("seen"); io.disconnect(); } }, { threshold: 0.4 }); io.observe(band); })();</script>
    ${script ? `<script>${script}</script>` : ""}
  </body>
</html>`;
}

module.exports = { layout, esc, SITE, MARK };
