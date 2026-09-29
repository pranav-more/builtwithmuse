"use strict";

// Local development server: serves public/ and the API from lib/api.js, the
// same code Vercel runs as a serverless function. Not used in production.
//
//   DATABASE_URL=postgres://localhost/builtwithmuse_dev DEVICE_SECRET=dev ADMIN_TOKEN=dev node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handle, pageRoute } = require("./lib/api");

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

// Mirrors Vercel's cleanUrls: /x serves x.html, /dir serves dir/index.html.
function resolveFile(pathname) {
  const clean = decodeURIComponent(pathname).replace(/\/+$/, "") || "/";
  if (clean.includes("..")) return null;
  const candidates = clean === "/" ? ["/index.html"] : [clean, clean + ".html", clean + "/index.html"];
  for (const c of candidates) {
    const full = path.join(ROOT, c);
    try { if (fs.statSync(full).isFile()) return full; } catch (_) {}
  }
  return null;
}

// Vercel serves public/404.html for unknown paths on its own; the dev server
// mirrors that so the page can be checked locally.
function serveNotFound(res) {
  const page = path.join(ROOT, "404.html");
  fs.readFile(page, (err, html) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
  });
}
function serveStatic(req, res, url) {
  const full = resolveFile(url.pathname);
  if (!full) return serveNotFound(res);
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) return serveNotFound(res);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] || "application/octet-stream", "Content-Length": stat.size, "Cache-Control": "no-cache" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/") || pageRoute(url.pathname)) return handle(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end("Method not allowed"); }
    serveStatic(req, res, url);
  })
  .listen(PORT, "0.0.0.0", () => console.log(`builtwithmuse dev server on http://localhost:${PORT}`));
