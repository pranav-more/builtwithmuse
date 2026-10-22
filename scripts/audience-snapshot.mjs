// Writes public/data/audience.json from Vercel Web Analytics (production only), for the sponsor page.
// Aggregates only: totals, a daily series, and top countries, sources and devices. Nothing per visitor.
// Run: node scripts/audience-snapshot.mjs   (needs the Vercel CLI logged in to the pranav-mores-projects team)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const METRIC = "vercel.analytics_pageview.count";
const KEY_V = "vercel_analytics_pageview_count_unique_visitor_id";
const KEY_P = "vercel_analytics_pageview_count_sum";
function q(args) {
  const out = execFileSync("vercel", ["metrics", METRIC, "--prod", "--format", "json", "--project", "builtwithmuse", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  return JSON.parse(out);
}
const total = (d, key) => (d.summary && d.summary[0] ? d.summary[0][key] : 0) || 0;

const visitors30 = total(q(["--since", "30d", "-a", "unique/visitor_id"]), KEY_V);
const pageviews30 = total(q(["--since", "30d"]), KEY_P);
const visitors7 = total(q(["--since", "7d", "-a", "unique/visitor_id"]), KEY_V);
const pageviews7 = total(q(["--since", "7d"]), KEY_P);

const dailyV = q(["--since", "30d", "-g", "1d", "-a", "unique/visitor_id"]).data || [];
const dailyP = q(["--since", "30d", "-g", "1d"]).data || [];
const pvByDay = Object.fromEntries(dailyP.map((r) => [r.timestamp.slice(0, 10), r[KEY_P] || 0]));
const daily = dailyV.map((r) => ({ day: r.timestamp.slice(0, 10), visitors: r[KEY_V] || 0, pageviews: pvByDay[r.timestamp.slice(0, 10)] || 0 }));

const names = new Intl.DisplayNames(["en"], { type: "region" });
const countries = (q(["--since", "30d", "-a", "unique/visitor_id", "--group-by", "country", "-l", "8"]).summary || [])
  .filter((r) => r.country)
  .map((r) => ({ code: r.country, name: (() => { try { return names.of(r.country); } catch { return r.country; } })(), visitors: r[KEY_V] }))
  .sort((a, b) => b.visitors - a.visitors).slice(0, 6);

// Sources: group referrer hosts into buckets a sponsor recognises.
const BUCKETS = [
  ["AI assistants", /chatgpt|openai|perplexity|claude|gemini|copilot|meta\.ai|grok/i],
  ["Search", /google\.|bing\.|duckduckgo|yahoo\.|ecosia|brave|yandex|baidu|kagi|qwant|startpage|naver|seznam|search/i],
  ["Social", /(^|\.)(t\.co|x\.com|twitter|facebook|instagram|threads|linkedin|reddit|youtube|tiktok|lnkd|pinterest|discord|whatsapp|telegram)/i],
];
const refs = q(["--since", "30d", "-a", "unique/visitor_id", "--group-by", "referrer_hostname", "-l", "200"]).summary || [];
const src = { Direct: 0, Search: 0, "AI assistants": 0, Social: 0, "Other sites": 0 };
const topSites = [];
for (const r of refs) {
  const host = (r.referrer_hostname || "").replace(/^www\./, "");
  const n = r[KEY_V] || 0;
  if (!host || /builtwithmuse\.com$/.test(host)) { src.Direct += n; continue; }
  const b = BUCKETS.find(([, rx]) => rx.test(host));
  if (b) src[b[0]] += n; else { src["Other sites"] += n; topSites.push({ host, visitors: n }); }
}
const srcTotal = Object.values(src).reduce((a, b) => a + b, 0) || 1;
const sources = Object.entries(src).filter(([, n]) => n > 0).map(([name, n]) => ({ name, visitors: n, share: n / srcTotal })).sort((a, b) => b.visitors - a.visitors);

const dev = q(["--since", "30d", "-a", "unique/visitor_id", "--group-by", "device_type", "-l", "5"]).summary || [];
const devTotal = dev.reduce((a, r) => a + (r[KEY_V] || 0), 0) || 1;
const devices = dev.filter((r) => r.device_type).map((r) => ({ type: r.device_type, share: (r[KEY_V] || 0) / devTotal }));

const out = { updated: new Date().toISOString(), source: "Vercel Web Analytics, production", visitors30, pageviews30, visitors7, pageviews7, daily, countries, countriesTotal: visitors30, sources, devices, topSites: topSites.sort((a, b) => b.visitors - a.visitors).slice(0, 5) };
writeFileSync(new URL("../public/data/audience.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ visitors30, pageviews30, visitors7, pageviews7, days: daily.length, countries: countries.map((c) => `${c.code} ${c.visitors}`), sources: sources.map((s) => `${s.name} ${Math.round(s.share * 100)}%`), devices: devices.map((d) => `${d.type} ${Math.round(d.share * 100)}%`), topSites: out.topSites }));
