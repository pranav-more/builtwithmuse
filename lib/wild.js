"use strict";

// Muse in the wild: real posts from X, Threads and Instagram where someone
// reported what they got Muse to do. Data is the curated JSON in seed/
// (264 posts in 12 categories, snapshot 2026-09-27), loaded once per
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
    try { mediaIndex = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "muse-use-cases-media.json"), "utf8")); } catch (_) { mediaIndex = {}; }
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
  const categories = raw.categories.map((c) => ({
    id: c.id, title: c.title, blurb: c.blurb, count: c.items.length,
    items: c.items.map((i) => ({ ...i, likes: i.likes || 0, views: i.views || 0, reposts: i.reposts || 0, replies: i.replies || 0 })),
  }));
  for (const c of categories) c.items.sort(byHeat);
  const all = categories.flatMap((c) => c.items).sort(byHeat);
  data = { updated: raw.updated, disclaimer: raw.disclaimer, sources: raw.sources, total: all.length, categories, byId: new Map(categories.map((c) => [c.id, c])), all };
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
              try { await navigator.share({ title: title, text: title + " on Built with Muse", url: url }); trackEvent("post_shared"); }
              catch (err) { if (err && err.name === "AbortError") { trackEvent("post_share_cancelled"); return; } throw err; }
              return;
            }
            await navigator.clipboard.writeText(url);
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

async function pageHub(fromCreators, community) {
  const d = load();
  const top = d.all.filter((i) => i.text_source === "tweet").slice(0, 12);
  const communityItems = Array.isArray(community) ? community : [];
  const totalCount = d.total + communityItems.length;
  const addBand = `
        <div class="wild-add">
          <div><h2>Posted what Muse did for you?</h2><p>Paste the link to your own X post below.</p></div>
          <div id="wild-add-body"><p class="muted">Checking sign in.</p></div>
        </div>`;
  const communityHtml = communityItems.length
    ? `<div class="section-title"><h2>Community posts</h2><p>Added by creators, approved by a moderator</p></div>
        <div class="wild-grid">${communityItems.map((i) => cardHtml(i)).join("")}</div>`
    : "";
  const title = `What people are posting about Muse: ${totalCount} real posts | Built with Muse`;
  const description = `Posts from X, Threads and Instagram where people say what Meta's Muse did for them: bills negotiated, trips booked, refunds won, admin cleared. Sorted by category, with prompts to copy.`;
  const body = `
        <section class="page-head">
          <div class="eyebrow">Social</div>
          <h1>What people are posting about Muse.</h1>
          <p class="lead">${totalCount} posts from X, Threads and Instagram where people say what Muse did for them, in ${d.categories.length} categories. Every post links to the original. Outcomes are what the poster reported; we did not verify them.</p>
        </section>
        ${addBand}
        ${communityHtml}
        <div class="wild-cats">${d.categories.map((c) => `<a class="wild-tile" href="/posts/${esc(c.id)}"><b>${esc(c.title)}</b><span>${esc(c.blurb)}</span><small>${c.count} post${c.count === 1 ? "" : "s"}</small></a>`).join("")}</div>
        <div class="section-title"><h2>Most liked</h2><p>In the poster's own words</p></div>
        <div class="wild-grid">${top.map((i) => cardHtml(i)).join("")}</div>
        ${fromCreators ? `<div class="section-title" style="margin-top:44px"><h2>Written up by our creators</h2><a class="quiet-link" href="/workflows">See the feed</a></div>${fromCreators}` : ""}
        <div class="quote-band" id="quote-band"><p>Did Muse do something like this for you? Write it up and it goes live under <em class="hl">your name</em>.</p><a class="cta" href="/creator#new">Publish a workflow</a></div>`;
  return layout({
    title, description, path: "/posts", current: "/posts", body, script: COPY_JS + WILD_ADD_JS + SAVE_JS,
    jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: SITE + "/posts", description, hasPart: d.categories.map((c) => ({ "@type": "CollectionPage", name: `Muse for ${c.title.toLowerCase()}`, url: `${SITE}/posts/${c.id}` })) },
  });
}

async function pageCategory(id, fromCreators) {
  const d = load();
  const cat = d.byId.get(id);
  if (!cat) return null;
  const own = cat.items.filter((i) => i.text_source === "tweet");
  const rest = cat.items.filter((i) => i.text_source !== "tweet");
  const likes = cat.items.reduce((n, i) => n + (i.likes || 0), 0);
  const idx = d.categories.findIndex((c) => c.id === id);
  const neighbours = [d.categories[(idx + 1) % d.categories.length], d.categories[(idx + 2) % d.categories.length], d.categories[(idx + 3) % d.categories.length]];
  const title = `Muse for ${cat.title.toLowerCase()}: ${cat.count} real posts from X and Threads | Built with Muse`;
  const description = `${cat.blurb} ${cat.count} public posts where people report what Meta's Muse did, with ${cat.items.filter((i) => i.prompt).length} prompts to copy. Outcomes as reported by the posters.`;
  const faq = faqFor(cat);
  const body = `
        <section class="page-head">
          <div class="eyebrow"><a href="/posts" style="text-decoration:none">Social</a> · ${esc(cat.title)}</div>
          <h1>Muse for ${esc(cat.title.toLowerCase())}.</h1>
          <p class="lead">${esc(cat.blurb)}</p>
          <div class="meta"><span>${cat.count} post${cat.count === 1 ? "" : "s"}</span><span>${own.length} in the poster's words</span>${likes ? `<span>${compact(likes)} likes on X</span>` : ""}<span>${cat.items.filter((i) => i.prompt).length} prompts to copy</span></div>
        </section>
        ${own.length ? `<div class="section-title"><h2>In their own words</h2><p>Sorted by likes</p></div><div class="wild-grid">${own.map((i) => cardHtml(i, { showCategory: false })).join("")}</div>` : ""}
        ${rest.length ? `<div class="section-title" style="margin-top:36px"><h2>${own.length ? "More posts" : "What people posted"}</h2><p>Condensed, each linked to the original</p></div><div class="wild-grid compact">${rest.map((i) => cardHtml(i, { showCategory: false })).join("")}</div>` : ""}
        ${fromCreators ? `<div class="section-title" style="margin-top:44px"><h2>Workflows from our creators</h2><a class="quiet-link" href="/workflows?category=${esc(WILD_TO_OURS[id] || "")}">See more</a></div>${fromCreators}` : ""}
        <section class="wild-faq"><h2>Questions</h2>${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</section>
        <div class="section-title" style="margin-top:36px"><h2>More categories</h2></div>
        <div class="wild-cats">${neighbours.map((c) => `<a class="wild-tile" href="/posts/${esc(c.id)}"><b>${esc(c.title)}</b><span>${esc(c.blurb)}</span><small>${c.count} posts</small></a>`).join("")}</div>
        <p class="wild-disclaimer">${esc(d.disclaimer)} Data updated ${esc(d.updated)}.</p>`;
  const jsonld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: `${SITE}/posts/${id}`, description, isPartOf: { "@type": "CollectionPage", url: SITE + "/posts" } },
    { "@context": "https://schema.org", "@type": "ItemList", itemListElement: cat.items.slice(0, 50).map((i, n) => ({ "@type": "ListItem", position: n + 1, name: i.title, url: i.url })) },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  ];
  return layout({ title, description, path: `/posts/${id}`, current: "/posts", body, script: COPY_JS + SAVE_JS, jsonld });
}

module.exports = { load, pick, publicItem, cardHtml, pageHub, pageCategory, setCommunityItems, communityCount, OURS_TO_WILD, WILD_TO_OURS, COPY_JS, SHARE_JS, SAVE_JS, WILD_ADD_JS };
