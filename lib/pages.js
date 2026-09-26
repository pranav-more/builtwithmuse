"use strict";

// Server rendered pages for the Creator Pool: the workflow index, workflow
// detail pages and creator profiles. They share the site's Carbon Blue look
// (same tokens, header and footer as the static pages) so a visitor cannot
// tell a rendered page from a static one.

const MARK = '<svg class="mark" viewBox="0 0 9 9" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M4 0h1v1H4zM1 1h1v1H1zM4 1h1v1H4zM7 1h1v1H7zM2 2h1v1H2zM4 2h1v1H4zM6 2h1v1H6zM3 3h1v1H3zM4 3h1v1H4zM5 3h1v1H5zM0 4h1v1H0zM1 4h1v1H1zM2 4h1v1H2zM3 4h1v1H3zM4 4h1v1H4zM5 4h1v1H5zM6 4h1v1H6zM7 4h1v1H7zM8 4h1v1H8zM3 5h1v1H3zM4 5h1v1H4zM5 5h1v1H5zM2 6h1v1H2zM4 6h1v1H4zM6 6h1v1H6zM1 7h1v1H1zM4 7h1v1H4zM7 7h1v1H7zM4 8h1v1H4z"/></svg>';
const DISCORD = "https://discord.gg/wQEeXXntjs";
const SITE = "https://builtwithmuse.com";

function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const CSS = `
:root { color-scheme: dark; --blue: #1a56ff; --blue-deep: #0b2a8a; --navy: #0d1b3d; --navy-2: #13275f; --ink: #ffffff; --muted: #c7d6ff; --muted-2: #9fb6ff; --line: rgba(255,255,255,.22); --line-soft: rgba(255,255,255,.12); --mint: #7dffc6; --mint-ink: #06331f; --coral: #ff8f8f; --coral-ink: #3d0808; --paper: #ffffff; --paper-ink: #0b1b4d; --paper-muted: #45538a; --paper-line: #c9d4f2; --shadow: 0 30px 60px rgba(0,0,0,.35); --radius: 10px; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; color: var(--ink); background-color: var(--blue);
  background-image: linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.028) 1px, transparent 1px), linear-gradient(45deg, rgba(0,0,0,.14) 25%, transparent 25%, transparent 50%, rgba(0,0,0,.14) 50%, rgba(0,0,0,.14) 75%, transparent 75%), linear-gradient(-45deg, rgba(0,0,0,.14) 25%, transparent 25%, transparent 50%, rgba(0,0,0,.14) 50%, rgba(0,0,0,.14) 75%, transparent 75%);
  background-size: 48px 48px, 48px 48px, 6px 6px, 6px 6px; font-family: "IBM Plex Sans", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
h1, h2, h3 { font-family: "Archivo", sans-serif; letter-spacing: -0.025em; text-wrap: balance; }
.shell { width: min(1180px, calc(100% - 40px)); margin: 0 auto; padding: 0 0 48px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 20px 0; border-bottom: 1px solid var(--line); margin-bottom: 40px; }
.topbar { position: sticky; top: 0; z-index: 30; margin: 0 calc(50% - 50vw) 40px; padding: 16px calc(50vw - 50%); background: transparent; transition: background .25s ease, backdrop-filter .25s ease, box-shadow .25s ease; }
.topbar.scrolled { background: rgba(26,86,255,.5); backdrop-filter: blur(14px) saturate(140%); -webkit-backdrop-filter: blur(14px) saturate(140%); box-shadow: 0 10px 30px rgba(6,16,48,.18); }
.brand { font: 900 18px/1 "Archivo", sans-serif; letter-spacing: -0.02em; text-transform: uppercase; text-decoration: none; white-space: nowrap; display: inline-flex; align-items: center; gap: 10px; }
.brand .mark { width: 22px; height: 22px; flex: 0 0 auto; }
.nav { display: flex; gap: 4px; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.nav::-webkit-scrollbar { display: none; }
.nav a { flex: 0 0 auto; border: 1px solid transparent; border-radius: 8px; padding: 9px 13px; color: var(--muted); font-size: 14px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.nav a:hover { color: var(--ink); border-color: var(--line); }
.nav a[aria-current="page"] { background: rgba(255,255,255,.14); color: var(--ink); border-color: var(--line); }
.account-slot { display: inline-flex; align-items: center; gap: 2px; margin-left: 8px; }
.account-slot img { width: 28px; height: 28px; border-radius: 50%; }
.account-slot a, .account-slot button { color: var(--muted); font-size: 14px; font-weight: 600; text-decoration: none; padding: 9px 8px; white-space: nowrap; background: none; border: 0; cursor: pointer; font-family: inherit; }
.account-slot a:hover, .account-slot button:hover { color: var(--ink); }
.nav a:focus-visible, .cta:focus-visible, .card:focus-visible, .menu-toggle:focus-visible, .star:focus-visible, .chip:focus-visible, .field input:focus-visible, .field textarea:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
.menu-toggle { display: none; width: 44px; height: 44px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.08); padding: 0; flex-direction: column; align-items: center; justify-content: center; gap: 5px; }
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
.cta { display: inline-flex; align-items: center; justify-content: center; gap: 10px; padding: 13px 20px; border-radius: 8px; background: var(--paper); color: var(--blue-deep); text-decoration: none; font-weight: 700; border: 2px solid var(--paper); }
.cta:hover { background: #eaf0ff; }
.cta.ghost { background: transparent; color: var(--ink); border-color: rgba(255,255,255,.7); }
.cta.ghost:hover { background: rgba(255,255,255,.12); }
.cta.full { width: 100%; }
.cta:disabled { opacity: .6; cursor: default; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; margin: 0 0 24px; }
.toolbar form { display: flex; gap: 8px; flex: 1 1 320px; }
.toolbar input[type=search] { flex: 1; min-width: 0; padding: 11px 14px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.06); color: var(--ink); }
.toolbar input::placeholder { color: rgba(199,214,255,.6); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; padding: 8px 12px; border: 1px solid var(--line-soft); border-radius: 999px; background: rgba(255,255,255,.06); color: var(--muted); font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.chip:hover { color: var(--ink); border-color: var(--line); }
.chip[aria-current="true"] { background: var(--paper); color: var(--blue-deep); border-color: var(--paper); }
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
.rating .new { display: inline-block; padding: 2px 8px; border-radius: 4px; background: rgba(125,255,198,.16); color: var(--mint); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
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
.steps li { counter-increment: step; display: grid; grid-template-columns: 34px 1fr; gap: 14px; align-items: start; padding: 14px 16px; border: 1px solid var(--line-soft); border-radius: 8px; background: rgba(255,255,255,.04); margin: 0; }
.steps li::before { content: counter(step); width: 30px; height: 30px; border-radius: 50%; background: var(--blue); color: var(--ink); display: grid; place-items: center; font-weight: 700; font-size: 13px; }
.steps li strong { display: block; margin-bottom: 4px; }
.prompt { position: relative; padding: 18px 20px; border-radius: 8px; background: rgba(255,255,255,.06); border: 1px solid var(--line-soft); font: 500 15px/1.6 "JetBrains Mono", monospace; color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 20px; }
.prompt-block { margin: 0; padding: 30px 0 8px; border-bottom: 1px solid var(--line); margin-bottom: 30px; }
.prompt-block .k { color: var(--muted-2); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 12px; }
.prompt-actions { display: flex; align-items: center; gap: 14px; margin: 0 0 10px; flex-wrap: wrap; }
.prompt-hint { color: var(--muted); font-size: 14px; margin: 0 0 6px; }
.prompt-quote { color: var(--muted-2); font-size: 14px; font-style: italic; margin: 0 0 16px; }
.save-below { margin: 28px 0; padding: 20px 22px; border: 1px solid var(--line); border-radius: var(--radius); background: rgba(255,255,255,.04); display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.follow-btn { background: rgba(255,255,255,.08); border: 1px solid var(--line); color: var(--ink); border-radius: 999px; padding: 4px 14px; font-size: 12px; font-weight: 700; letter-spacing: .04em; cursor: pointer; font-family: inherit; }
.follow-btn:hover:not(:disabled) { border-color: var(--mint); color: var(--mint); }
.follow-btn.on { background: var(--mint); border-color: var(--mint); color: var(--mint-ink); }
.follow-btn.lg { padding: 10px 22px; font-size: 14px; }
.follow-btn:disabled { opacity: .6; cursor: default; }
.callout { padding: 18px 22px; border: 1px solid rgba(125,255,198,.45); border-radius: 8px; background: rgba(125,255,198,.1); margin: 24px 0; color: var(--ink); }
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
.stat { padding: 12px 10px; border: 1px solid var(--line-soft); border-radius: 8px; background: rgba(255,255,255,.05); text-align: center; }
.stat b { display: block; font: 700 22px/1.1 "Archivo", sans-serif; }
.stat span { display: block; color: var(--muted-2); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin-top: 4px; }
.rate { display: grid; gap: 10px; }
.stars-input { display: flex; gap: 4px; }
.star { width: 40px; height: 40px; border: 1px solid var(--line-soft); border-radius: 8px; background: rgba(255,255,255,.05); color: var(--muted-2); font-size: 20px; display: grid; place-items: center; }
.star:hover, .star.lit { color: var(--mint); border-color: var(--mint); }
.star.picked { background: var(--mint); color: var(--mint-ink); border-color: var(--mint); }
.rate-status { min-height: 20px; color: var(--muted); font-size: 14px; font-weight: 600; }
.rate-status.err { color: var(--coral); }
.quiet-link { background: none; border: 0; padding: 0; color: var(--muted-2); font-size: 13px; font-weight: 600; text-decoration: underline; cursor: pointer; }
.quiet-link:hover { color: var(--ink); }
.avatar { width: 72px; height: 72px; border-radius: 16px; background: var(--navy-2); border: 1px solid var(--line); display: grid; place-items: center; font: 900 28px "Archivo", sans-serif; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.profile-head { display: flex; gap: 18px; align-items: center; margin-bottom: 14px; }
.badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; background: rgba(255,255,255,.14); color: var(--ink); vertical-align: middle; }
.badge.editorial { background: var(--mint); color: var(--mint-ink); }
.badge.off { background: var(--coral); color: var(--coral-ink); }
.badge.proof { background: var(--blue); color: #fff; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
.card .tags { font-size: 13px; color: var(--muted-2); margin: 8px 0 0; }
.proof-box { display: flex; align-items: center; gap: 12px; margin: 18px 0; padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: rgba(255,255,255,.05); }
.proof-box a { font-weight: 600; }
.proof-shot { margin: 18px 0; }
.proof-shot img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: var(--radius); display: block; }
.proof-shot figcaption { margin-top: 8px; font-size: 13px; color: var(--muted); }
.save-row { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.save-nudge { margin: 26px 0; padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--radius); background: rgba(255,255,255,.05); display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.save-nudge p { margin: 0; font-size: 14px; }
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
#comment-form textarea { width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.06); color: var(--ink); font: inherit; }
.report-box details { margin-top: 6px; }
.report-box summary { cursor: pointer; color: var(--muted-2); font-size: 13px; font-weight: 600; }
.report-box select, .report-box textarea { width: 100%; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.06); color: var(--ink); }
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
.strip { width: max-content; max-width: calc(100% - 24px); margin: 44px auto 0; border: 1px solid var(--line); border-radius: 999px; padding: 8px 14px; background: rgba(6,16,48,.6); color: var(--muted); font-size: 12px; font-weight: 700; text-align: center; }
@media (max-width: 720px) { .footer-cta { grid-template-columns: 1fr; padding: 24px; } .cta.discord { width: 100%; } .strip { white-space: normal; } }
@media (max-width: 960px) { .layout { grid-template-columns: 1fr; } .rail { position: static; } .hero { grid-template-columns: 1fr; } }
@media (max-width: 640px) {
  .shell { width: calc(100% - 32px); }
  .topbar { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; padding: 14px calc(50vw - 50%); margin: 0 calc(50% - 50vw) 28px; }
  .menu-toggle { display: flex; }
  .nav { display: none; flex-direction: column; width: 100%; flex-basis: 100%; margin: 4px 0 0; padding: 8px 0 4px; border-top: 1px solid var(--line-soft); overflow: visible; }
  .topbar.open .nav { display: flex; }
  .nav a { width: 100%; text-align: left; padding: 12px 10px; font-size: 16px; }
  .steps li { grid-template-columns: 28px 1fr; padding: 12px; }
  .stat-row { grid-template-columns: repeat(3, 1fr); }
}
@media (prefers-reduced-motion: reduce) { .menu-toggle span { transition: none; } }
`;

const NAV = [
  ["/", "Get a code"],
  ["/workflows", "Workflows"],
  ["/creators", "Creators"],
  ["/use-cases", "Use cases"],
  ["/blog", "Blog"],
  ["/creator", "Publish"],
];

function header(current) {
  const links = NAV.map(([href, label]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${label}</a>`).join("\n          ");
  return `<header class="topbar">
        <a class="brand" href="/">${MARK}Built with Muse</a>
        <button class="menu-toggle" id="menu-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Open menu"><span></span><span></span><span></span></button>
        <nav class="nav" id="site-nav" aria-label="Site">
          ${links}
        </nav>
        <span class="account-slot" id="account-slot"></span>
      </header>`;
}

function footer() {
  return `<footer class="footer">
        <div class="footer-cta">
          <div>
            <div class="eyebrow">Join the community</div>
            <h2>See what other people are building with Muse.</h2>
            <p>Trade codes, swap workflows and get help from people who are already inside.</p>
          </div>
          <a class="cta discord" href="${DISCORD}" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.6 5.6A16.3 16.3 0 0 0 15.5 4.3l-.5 1a15 15 0 0 0-4 0l-.5-1a16.2 16.2 0 0 0-4.1 1.3C3.8 9.5 3.1 13.3 3.4 17a16.5 16.5 0 0 0 5 2.5l1-1.6a10.6 10.6 0 0 1-1.7-.8l.4-.3a11.7 11.7 0 0 0 9.8 0l.4.3-1.7.8 1 1.6a16.4 16.4 0 0 0 5-2.5c.4-4.3-.7-8-3-11.4zM9.3 14.7c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm5.4 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z"/></svg>
            Join the Discord
          </a>
        </div>
        <div class="footer-row">
          <a class="brand" href="/">${MARK}Built with Muse</a>
          <nav class="footer-links" aria-label="Footer">
            <a href="/">Get a code</a>
            <a href="/workflows">Workflows</a>
            <a href="/creators">Creators</a>
            <a href="/use-cases">Use cases</a>
            <a href="/blog">Blog</a>
            <a href="/about">About</a>
            <a href="/privacy">Privacy</a>
            <a href="mailto:polostudio.brand@gmail.com">Contact</a>
            <a href="${DISCORD}" target="_blank" rel="noopener noreferrer">Discord</a>
          </nav>
        </div>
        <div class="strip">Independent community project. Not affiliated with or endorsed by Meta.</div>
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
  const canonical = SITE + path;
  const image = ogImage || SITE + "/og/home.png";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#1a56ff" />
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
    <style>${CSS}${extraCss}</style>${HEAD_SCRIPTS}
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
    ${script ? `<script>${script}</script>` : ""}
  </body>
</html>`;
}

module.exports = { layout, esc, SITE, MARK };
