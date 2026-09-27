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

// One post as a card. `big` gives the poster's own words room to breathe.
function cardHtml(item, { big = false, showCategory = true } = {}) {
  const d = load();
  const cat = d.byId.get(item.category);
  const ownWords = item.text_source === "tweet" && item.tweet_text;
  const text = ownWords ? item.tweet_text : item.summary;
  const who = item.name || item.handle || "Someone";
  const hasStats = item.likes || item.views || item.reposts;
  return `<article class="wild-card${big ? " big" : ""}" id="post-${esc(item.id)}">
  <header class="wild-head">
    <span class="wild-avatar" aria-hidden="true">${esc(initials(item.name, item.handle))}</span>
    <span class="wild-who"><b>${esc(who)}</b><span>${item.handle ? esc(item.handle) + " · " : ""}${esc(platformLabel(item.platform))}${item.posted_at ? " · " + esc(dateLabel(item.posted_at)) : ""}</span></span>
    ${showCategory && cat ? `<a class="wild-cat" href="/wild/${esc(cat.id)}">${esc(cat.title)}</a>` : ""}
  </header>
  <h3 class="wild-title"><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(item.title)}</a></h3>
  <blockquote class="wild-text${ownWords ? "" : " condensed"}">${esc(text)}</blockquote>
  ${ownWords ? "" : `<p class="wild-note">Condensed from the public post. <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow">Read the original</a>.</p>`}
  ${item.prompt ? `<details class="wild-prompt"><summary>Try the prompt</summary><pre>${esc(item.prompt)}</pre><button class="cta ghost copy-wild" type="button" data-copy="${esc(item.prompt)}">Copy prompt</button></details>` : ""}
  <footer class="wild-foot">
    ${hasStats ? `<span class="wild-stats">${item.likes ? `<span title="Likes">&#9829; ${compact(item.likes)}</span>` : ""}${item.reposts ? `<span title="Reposts">&#8635; ${compact(item.reposts)}</span>` : ""}${item.views ? `<span title="Views">${compact(item.views)} views</span>` : ""}</span>` : `<span class="wild-stats"><span>Reported by the poster</span></span>`}
    <a class="wild-open" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow">Open post &#8599;</a>
  </footer>
</article>`;
}

const COPY_JS = `
      (() => {
        document.querySelectorAll(".copy-wild").forEach((b) => b.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy prompt"; }, 1800); } catch (_) {}
        }));
      })();`;

function pick({ category = "", ours = "", limit = 3, offset = 0, ownWordsFirst = true } = {}) {
  const d = load();
  let pool = d.all;
  if (category && d.byId.has(category)) pool = d.byId.get(category).items;
  else if (ours && OURS_TO_WILD[ours]) { const set = new Set(OURS_TO_WILD[ours]); pool = d.all.filter((i) => set.has(i.category)); }
  if (!ownWordsFirst) pool = [...pool].sort((a, b) => (b.likes || 0) - (a.likes || 0));
  return pool.slice(offset, offset + limit);
}
function publicItem(i) {
  return { id: i.id, title: i.title, category: i.category, categoryTitle: (load().byId.get(i.category) || {}).title || "", text: i.text_source === "tweet" && i.tweet_text ? i.tweet_text : i.summary, ownWords: i.text_source === "tweet" && Boolean(i.tweet_text), prompt: i.prompt || null, name: i.name, handle: i.handle, url: i.url, platform: platformLabel(i.platform), postedAt: i.posted_at, likes: i.likes, reposts: i.reposts, views: i.views };
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

async function pageHub(fromCreators) {
  const d = load();
  const top = d.all.filter((i) => i.text_source === "tweet").slice(0, 6);
  const title = `Muse in the wild: ${d.total} real things people got Muse to do | Built with Muse`;
  const description = `Public posts from X, Threads and Instagram where people report what Meta's Muse did for them: bills negotiated, trips booked, refunds won, admin cleared. Sorted by category, with prompts to copy.`;
  const body = `
        <section class="page-head">
          <div class="eyebrow">Muse in the wild</div>
          <h1>What people got Muse to do.</h1>
          <p class="lead">${d.total} public posts, ${d.categories.length} categories, every one linked to the original. Outcomes are what the poster reported; we did not verify them.</p>
        </section>
        <div class="wild-cats">${d.categories.map((c) => `<a class="wild-tile" href="/wild/${esc(c.id)}"><b>${esc(c.title)}</b><span>${esc(c.blurb)}</span><small>${c.count} post${c.count === 1 ? "" : "s"}</small></a>`).join("")}</div>
        <div class="section-title"><h2>Most talked about</h2><p>In the poster's own words</p></div>
        <div class="wild-grid">${top.map((i) => cardHtml(i, { big: true })).join("")}</div>
        ${fromCreators ? `<div class="section-title" style="margin-top:44px"><h2>Written up by our creators</h2><a class="quiet-link" href="/workflows">See the feed</a></div>${fromCreators}` : ""}
        <div class="quote-band"><p>Did Muse do something like this for you? Write it up and it goes live under your name.</p><a class="cta" href="/creator#new">Publish a workflow</a></div>`;
  return layout({
    title, description, path: "/wild", current: "/wild", body, script: COPY_JS,
    jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: SITE + "/wild", description, hasPart: d.categories.map((c) => ({ "@type": "CollectionPage", name: `Muse for ${c.title.toLowerCase()}`, url: `${SITE}/wild/${c.id}` })) },
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
  const title = `Muse for ${cat.title.toLowerCase()}: ${cat.count} real examples from X and Threads | Built with Muse`;
  const description = `${cat.blurb} ${cat.count} public posts where people report what Meta's Muse did, with ${cat.items.filter((i) => i.prompt).length} prompts to copy. Outcomes as reported by the posters.`;
  const faq = faqFor(cat);
  const body = `
        <section class="page-head">
          <div class="eyebrow"><a href="/wild" style="text-decoration:none">Muse in the wild</a> · ${esc(cat.title)}</div>
          <h1>Muse for ${esc(cat.title.toLowerCase())}.</h1>
          <p class="lead">${esc(cat.blurb)}</p>
          <div class="meta"><span>${cat.count} post${cat.count === 1 ? "" : "s"}</span><span>${own.length} in the poster's words</span>${likes ? `<span>${compact(likes)} likes on X</span>` : ""}<span>${cat.items.filter((i) => i.prompt).length} prompts to copy</span></div>
        </section>
        ${own.length ? `<div class="section-title"><h2>In their own words</h2><p>Sorted by likes</p></div><div class="wild-grid">${own.map((i) => cardHtml(i, { big: true, showCategory: false })).join("")}</div>` : ""}
        ${rest.length ? `<div class="section-title" style="margin-top:36px"><h2>${own.length ? "More reports" : "What people reported"}</h2><p>Condensed from public posts, each linked</p></div><div class="wild-grid compact">${rest.map((i) => cardHtml(i, { showCategory: false })).join("")}</div>` : ""}
        ${fromCreators ? `<div class="section-title" style="margin-top:44px"><h2>Workflows from our creators</h2><a class="quiet-link" href="/workflows?category=${esc(WILD_TO_OURS[id] || "")}">See more</a></div>${fromCreators}` : ""}
        <section class="wild-faq"><h2>Questions</h2>${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</section>
        <div class="section-title" style="margin-top:36px"><h2>More from the wild</h2></div>
        <div class="wild-cats">${neighbours.map((c) => `<a class="wild-tile" href="/wild/${esc(c.id)}"><b>${esc(c.title)}</b><span>${esc(c.blurb)}</span><small>${c.count} posts</small></a>`).join("")}</div>
        <p class="wild-disclaimer">${esc(d.disclaimer)} Data updated ${esc(d.updated)}.</p>`;
  const jsonld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: `${SITE}/wild/${id}`, description, isPartOf: { "@type": "CollectionPage", url: SITE + "/wild" } },
    { "@context": "https://schema.org", "@type": "ItemList", itemListElement: cat.items.slice(0, 50).map((i, n) => ({ "@type": "ListItem", position: n + 1, name: i.title, url: i.url })) },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  ];
  return layout({ title, description, path: `/wild/${id}`, current: "/wild", body, script: COPY_JS, jsonld });
}

module.exports = { load, pick, publicItem, cardHtml, pageHub, pageCategory, OURS_TO_WILD, WILD_TO_OURS, COPY_JS };
