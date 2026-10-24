"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { isBot, deviceOf, cleanPath, cleanRef, cleanTag } = require("../lib/track");

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/604.1";
const ANDROID_TAB = "Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36";

test("crawlers and scripts are bots, browsers are people", () => {
  for (const ua of ["Googlebot/2.1", "Mozilla/5.0 (compatible; bingbot/2.0)", "curl/8.6.0", "facebookexternalhit/1.1", "HeadlessChrome/120", "Slackbot-LinkExpanding 1.0", "", null]) {
    assert.strictEqual(isBot(ua), true, String(ua));
  }
  for (const ua of [CHROME, IPHONE, IPAD]) {
    assert.strictEqual(isBot(ua), false, ua);
  }
});

test("device from user agent", () => {
  assert.strictEqual(deviceOf(CHROME), "desktop");
  assert.strictEqual(deviceOf(IPHONE), "mobile");
  assert.strictEqual(deviceOf(IPAD), "tablet");
  assert.strictEqual(deviceOf(ANDROID_TAB), "tablet");
  assert.strictEqual(deviceOf(""), "desktop");
});

test("paths, referrers and tags are cleaned", () => {
  assert.strictEqual(cleanPath("/sponsor?x=1"), "/sponsor?x=1");
  assert.strictEqual(cleanPath("https://evil.example/"), null);
  assert.strictEqual(cleanPath("//evil.example"), null);
  assert.strictEqual(cleanRef("https://www.google.com/search?q=muse", "builtwithmuse.com"), "www.google.com");
  assert.strictEqual(cleanRef("https://builtwithmuse.com/blog", "builtwithmuse.com"), null);
  assert.strictEqual(cleanRef("not a url", "builtwithmuse.com"), null);
  assert.strictEqual(cleanTag("Home Claim!"), "homeclaim");
  assert.strictEqual(cleanTag(""), null);
});
