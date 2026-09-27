"use strict";

// Pulls avatars and media for the X posts in seed/muse-use-cases.json from
// X's public syndication endpoint (the one the embedded tweet widget uses),
// and writes seed/muse-use-cases-media.json keyed by status id. Re-run to
// refresh; posts that fail are simply left out.
//
//   node scripts/enrich-posts.js

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "seed", "muse-use-cases.json");
const OUT = path.join(__dirname, "..", "seed", "muse-use-cases-media.json");

async function fetchTweet(id) {
  const resp = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=0`, { headers: { "user-agent": "Mozilla/5.0 (compatible; BuiltWithMuse/1.0)" }, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error("http " + resp.status);
  const d = await resp.json();
  if (!d || !d.id_str) throw new Error("no tweet");
  const photos = (d.photos || []).map((p) => p.url).filter(Boolean);
  const video = (d.mediaDetails || []).find((m) => m.type === "video" || m.type === "animated_gif");
  return {
    name: d.user && d.user.name, handle: d.user && d.user.screen_name ? "@" + d.user.screen_name : null,
    avatar: d.user && d.user.profile_image_url_https ? d.user.profile_image_url_https.replace("_normal", "_200x200") : null,
    verified: Boolean(d.user && (d.user.is_blue_verified || d.user.verified)),
    photos, video: video ? { poster: video.media_url_https, url: (video.video_info && (video.video_info.variants || []).filter((v) => v.content_type === "video/mp4").sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || {}).url || null } : null,
    likes: d.favorite_count, replies: d.conversation_count, text: d.text,
  };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const items = data.categories.flatMap((c) => c.items).filter((i) => i.platform === "x" && i.status_id);
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  let ok = 0, fail = 0;
  for (const item of items) {
    try { out[item.status_id] = await fetchTweet(item.status_id); ok += 1; }
    catch (err) { fail += 1; console.error("skip", item.status_id, err.message); }
    await new Promise((r) => setTimeout(r, 150));
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const withPhotos = Object.values(out).filter((m) => m.photos.length).length;
  const withVideo = Object.values(out).filter((m) => m.video).length;
  console.log(JSON.stringify({ posts: items.length, fetched: ok, failed: fail, withPhotos, withVideo, avatars: Object.values(out).filter((m) => m.avatar).length }));
}
main().catch((e) => { console.error(e); process.exit(1); });
