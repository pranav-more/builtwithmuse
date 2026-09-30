"use strict";

// Muse in the wild: real posts from X, Threads and Instagram where someone
// reported what they got Muse to do. Data is the curated JSON in seed/
// (272 posts in 12 categories, snapshot 2026-09-28), loaded once per
// process. Every card quotes the poster's own words when we have them,
// labels condensed summaries as such, and links back to the original.

const fs = require("fs");
const path = require("path");
const { layout, esc, SITE } = require("./pages");

let data = null;
let mediaIndex = null;
// Avatars, photos and video posters fetched from X by scripts/enrich-posts.js.
function media(item) {
  // Community posts carry their fetched media on the item itself, since the
  // seed media snapshot only covers the curated posts.
  if (item && item.communityMedia) return item.communityMedia;
  if (mediaIndex === null) {
    mediaIndex = {};
    for (const file of ["muse-use-cases-media.json", "muse-builds-media.json"]) {
      try { Object.assign(mediaIndex, JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", file), "utf8"))); } catch (_) { /* optional snapshot */ }
    }
  }
  return (item.status_id && mediaIndex[item.status_id]) || null;
}
// Approved community posts, warmed asynchronously by the server (see
// creators.js). pick() merges them into the unfiltered pool so the feed and
// the Social surfaces include them; category filtered picks stay curated.
let communityItems = [];
function setCommunityItems(items) { communityItems = Array.isArray(items) ? items : []; }
function communityCount() { return communityItems.length; }
function load() {
  if (data) return data;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "muse-use-cases.json"), "utf8"));
  let builds = null;
  try { builds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "muse-builds.json"), "utf8")); } catch (_) { builds = null; }
  const mapCats = (list, group) => list.map((c) => ({
    id: c.id, title: c.title, blurb: c.blurb, group, count: c.items.length,
    items: c.items.map((i) => ({ ...i, likes: i.likes || 0, views: i.views || 0, reposts: i.reposts || 0, replies: i.replies || 0 })),
  }));
  const categories = mapCats(raw.categories, "Everyday").concat(builds ? mapCats(builds.categories, builds.group || "Builds and tools") : []);
  for (const c of categories) c.items.sort(byHeat);
  const all = categories.flatMap((c) => c.items).sort(byHeat);
  data = { updated: raw.updated, disclaimer: raw.disclaimer, sources: raw.sources.concat(builds ? builds.sources : []), total: all.length, categories, groups: [...new Set(categories.map((c) => c.group))], byId: new Map(categories.map((c) => [c.id, c])), all };
  return data;
}
// Own-words posts with engagement first, then the rest by likes.
function byHeat(a, b) {
  const aw = a.text_source === "tweet" ? 1 : 0, bw = b.text_source === "tweet" ? 1 : 0;
  if (aw !== bw) return bw - aw;
  if ((b.likes || 0) !== (a.likes || 0)) return (b.likes || 0) - (a.likes || 0);
  return String(b.posted_at || "").localeCompare(String(a.posted_at || ""));
}

// Our workflow categories to the wild categories that belong with them, so
// a feed filter or a workflow page can pull matching posts.
const OURS_TO_WILD = {
  money: ["paying-bills", "spending-money"], shopping: ["spending-money", "food"], "life-admin": ["calls-and-admin", "home-and-family", "dating", "food"],
  work: ["work", "job-apply"], travel: ["travel"], health: ["health"], research: ["educational"], productivity: ["work", "calls-and-admin"],
  creators: ["fun"], developers: ["work"], others: ["fun", "educational"],
};
const WILD_TO_OURS = { "paying-bills": "money", "spending-money": "shopping", educational: "research", "job-apply": "work", dating: "life-admin", travel: "travel", food: "life-admin", "home-and-family": "life-admin", health: "health", work: "work", "calls-and-admin": "life-admin", fun: "others" };

function compact(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}
function initials(name, handle) {
  const base = (name || handle || "?").replace(/^@/, "");
  return base.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}
function platformLabel(p) {
  return { x: "X", threads: "Threads", instagram: "Instagram", medium: "Medium", hackernews: "Hacker News", web: "Web" }[p] || p;
}
function dateLabel(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const X_MARK = '<svg viewBox="0 0 24 24" aria-label="X" role="img"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
const THREADS_MARK = '<svg viewBox="0 0 24 24" aria-label="Threads" role="img"><path fill="currentColor" d="M12.2 2C6.6 2 3.4 5.6 3.4 12s3.2 10 8.8 10c4.4 0 7.4-2.3 8.3-6.2l-2.3-.6c-.6 2.6-2.5 4.4-6 4.4-4.2 0-6.4-2.7-6.4-7.6S8 4.4 12.2 4.4c3.1 0 5 1.4 5.8 3.6-1-.5-2.2-.8-3.5-.8-3.4 0-5.7 1.9-5.7 4.5 0 2.5 2 4.2 4.8 4.2 3.3 0 5.2-2.2 5.4-6.1 1.2.7 1.9 1.8 1.9 3.2h2.3c0-2.6-1.5-4.6-4-5.6C18.6 4.2 16 2 12.2 2zm1.4 9.5c-.1 2.5-1.2 3.9-3.1 3.9-1.5 0-2.4-.7-2.4-1.8 0-1.2 1.2-2.1 3.3-2.1.8 0 1.5.1 2.2.3v-.3z"/></svg>';
const IG_MARK = '<svg viewBox="0 0 24 24" aria-label="Instagram" role="img"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor"/></svg>';
function platformMark(p) {
  return p === "x" ? X_MARK : p === "threads" ? THREADS_MARK : p === "instagram" ? IG_MARK : `<span class="tweet-site">${esc(platformLabel(p))}</span>`;
}
const ICON_REPLY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"/></svg>';
const ICON_REPOST = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zm16.5 16.24l-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14z"/></svg>';
const ICON_LIKE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg>';
const ICON_VIEWS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"/></svg>';

// One post, drawn the way it looks on X: avatar, name, handle, the mark of
// the platform, the words, then replies, reposts, likes and views.
function cardHtml(item, { showCategory = true, caption = true } = {}) {
  const d = load();
  const cat = d.byId.get(item.category);
  const ownWords = item.text_source === "tweet" && item.tweet_text;
  const text = ownWords ? item.tweet_text : item.summary;
  const m = media(item);
  const who = item.name || (m && m.name) || (item.handle ? item.handle.replace(/^@/, "") : "Muse user");
  const handle = item.handle || (m && m.handle) || "";
  const avatar = m && m.avatar ? `<img class="tweet-avatar" src="${esc(m.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="tweet-avatar" aria-hidden="true">${esc(initials(who, handle))}</span>`;
  const photos = m ? m.photos.slice(0, 4) : [];
  const mediaHtml = photos.length
    ? `<a class="tweet-media n${photos.length}" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow">${photos.map((u) => `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`).join("")}</a>`
    : m && m.video && m.video.poster ? `<a class="tweet-media n1 video" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow"><img src="${esc(m.video.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span class="play" aria-hidden="true">&#9654;</span></a>` : "";
  const hasStats = item.likes || item.views || item.reposts || item.replies;
  const site = platformLabel(item.platform);
  const subHandle = item.submitterHandle ? String(item.submitterHandle).replace(/^@/, "") : "";
  const submitterHtml = subHandle ? `<span class="tweet-submitter">Added by ${item.submitterActive ? `<a href="/creators/${esc(subHandle)}">@${esc(subHandle)}</a>` : `@${esc(subHandle)}`}</span>` : "";
  return `<div class="post" id="post-${esc(item.id)}">
  ${caption ? `<div class="post-caption"><h3><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(item.title)}</a></h3>${showCategory && cat ? `<a class="post-cat" href="/posts/${esc(cat.id)}">${esc(cat.title)}</a>` : ""}</div>` : ""}
  <article class="tweet${ownWords ? "" : " summary"}">
    <header class="tweet-head">
      ${avatar}
      <span class="tweet-names"><b>${esc(who)}${m && m.verified ? '<svg class="tweet-verified" viewBox="0 0 24 24" aria-label="Verified"><path fill="#1d9bf0" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"/></svg>' : ""}</b><span>${esc(handle)}${handle && item.posted_at ? " · " : ""}${esc(dateLabel(item.posted_at))}</span></span>
      <a class="tweet-mark" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow" title="Open on ${esc(site)}">${platformMark(item.platform)}</a>
    </header>
    ${ownWords ? `<p class="tweet-text">${esc(text)}</p>${mediaHtml}` : `<p class="tweet-text">${esc(text)}</p>${mediaHtml}<p class="tweet-summary-note">Condensed from the post. <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow">Read the original on ${esc(site)}</a>.</p>`}
    ${item.prompt ? `<details class="tweet-prompt"><summary>Try the prompt</summary><pre>${esc(item.prompt)}</pre><button class="cta ghost copy-wild" type="button" data-copy="${esc(item.prompt)}">Copy prompt</button></details>` : ""}
    <footer class="tweet-actions">
      ${hasStats ? `<span title="Replies">${ICON_REPLY}${compact(item.replies)}</span><span title="Reposts">${ICON_REPOST}${compact(item.reposts)}</span><span title="Likes">${ICON_LIKE}${compact(item.likes)}</span><span title="Views">${ICON_VIEWS}${compact(item.views)}</span>` : `<span class="tweet-nostats">Outcome as reported by the poster</span>`}
      ${submitterHtml}
      <a class="tweet-open" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow">View on ${esc(site)}</a>
    </footer>
  </article>
</div>`;
}

const COPY_JS = `
      (() => {
        document.querySelectorAll(".copy-wild").forEach((b) => b.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy prompt"; }, 1800); } catch (_) {}
        }));
      })();`;

// One share handler for every .share-btn on server rendered pages: the
// workflow detail page, the feed rows, and the Social pages. Fires the
// post share events and copies the link when the device cannot share.
const SHARE_JS = `
      (() => {
        const trackEvent = (n) => { try { if (typeof window.clarity === "function") window.clarity("event", n); } catch (_) {} };
        document.querySelectorAll(".share-btn").forEach((b) => b.addEventListener("click", async () => {
          const url = b.dataset.shareUrl, title = b.dataset.shareTitle;
          const st = document.getElementById("react-status") || document.getElementById("share-status-p") || b.parentElement.querySelector(".share-status");
          trackEvent("post_share_clicked");
          try {
            if (navigator.share) {
              try { await navigator.share({ title: title, text: "Worth stealing: " + title, url: url }); trackEvent("post_shared"); }
              catch (err) { if (err && err.name === "AbortError") { trackEvent("post_share_cancelled"); return; } throw err; }
              return;
            }
            await navigator.clipboard.writeText("Worth stealing: " + title + " " + url);
            trackEvent("post_link_copied");
            if (st) { st.textContent = "Link copied."; setTimeout(() => { st.textContent = ""; }, 2000); }
          } catch (_) {
            if (st) { st.textContent = url; }
          }
        }));
      })();`;

// One save handler for every .save-btn on server rendered feed rows:
// the /workflows feed, the /posts pages, and creator profile pages. Reuses
// the same /api/v1/workflows/:id/save endpoint as the workflow detail page.
// Signed out visitors are sent to sign in, matching the follow button.
const SAVE_JS = `
      (() => {
        document.querySelectorAll(".save-btn").forEach((saveBtn) => saveBtn.addEventListener("click", async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (saveBtn.disabled) return; saveBtn.disabled = true;
          try {
            const r = await fetch("/api/v1/workflows/" + saveBtn.dataset.workflow + "/save", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" } });
            if (r.status === 401) { window.location.href = "/creator"; return; }
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            const on = Boolean(d.saved);
            saveBtn.classList.toggle("on", on);
            saveBtn.setAttribute("aria-pressed", String(on));
            saveBtn.setAttribute("aria-label", on ? "Saved. Click to unsave." : "Save this workflow");
            if (saveBtn.classList.contains("quiet-link")) saveBtn.textContent = on ? "Saved" : "Save";
          } catch (_) {}
          saveBtn.disabled = false;
        }));
      })();`;

// The "Add your post" form on /posts. Only signed in creators see the form;
// everyone else gets a sign in prompt. Submits to /api/v1/wild/submit and
// reports the result inline. Visible copy carries no dashes.
const WILD_ADD_JS = `
      (() => {
        const body = document.getElementById("wild-add-body");
        if (!body) return;
        const esc = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
        const MSG = {
          signin_required: "Sign in with Google to add your post.",
          bad_url: "That does not look like an X post link. It should look like x.com/yourname/status/123.",
          already_listed: "This post is already on the site.",
          fetch_failed: "We could not read that post. It may be deleted or private.",
          empty_post: "That post has no text to show.",
          rate_limited: "Slow down a little and try again soon."
        };
        const showForm = () => {
          body.innerHTML = '<form id="wild-add-form"><label for="wild-add-url">Your X post link</label><div class="wild-add-row"><input id="wild-add-url" name="url" type="url" required placeholder="https://x.com/yourname/status/1234567890" maxlength="300" autocomplete="off" /><button class="cta" type="submit">Submit to post</button></div><p class="wild-add-note">Paste the link to your own post on X.</p><p class="wild-add-status" id="wild-add-status" aria-live="polite"></p></form>';
          const form = document.getElementById("wild-add-form"), status = document.getElementById("wild-add-status");
          form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const btn = form.querySelector("button"); btn.disabled = true;
            status.textContent = "Reading your post.";
            try {
              const r = await fetch("/api/v1/wild/submit", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify({ tweet_url: form.url.value }) });
              const out = await r.json().catch(() => ({}));
              if (r.ok && out.ok) { status.textContent = "Thanks. A moderator will check your post and publish it here."; form.reset(); }
              else status.textContent = MSG[out.error] || "Something went wrong. Try again.";
            } catch (_) { status.textContent = "Something went wrong. Try again."; }
            btn.disabled = false;
          });
        };
        fetch("/api/v1/me", { credentials: "same-origin" }).then((r) => r.json().catch(() => null)).then((d) => {
          if (d && d.ok && d.creator) showForm();
          else body.innerHTML = '<a class="cta" href="/creator">Sign in with Google to add your post</a>';
        }).catch(() => { body.innerHTML = '<a class="cta" href="/creator">Sign in with Google to add your post</a>'; });
      })();`;

function pick({ category = "", ours = "", limit = 3, offset = 0, ownWordsFirst = true } = {}) {
  const d = load();
  let pool = d.all;
  if (category && d.byId.has(category)) pool = d.byId.get(category).items;
  else if (ours && OURS_TO_WILD[ours]) { const set = new Set(OURS_TO_WILD[ours]); pool = d.all.filter((i) => set.has(i.category)); }
  if (!category && !ours && communityItems.length) pool = [...pool, ...communityItems].sort(byHeat);
  if (!ownWordsFirst) pool = [...pool].sort((a, b) => (b.likes || 0) - (a.likes || 0));
  return pool.slice(offset, offset + limit);
}
function publicItem(i) {
  const m = media(i);
  return { avatar: m && m.avatar ? m.avatar : null, photos: m ? m.photos.slice(0, 4) : [], videoPoster: m && m.video ? m.video.poster : null, verified: Boolean(m && m.verified), name: i.name || (m && m.name) || null, id: i.id, title: i.title, category: i.category, categoryTitle: (load().byId.get(i.category) || {}).title || "", text: i.text_source === "tweet" && i.tweet_text ? i.tweet_text : i.summary, ownWords: i.text_source === "tweet" && Boolean(i.tweet_text), prompt: i.prompt || null, handle: i.handle || (m && m.handle) || null, url: i.url, platform: platformLabel(i.platform), postedAt: i.posted_at, likes: i.likes, reposts: i.reposts, replies: i.replies, views: i.views,
    submitterHandle: i.submitterHandle || null, submitterName: i.submitterName || null, submitterActive: Boolean(i.submitterActive) };
}

function faqFor(cat) {
  const withPrompt = cat.items.filter((i) => i.prompt).length;
  const own = cat.items.filter((i) => i.text_source === "tweet").length;
  return [
    [`What have people actually used Muse for when it comes to ${cat.title.toLowerCase()}?`, `${cat.count} public posts describe it. ${cat.blurb} Each card above quotes the poster or condenses their post, and links to the original.`],
    [`Are these results verified?`, `No. Outcomes are what each poster reported. Built with Muse did not verify the savings, bookings or completions. ${own} of the ${cat.count} posts are in the poster's own words; the rest are condensed summaries with a link back.`],
    [`Can I try the same thing?`, `${withPrompt} of these posts come with a prompt you can copy and adapt. Open Try the prompt on a card, paste it into Muse, and replace the bracketed parts with your own details.`],
    [`How do I get Muse?`, `Muse is invite only in most places. Built with Muse runs a community pool of invite codes: take one, redeem it in the Muse app, then add your own for the next person.`],
  ];
}


// ---------------------------------------------------------------------------
// The Social browser: one page for /posts and /posts/<category>. A sidebar
// of categories with counts, source type chips with counts, a search box,
// numbered pagination, and a sponsor tile in the grid.
const PAGE_SIZE = 24;
const TYPES = [["x", "X posts"], ["threads", "Threads"], ["instagram", "Instagram"], ["community", "Community"]];

const BROWSE_CSS = `
.browse { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 32px; align-items: start; margin-top: 8px; }
.browse-side { position: sticky; top: 88px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; min-width: 0; }
.browse-side > * { min-width: 0; }
.side-all { display: flex; justify-content: space-between; align-items: center; padding: 11px 14px; border-radius: 10px; background: var(--tint); color: var(--blue-deep); font-weight: 700; text-decoration: none; }
.side-all.off { background: transparent; color: var(--ink); border: 1px solid var(--line); }
.side-all b { font-weight: 700; font-size: 13px; }
.side-group h3 { margin: 0 0 6px; padding: 0 14px; font: 600 12px/1 "IBM Plex Sans", system-ui, sans-serif; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted-2); }
.side-group a { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 14px; border-radius: 8px; color: var(--ink); text-decoration: none; font-size: 14px; font-weight: 500; }
.side-group a:hover { background: var(--tint); }
.side-group a.on { background: var(--tint); color: var(--blue-deep); font-weight: 700; }
.side-group a small { color: var(--muted-2); font-size: 12px; font-weight: 600; }
.side-box { padding: 16px; border: 1px dashed var(--line); border-radius: 12px; background: #fff; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; overflow-wrap: anywhere; }
.side-box .wild-add-row { flex-wrap: wrap; }
.side-box .wild-add-row input { width: 100%; flex: 1 1 100%; }
.side-box .wild-add-row .cta, .side-box .cta { width: 100%; text-align: center; box-sizing: border-box; }
.side-box b { font: 700 15px "Archivo", sans-serif; letter-spacing: -0.01em; }
.side-box p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
.side-box a.cta { display: inline-block; padding: 9px 14px; border-radius: 8px; background: var(--blue); color: #fff; font-weight: 700; font-size: 13px; text-decoration: none; width: fit-content; }
.browse-top { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chips a { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--ink); font-size: 14px; font-weight: 600; text-decoration: none; }
.chips a small { color: var(--muted-2); font-weight: 600; font-size: 12px; }
.chips a.on { background: var(--ink); color: #fff; border-color: var(--ink); }
.chips a.on small { color: #c9d1e3; }
.browse-search { display: flex; gap: 8px; }
.browse-search input { width: 240px; max-width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 14px; background: #fff; }
.browse-search button { padding: 9px 16px; border: 0; border-radius: 999px; background: var(--blue); color: #fff; font-weight: 700; font-size: 14px; cursor: pointer; }
.browse-meta { margin: 0 0 16px; color: var(--muted-2); font-size: 13px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.browse-meta a { color: var(--blue-deep); }
.browse .wild-grid { display: block; column-count: 3; column-gap: 18px; }
.browse .wild-grid > * { break-inside: avoid; margin-bottom: 18px; }
.browse .wild-grid .post { display: flex; }
.browse .tweet-actions { flex-wrap: wrap; row-gap: 6px; }
.browse .tweet-actions .tweet-open { margin-left: auto; }
@media (max-width: 1180px) { .browse .wild-grid { column-count: 2; } }
@media (max-width: 640px) { .browse .wild-grid { column-count: 1; } }
.sponsor-tile { display: grid; gap: 10px; padding: 20px; border: 1px dashed var(--blue); border-radius: 14px; background: var(--tint); align-content: start; }
.sponsor-tile .k { font: 700 11px/1 "IBM Plex Sans", system-ui, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; color: var(--blue-deep); }
.sponsor-tile b { font: 700 18px "Archivo", sans-serif; letter-spacing: -0.02em; }
.sponsor-tile p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.sponsor-tile .ph { height: 120px; border-radius: 10px; border: 1px dashed var(--blue); background: repeating-linear-gradient(45deg, transparent 0 8px, rgba(26,86,255,.06) 8px 16px); }
.sponsor-tile a.cta { display: inline-block; padding: 9px 14px; border-radius: 8px; background: var(--blue); color: #fff; font-weight: 700; font-size: 13px; text-decoration: none; width: fit-content; }
.pager { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; justify-content: center; margin: 32px 0 8px; }
.pager a, .pager span { min-width: 40px; height: 40px; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--ink); text-decoration: none; font-weight: 600; font-size: 14px; }
.pager a:hover { border-color: var(--blue); color: var(--blue-deep); }
.pager .on { background: var(--blue); color: #fff; border-color: var(--blue); }
.pager .gap { border: 0; background: transparent; color: var(--muted-2); min-width: 24px; padding: 0; }
.pager .dis { color: var(--muted-2); border-color: var(--line-soft); }
.browse-empty { padding: 40px; border: 1px dashed var(--line); border-radius: 14px; text-align: center; color: var(--muted); }
@media (max-width: 960px) {
  .browse { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .browse > * { min-width: 0; }
  .browse-side { position: static; }
  .side-group { display: flex; flex-wrap: wrap; gap: 6px; }
  .side-group h3 { width: 100%; padding: 0; margin-bottom: 4px; }
  .side-group a { padding: 7px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; }
  .side-box { display: none; }
  .browse-search { width: 100%; }
  .browse-search input { flex: 1; width: auto; }
}
`;

function paramsHref(base, { q, type, page }) {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  if (type) sp.set("type", type);
  if (page && page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return base + (qs ? "?" + qs : "");
}
function matches(item, q) {
  if (!q) return true;
  const hay = [item.title, item.summary, item.tweet_text, item.handle, item.name, (item.tags || []).join(" "), item.category].join(" ").toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
function itemType(i) { return i.community ? "community" : i.platform; }
function pagerHtml(base, opts, page, pages) {
  if (pages <= 1) return "";
  const link = (n, label, cls) => `<a class="${cls || ""}" href="${esc(paramsHref(base, { ...opts, page: n }))}"${n === page ? ' aria-current="page"' : ""}>${label}</a>`;
  const nums = new Set([1, pages, page, page - 1, page + 1, page - 2, page + 2].filter((n) => n >= 1 && n <= pages));
  const parts = [];
  let last = 0;
  for (const n of [...nums].sort((a, b) => a - b)) {
    if (n - last > 1) parts.push('<span class="gap">…</span>');
    parts.push(n === page ? `<span class="on" aria-current="page">${n}</span>` : link(n, String(n)));
    last = n;
  }
  const prev = page > 1 ? link(page - 1, "Prev") : '<span class="dis">Prev</span>';
  const next = page < pages ? link(page + 1, "Next") : '<span class="dis">Next</span>';
  return `<nav class="pager" aria-label="Pages">${prev}${parts.join("")}${next}</nav>`;
}
const SPONSOR_TILE = `<div class="sponsor-tile" aria-label="Sponsor slot"><span class="k">Your product · Sponsored</span><b>Put your product here.</b><p>Your logo, a line of copy and an image, in the grid people scroll for Muse posts. Same size as a post.</p><div class="ph" aria-hidden="true"></div><a class="cta" href="mailto:polostudio.brand@gmail.com?subject=Sponsoring%20Built%20with%20Muse">Claim the slot</a></div>`;

function browse({ category = null, q = "", type = "", page = 1, fromCreators = "", community = [] }) {
  const d = load();
  const cat = category ? d.byId.get(category) : null;
  q = String(q || "").trim().toLowerCase().slice(0, 80);
  type = TYPES.some(([t]) => t === type) ? type : "";
  const base = cat ? `/posts/${cat.id}` : "/posts";
  const communityItems = Array.isArray(community) ? community.map((i) => ({ ...i, community: true })) : [];
  let pool = cat ? cat.items : [...d.all, ...communityItems].sort(byHeat);
  const typeCounts = {};
  for (const i of pool) typeCounts[itemType(i)] = (typeCounts[itemType(i)] || 0) + 1;
  if (type) pool = pool.filter((i) => itemType(i) === type);
  if (q) pool = pool.filter((i) => matches(i, q));
  const total = pool.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.max(1, Math.min(pages, Number(page) || 1));
  const slice = pool.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const cards = slice.map((i) => cardHtml(i, { showCategory: !cat }));
  if (page === 1 && cards.length >= 2) cards.splice(2, 0, SPONSOR_TILE);
  const allCount = d.total + communityItems.length;
  const sideGroups = d.groups.map((g) => `<div class="side-group"><h3>${esc(g)}</h3>${d.categories.filter((c) => c.group === g).map((c) => `<a class="${cat && cat.id === c.id ? "on" : ""}" href="/posts/${esc(c.id)}"${cat && cat.id === c.id ? ' aria-current="page"' : ""}>${esc(c.title)}<small>${c.count}</small></a>`).join("")}</div>`).join("");
  const chips = [["", "All", cat ? cat.count : allCount]].concat(TYPES.map(([t, label]) => [t, label, typeCounts[t] || 0]).filter(([, , n]) => n > 0))
    .map(([t, label, n]) => `<a class="${t === type ? "on" : ""}" href="${esc(paramsHref(base, { q, type: t, page: 1 }))}">${esc(label)}<small>${n}</small></a>`).join("");
  const meta = `${total} post${total === 1 ? "" : "s"}${pages > 1 ? ` · page ${page} of ${pages}` : ""}${q ? ` · matching "${esc(q)}" <a href="${esc(paramsHref(base, { type, page: 1 }))}">clear</a>` : ""}`;
  const h1 = cat ? `Muse for ${esc(cat.title.toLowerCase())}.` : "What people are posting about Muse.";
  const lead = cat ? esc(cat.blurb) : `${allCount} posts from X, Threads and Instagram where people say what Muse did for them. Every post links to the original. Outcomes are what the poster reported.`;
  const faq = cat ? faqFor(cat) : null;
  const body = `
        <section class="page-head" style="margin-bottom:18px">
          <div class="eyebrow">${cat ? `<a href="/posts" style="text-decoration:none">Social</a> · ${esc(cat.title)}` : "Social"}</div>
          <h1>${h1}</h1>
          <p class="lead">${lead}</p>
        </section>
        <div class="browse">
          <aside class="browse-side" aria-label="Categories">
            <a class="side-all${cat ? " off" : ""}" href="/posts">All posts <b>${allCount}</b></a>
            ${sideGroups}
            <div class="side-box"><b>Posted what Muse did for you?</b><p>Add your own X post and a moderator will publish it here.</p><div id="wild-add-body"><p class="muted" style="font-size:13px">Checking sign in.</p></div></div>
            <div class="side-box"><b>Sponsor this page</b><p>One exclusive slot in front of the people building with Muse.</p><a class="cta" href="mailto:polostudio.brand@gmail.com?subject=Sponsoring%20Built%20with%20Muse">Claim it</a></div>
          </aside>
          <div class="browse-main">
            <div class="browse-top">
              <div class="chips">${chips}</div>
              <form class="browse-search" method="get" action="${esc(base)}" role="search">${type ? `<input type="hidden" name="type" value="${esc(type)}">` : ""}<input type="search" name="q" value="${esc(q)}" placeholder="Search posts" aria-label="Search posts"><button type="submit">Search</button></form>
            </div>
            <p class="browse-meta">${meta}</p>
            ${cards.length ? `<div class="wild-grid">${cards.join("")}</div>` : `<div class="browse-empty">No posts match. <a href="${esc(base)}">Show everything</a>.</div>`}
            ${pagerHtml(base, { q, type }, page, pages)}
            ${fromCreators ? `<div class="section-title" style="margin-top:44px"><h2>Written up by our creators</h2><a class="quiet-link" href="/workflows${cat && WILD_TO_OURS[cat.id] ? "?category=" + esc(WILD_TO_OURS[cat.id]) : ""}">See the feed</a></div>${fromCreators}` : ""}
            ${faq ? `<section class="wild-faq"><h2>Questions</h2>${faq.map(([qq, a]) => `<details><summary>${esc(qq)}</summary><p>${esc(a)}</p></details>`).join("")}</section>` : ""}
            <p class="wild-disclaimer">${esc(d.disclaimer)} Some entries were first catalogued by shipwithmuse.live. Data updated ${esc(d.updated)}.</p>
          </div>
        </div>`;
  const title = cat ? `Muse for ${cat.title.toLowerCase()}: ${cat.count} real posts | Built with Muse` : `What people are posting about Muse: ${allCount} real posts | Built with Muse`;
  const description = cat ? `${cat.blurb} ${cat.count} public posts where people report what Meta's Muse did. Outcomes as reported by the posters.` : `Posts from X, Threads and Instagram where people say what Meta's Muse did for them: bills negotiated, trips booked, apps shipped, models run. ${d.categories.length} categories, with prompts to copy.`;
  const jsonld = cat
    ? [{ "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: `${SITE}/posts/${cat.id}`, description, isPartOf: { "@type": "CollectionPage", url: SITE + "/posts" } },
       { "@context": "https://schema.org", "@type": "ItemList", itemListElement: cat.items.slice(0, 50).map((i, n) => ({ "@type": "ListItem", position: n + 1, name: i.title, url: i.url })) },
       { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([qq, a]) => ({ "@type": "Question", name: qq, acceptedAnswer: { "@type": "Answer", text: a } })) }]
    : { "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: SITE + "/posts", description, hasPart: d.categories.map((c) => ({ "@type": "CollectionPage", name: `Muse for ${c.title.toLowerCase()}`, url: `${SITE}/posts/${c.id}` })) };
  const noindex = Boolean(q) || page > 1 || Boolean(type);
  return layout({ title, description, path: cat ? `/posts/${cat.id}` : "/posts", current: "/posts", body, script: COPY_JS + WILD_ADD_JS + SHARE_JS + SAVE_JS, jsonld, noindex, extraCss: BROWSE_CSS });
}

async function pageHub(fromCreators, community, opts = {}) {
  return browse({ ...opts, fromCreators, community });
}

async function pageCategory(id, fromCreators, opts = {}) {
  const d = load();
  if (!d.byId.has(id)) return null;
  return browse({ ...opts, category: id, fromCreators });
}

module.exports = { load, pick, publicItem, cardHtml, pageHub, pageCategory, setCommunityItems, communityCount, OURS_TO_WILD, WILD_TO_OURS, COPY_JS, SHARE_JS, SAVE_JS, WILD_ADD_JS };
