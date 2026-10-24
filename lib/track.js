"use strict";

// Helpers for the sponsor analytics: who is a person, what device they are on.
// Kept free of the database so they can be tested on their own.

const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|monitor|curl|wget|python|httpclient|okhttp|go-http-client|java\/|libwww|scrapy|phantomjs|axios|node-fetch|undici|embedly|whatsapp|telegram|discord|skype/i;

function isBot(ua) {
  if (!ua) {
    return true;
  }
  return BOT_UA.test(String(ua));
}

function deviceOf(ua) {
  const s = String(ua || "");
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(s)) {
    return "tablet";
  }
  if (/mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini/i.test(s)) {
    return "mobile";
  }
  return "desktop";
}

// A page path from the site itself, or null. Never a full foreign URL.
function cleanPath(value) {
  const s = String(value || "").trim();
  if (!s.startsWith("/") || s.startsWith("//")) {
    return null;
  }
  return s.slice(0, 200);
}

// The referring host when it is not this site, else null.
function cleanRef(value, ownHost) {
  try {
    const host = new URL(String(value || "")).hostname.toLowerCase();
    if (!host || host === ownHost || host === "www." + ownHost) {
      return null;
    }
    return host.slice(0, 120);
  } catch (_) {
    return null;
  }
}

function cleanTag(value, max) {
  const s = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  return s ? s.slice(0, max || 40) : null;
}

module.exports = { isBot, deviceOf, cleanPath, cleanRef, cleanTag };
