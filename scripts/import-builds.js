"use strict";

// Turns the X posts catalogued by shipwithmuse.live into seed/muse-builds.json
// (ten "Builds and tools" categories) plus seed/muse-builds-media.json, in the
// same shape as seed/muse-use-cases.json so lib/wild.js can merge them.
//
// Inputs (produced in the session scratchpad by the fetch step):
//   <dir>/swm-xposts.json   entries parsed from https://shipwithmuse.live/llms-full.txt
//   <dir>/swm-tweets.json   tweet text, media and counts from X's syndication endpoint
//
//   node scripts/import-builds.js <dir>

const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/import-builds.js <dir>"); process.exit(1); }
const entries = JSON.parse(fs.readFileSync(path.join(dir, "swm-xposts.json"), "utf8"));
const tweets = JSON.parse(fs.readFileSync(path.join(dir, "swm-tweets.json"), "utf8"));
const ours = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "muse-use-cases.json"), "utf8"));
const ourIds = new Set(ours.categories.flatMap((c) => c.items.map((i) => i.status_id)).filter(Boolean));

const CATS = [
  ["errands-and-personal-agent", "Errands & personal agent", "Muse running the day for someone: bookings, bills, shopping, calls and follow ups."],
  ["coding-and-dev-tools", "Coding & dev tools", "Muse Code, agents in the terminal, and tooling people built around it."],
  ["connectors-and-mcp", "Connectors & MCP", "Muse wired into Gmail, GitHub, PayPal and other services through connectors."],
  ["agents-and-automation", "Agents & automation", "Recurring jobs, multi step agents and hands off automations."],
  ["apps-and-websites", "Apps & websites", "Apps and sites people shipped with Muse doing the building."],
  ["games-and-3d", "Games & 3D", "Games, worlds and 3D experiments made with Muse."],
  ["local-and-open-models", "Local & open models", "Muse Glimmer and other open weights running on people's own hardware."],
  ["benchmarks-and-research", "Benchmarks & research", "Evals, comparisons and research findings about Muse models."],
  ["content-and-creative", "Content & creative", "Writing, video, music and design work done with Muse."],
  ["business-and-commerce", "Business & commerce", "Muse at work: sales, support, commerce and back office."],
];
const slugOf = new Map(CATS.map(([id, title]) => [title, id]));
const DASH_RE = /\s*[–—]\s*/g;
const clean = (s) => String(s || "").replace(DASH_RE, ", ").replace(/\s+/g, " ").trim();

const cats = new Map(CATS.map(([id, title, blurb]) => [id, { id, title, blurb, count: 0, items: [] }]));
const media = {};
let withText = 0, dropped = 0, dup = 0;
for (const e of entries) {
  const m = /^https:\/\/x\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/.exec(e.Source || "");
  if (!m) { dropped++; continue; }
  const [, screen, id] = m;
  if (ourIds.has(id)) { dup++; continue; }
  const t = tweets[id] && !tweets[id].error ? tweets[id] : null;
  const catId = slugOf.get(e.Category);
  if (!catId) { dropped++; continue; }
  const authorName = (e.Author || "").replace(/\s*\(@[^)]*\)\s*$/, "").trim();
  const tags = String(e.Tags || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 5);
  const item = {
    id, title: clean(e.title).slice(0, 120), category: catId, tags, summary: clean(e.desc), prompt: null,
    handle: t && t.handle ? t.handle : "@" + screen, name: t && t.name ? t.name : authorName || screen,
    url: `https://x.com/${screen}/status/${id}`, platform: "x", status_id: id,
    posted_at: t && t.created_at ? new Date(t.created_at).toISOString() : null,
    tweet_text: t && t.text ? t.text : null,
    likes: t ? Number(t.likes || 0) : 0, reposts: 0, replies: t ? Number(t.replies || 0) : 0, views: 0,
    has_media: Boolean(t && (t.photos.length || t.video)), library_category: null,
    text_source: t && t.text ? "tweet" : "catalog-summary", via: "shipwithmuse.live", filed: e.Filed || null,
  };
  if (t) { media[id] = { name: t.name, handle: t.handle, avatar: t.avatar, verified: t.verified, photos: t.photos, video: t.video }; withText++; }
  cats.get(catId).items.push(item);
}
const categories = [...cats.values()].map((c) => ({ ...c, count: c.items.length }));
const total = categories.reduce((n, c) => n + c.count, 0);
const out = {
  title: "Muse builds from public posts", product: "Meta Muse", updated: new Date().toISOString().slice(0, 10),
  disclaimer: "Outcomes are what the poster reported. Built with Muse did not verify them. Posts with text_source tweet are the author's own words; catalog-summary posts are condensed and link to the original.",
  sources: ["X posts first catalogued by shipwithmuse.live (Mohith Kumar), read from X on " + new Date().toISOString().slice(0, 10)],
  group: "Builds and tools", total, with_tweet_text: withText, categories,
};
fs.writeFileSync(path.join(__dirname, "..", "seed", "muse-builds.json"), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(__dirname, "..", "seed", "muse-builds-media.json"), JSON.stringify(media, null, 1));
console.log(JSON.stringify({ imported: total, withText, dropped, alreadyOurs: dup, perCategory: categories.map((c) => [c.id, c.count]) }));
