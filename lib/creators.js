"use strict";

// Creator Pool: creator accounts, workflows, ratings, reports and the server
// rendered public pages. Mounted from lib/api.js, which passes in its shared
// helpers (database pool, cookies, Google token check, admin identity).
//
// Public reads
//   GET  /api/v1/categories
//   GET  /api/v1/workflows?sort=top|most|new&category=&q=&page=
//   GET  /api/v1/workflows/:slug
//   GET  /api/v1/creators/:handle
// Sign in (Google, verified server side)
//   GET  /api/v1/auth/config
//   POST /api/v1/auth/google        { credential }
//   POST /api/v1/auth/logout
// Creator writes (session cookie, fetch header required)
//   GET    /api/v1/me
//   POST   /api/v1/me/profile        create after first sign in
//   PATCH  /api/v1/me/profile
//   POST   /api/v1/me/deactivate
//   POST   /api/v1/workflows         create draft
//   GET    /api/v1/me/workflows/:id
//   PATCH  /api/v1/workflows/:id
//   POST   /api/v1/workflows/:id/publish
//   POST   /api/v1/workflows/:id/unpublish
//   DELETE /api/v1/workflows/:id            (owner; not while published)
//   DELETE /api/v1/comments/:id             (author or workflow owner)
// Device writes (device cookie)
//   PUT    /api/v1/workflows/:id/rating   { score }
//   DELETE /api/v1/workflows/:id/rating
//   POST   /api/v1/workflows/:id/report   { reason, detail }
// Pages (rewritten from /workflows, /workflows/:slug, /creators/:handle)
//   GET /api/pages/workflows, /api/pages/workflows/:slug, /api/pages/creators/:handle, /api/pages/sitemap
// Admin (moderator session or ADMIN_TOKEN)
//   GET  /api/admin/pool/overview
//   GET  /api/admin/pool/reports
//   GET  /api/admin/pool/workflows?status=
//   POST /api/admin/pool/workflows/:id/hide | restore | remove
//   POST /api/admin/pool/reports/:id/resolve | dismiss
//   POST /api/admin/pool/creators/:id/status { status }
// Feed (quick posts and articles)
//   GET  /api/pages/feed, /api/pages/feed/new, /api/pages/feed/:id
//   POST   /api/v1/feed               { kind: "quick"|"article", title?, body }
//   POST   /api/v1/feed/:id/like      toggle, one per account
//   POST   /api/v1/feed/:id/repost    toggle, one per account
//   POST   /api/v1/feed/:id/comments  { body }
//   DELETE /api/v1/feed/comments/:id  comment author or post author
//   DELETE /api/v1/feed/:id           author only
//   GET  /api/admin/pool/feed?status=published|removed
//   POST /api/admin/pool/feed/:id/remove | restore

const crypto = require("crypto");
const { layout, esc, SITE } = require("./pages");
const { dashboardPage } = require("./dashboard");
const { submitPage } = require("./submit");
const wild = require("./wild");

// Share kit (flywheel step 3): pre filled post actions on every workflow page.
// PLATFORM_HANDLE is the platform X account. X posts tag it through the via
// parameter; Threads posts carry it in the text.
const PLATFORM_HANDLE = "builtwithmusehq";
// FEATURED_SLUGS holds the editors current featured pick. A featured
// workflow page carries a Featured badge. One pick at a time, rotated weekly.
const FEATURED_SLUGS = ["get-what-you-need-from-instagram-without-opening-it"];
const KIT_CSS = `.kit-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
.kit-label { font-size: 13px; font-weight: 700; color: var(--muted); }`;
const FAQ_CSS = `.faq { margin: 30px 0 4px; } .faq h2 { margin: 0 0 6px; } .faq h3 { margin: 16px 0 5px; font-size: 16px; } .faq p { margin: 0; color: var(--muted); line-height: 1.55; }`;
const ARTIFACT_CSS = `.row-shot { display: block; width: 100%; border-radius: 10px; border: 1px solid var(--line); margin: 10px 0 2px; } .artifact-cta-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }`;
const KIT_JS = `
      (() => {
        const trackEvent = (n) => { try { if (typeof window.clarity === "function") window.clarity("event", n); } catch (_) {} };
        document.querySelectorAll("[data-kit]").forEach((el) => el.addEventListener("click", async () => {
          const kind = el.dataset.kit;
          trackEvent("share_kit_" + kind);
          if (kind !== "copy") return;
          const st = document.getElementById("kit-status");
          try { await navigator.clipboard.writeText(el.dataset.kitUrl); if (st) { st.textContent = "Link copied."; setTimeout(() => { st.textContent = ""; }, 2000); } }
          catch (_) { if (st) st.textContent = el.dataset.kitUrl; }
        }));
      })();`;

const CREATOR_COOKIE = "bwm_c";
const SIGNUP_COOKIE = "bwm_s";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SIGNUP_SECONDS = 20 * 60;
const HANDLE_RE = /^[A-Za-z0-9_]{3,30}$/;
const RESERVED_HANDLES = new Set(["admin", "administrator", "moderator", "mod", "builtwithmuse", "muse", "meta", "official", "support", "help", "api", "creator", "creators", "workflow", "workflows", "about", "privacy", "blog", "login", "signin", "signup", "me", "editorial", "team", "staff", "root", "system", "null", "undefined"]);
const HANDLE_COOLDOWN_DAYS = 30;
const LIMITS = {
  title: [10, 70], summary: [1, 160], problem: [1, 1000], result: [1, 1000], step: [1, 1000], prompt: [0, 1000],
  steps: [2, 15], prerequisites: [0, 10], prerequisite: [1, 200], bio: [0, 400], displayName: [2, 60], detail: [0, 500],
};
const RATE = {
  rating: { device: { hour: 30, day: 120 }, ip: { hour: 60, day: 300 } },
  report: { device: { hour: 5, day: 15 }, ip: { hour: 10, day: 40 } },
  login: { ip: { hour: 20, day: 80 } },
};
const PUBLISH_CAP = { firstDay: 3, perDay: 10, drafts: 60 };
const PAGE_SIZE = 24;
const REPORT_REASONS = ["spam", "unsafe", "stolen", "other"];
// Reactions a visitor can leave without an account. Kind, emoji, label.
const REACTION_KINDS = [["works", "\u{1F525}", "Works"], ["clever", "\u{1F4A1}", "Clever"], ["time", "\u23F1\uFE0F", "Saved me time"]];
const RATE_REACT = { device: { hour: 60, day: 300 }, ip: { hour: 120, day: 600 } };

let deps = null;
let pool = null;

// Idempotent Creator Pool schema. Runs on every boot (cold start); every
// statement is guarded so re-running is safe.
const CREATOR_SCHEMA = `
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS x_url TEXT;
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS youtube_url TEXT;
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS tiktok_url TEXT;
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS threads_url TEXT;
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS screenshot_url TEXT;
CREATE TABLE IF NOT EXISTS workflow_saves (
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, device_id)
);
CREATE TABLE IF NOT EXISTS workflow_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  hidden_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id UUID NOT NULL REFERENCES workflow_comments(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, creator_id)
);
CREATE TABLE IF NOT EXISTS comment_reports (
  id SERIAL PRIMARY KEY,
  comment_id UUID NOT NULL REFERENCES workflow_comments(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (comment_id, device_id)
);
-- One account for everything: a first Google sign in creates a minimal
-- profile at once (auto handle, not yet claimed) so claiming a code never
-- forces anyone through creator onboarding. Saves are keyed to the creator
-- once signed in; old device rows keep counting.
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS handle_claimed BOOLEAN NOT NULL DEFAULT true;
-- Step 7: weekly digest opt in, ticked on the claim success panel and
-- written through POST /api/digest-optin in lib/api.js.
ALTER TABLE creator_profiles ADD COLUMN IF NOT EXISTS digest_opt_in BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE workflow_saves ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES creator_profiles(id) ON DELETE CASCADE;
ALTER TABLE workflow_saves DROP CONSTRAINT IF EXISTS workflow_saves_pkey;
ALTER TABLE workflow_saves ALTER COLUMN device_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_saves_device_uidx ON workflow_saves (workflow_id, device_id) WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_saves_creator_uidx ON workflow_saves (workflow_id, creator_id) WHERE creator_id IS NOT NULL;
-- Creator follows: one row per follower -> followed pair. A creator cannot
-- follow themselves and cannot follow the editorial team profile.
CREATE TABLE IF NOT EXISTS creator_follows (
  follower_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  followed_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
-- Reactions: one tap per device per kind, no account needed. The cheapest
-- possible signal that a workflow landed for someone.
CREATE TABLE IF NOT EXISTS workflow_reactions (
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('works', 'clever', 'time')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, device_id, kind)
);
CREATE INDEX IF NOT EXISTS workflow_reactions_workflow_idx ON workflow_reactions (workflow_id);
-- The creator's own Muse share link (muse.ai/s/...), so readers can open the
-- original and creators can point their audience at one page.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS muse_url TEXT;
-- Batch 32: a workflow row can be an artifact instead: the finished thing
-- itself (image and or text) plus the prompt behind it. Same table, same
-- reactions, comments, saves and moderation; only the rendering differs.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'workflow';
-- "Others" catch all category for workflows that do not fit the list.
INSERT INTO categories (slug, name, position) VALUES ('others', 'Others', 110)
ON CONFLICT (slug) DO NOTHING;
-- Community X posts for the Social feed. A creator submits their own post
-- link, we fetch the public post once, and only approved rows appear
-- publicly. Rejected rows are kept for the record.
CREATE TABLE IF NOT EXISTS wild_community_posts (
  id TEXT PRIMARY KEY,
  tweet_url TEXT NOT NULL,
  creator_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  author_name TEXT,
  author_handle TEXT,
  author_avatar TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  text TEXT,
  posted_at TIMESTAMPTZ,
  photos TEXT[] NOT NULL DEFAULT '{}',
  likes INT NOT NULL DEFAULT 0,
  reposts INT NOT NULL DEFAULT 0,
  replies INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS wild_community_posts_status_idx ON wild_community_posts (status, created_at DESC);
-- Video on community posts, added after launch. The syndication payload
-- carries mp4 variants; we keep the best one plus the poster frame.
ALTER TABLE wild_community_posts ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE wild_community_posts ADD COLUMN IF NOT EXISTS video_poster TEXT;
-- Feed: one table for the two post kinds. A quick post is short
-- plain text and an article carries a title and a long body. The
-- source_url column is legacy and unused: nothing writes or renders it.
-- Status is the
-- moderation switch: published shows everywhere, removed shows nowhere.
-- Likes are one per account across every kind. The kind check and the
-- workflow_slug column still accept a legacy workflow value from the
-- first feed version, but nothing writes or renders those rows anymore:
-- workflows live on their own pages, never in the feed.
CREATE TABLE IF NOT EXISTS feed_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'quick' CHECK (kind IN ('quick', 'article', 'workflow')),
  title TEXT,
  body TEXT,
  source_url TEXT,
  workflow_slug TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_posts_created_idx ON feed_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS feed_posts_creator_idx ON feed_posts (creator_id, created_at DESC);
CREATE TABLE IF NOT EXISTS feed_likes (
  post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, creator_id)
);
-- Comments on feed posts: plain text like the posts themselves.
-- Status is the moderation switch, same as posts: published shows,
-- removed shows nowhere. Deleting a post takes its comments with it.
CREATE TABLE IF NOT EXISTS feed_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_comments_post_idx ON feed_comments (post_id, created_at DESC);
-- Reposts: one per account per post, like likes. A repost puts the
-- original post back into the stream at the repost time, credited to
-- the reposter; removing the original removes every entry with it.
CREATE TABLE IF NOT EXISTS feed_reposts (
  post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES creator_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, creator_id)
);
CREATE INDEX IF NOT EXISTS feed_reposts_created_idx ON feed_reposts (created_at DESC);
`;
async function ensureCreatorSchema(attempts = 12) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query(CREATOR_SCHEMA);
      await pool.query("UPDATE creator_profiles SET display_name = 'Built with Muse editorial' WHERE is_editorial AND display_name = 'Jayesh'");
      try { await seedEditorialWorkflows21(); } catch (err) { console.error("editorial seed 21 failed", err.code || "", err.message); }
      return;
    } catch (err) {
      if (i === attempts) console.error("creator schema init failed", err.code || "", err.message);
      else await new Promise((r) => setTimeout(r, Math.min(700 * i, 4000)));
    }
  }
}

// Editorial seed: 21 researched Muse workflows (2026-09-26), written up by
// the Built with Muse team from public user reports. Idempotent: new slugs
// insert once; the two stub upgrades apply only while the old marketing
// proof URL is still in place, so human edits are never clobbered.
const EDITORIAL_NEW_21 = [
  {
    "slug": "switch-car-insurance-with-muse",
    "title": "Switch car insurance and keep your savings",
    "summary": "Users report uploading their policy and getting an identical coverage quote hundreds or thousands cheaper, then buying and canceling the plan in one session.",
    "problem": "Car insurance renews quietly every year and most people never re shop it, so premiums creep up while cheaper identical coverage sits one quote away.",
    "result": "Multiple users report real savings. Joe Devoy uploaded his policy and Muse found a $3,500 per year cheaper policy with identical coverage, bought it, and canceled the old one in about 5 minutes. JasonL_Capital uploaded his policy from the gym and was saving $1,156 per year within 15 minutes. Demand was high enough that Insurify publicly blocked Muse from scraping its insurance marketplace.",
    "prompt": "Here is my current car insurance policy. Find me cheaper quotes with identical coverage from real insurers, show me the side by side comparison, and once I pick one, help me buy the new policy and cancel the old one.",
    "steps": [
      "Upload your current policy document to Muse",
      "Ask for cheaper quotes with identical coverage",
      "Review the side by side comparison",
      "Buy the new policy through Muse",
      "Have Muse cancel the old policy"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your current insurance policy document"
    ],
    "category": "money",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "insurance",
      "money",
      "savings",
      "auto"
    ]
  },
  {
    "slug": "shop-with-live-discount-codes",
    "title": "Shop with live discount codes applied",
    "summary": "Users report Muse finding a product, hunting live coupon codes, filling the cart, and checking out at the lowest price it can find.",
    "problem": "Finding the lowest price means opening ten tabs and testing coupon codes that expired years ago. Note that Amazon blocked Muse from shopping on its platform during the launch window, so results vary by store.",
    "result": "Multiple users report completed purchases. One user had Muse hunt a green puffer jacket with live discount codes until it found the cheapest price. Nicolas Bustamante had socks, groceries, and a burger ordered within 24 hours, with Muse picking the burger spot itself.",
    "prompt": "I want to buy [product]. Find it at the lowest real price, hunt for live discount codes, fill the cart, and show me the final total before you check out.",
    "steps": [
      "Tell Muse the exact product you want",
      "Ask it to hunt for live discount codes",
      "Review the cheapest cart it builds",
      "Approve the final total and check out"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your login for the store site"
    ],
    "category": "shopping",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "shopping",
      "coupons",
      "deals",
      "savings"
    ]
  },
  {
    "slug": "claim-flight-delay-compensation",
    "title": "Claim flight delay compensation fast",
    "summary": "Users report Muse filing delay compensation, watching fares for price drops, and chatting with airlines to rebook or refund.",
    "problem": "Airlines owe you money after long delays and fare drops, but the claim forms and hold music are designed to make you give up.",
    "result": "Multiple users report money back. After a 7 hour delay, Ejaaz had Muse file for compensation and got a $250 Delta credit in 5 minutes, plus a rebooked flight and a replied support email. One fare watcher had Muse track a United fare for weeks and pulled back a $1,026 flight credit after a price drop. Heshie Brody had Muse chat with American Airlines by text, cancel the flights, and secure a full refund.",
    "prompt": "My flight [airline and flight number] was delayed [or: watch this fare for a price drop]. File for the compensation I am owed, handle the airline chat or forms, and confirm the credit or refund in my account.",
    "steps": [
      "Give Muse your flight details or booking",
      "Ask it to file the delay compensation claim",
      "Let it chat with the airline or fill the forms",
      "Confirm the credit or refund lands"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your airline booking details"
    ],
    "category": "travel",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "travel",
      "flights",
      "refunds",
      "money"
    ]
  },
  {
    "slug": "book-restaurants-and-appointments",
    "title": "Book restaurants and appointments hands free",
    "summary": "Users report Muse booking restaurants, event tickets, and barbers, including negotiating in Japanese with a hotel for a dinner slot.",
    "problem": "Booking means the phone calls, the hold music, and the tabs of reviews nobody has time for, worse in a foreign language.",
    "result": "Multiple users report completed bookings. One traveler had Muse book every restaurant on a Japan trip, including negotiating in Japanese with a Hakone hotel for an off site dinner slot. Alex Volkov had Muse book Rosh Hashanah dinner tickets with allergy notes, beating a rival agent on the same task. Ahmed Yasser had Muse find and book a barber under $50 for Sunday at 11:30 after checking reviews.",
    "prompt": "Book [restaurant or appointment] for [date, time, party size]. Check reviews first, handle the booking or call, and confirm the reservation details back to me.",
    "steps": [
      "Tell Muse what, when, and for how many",
      "Let it check reviews and availability",
      "Approve the option it recommends",
      "Get the confirmation details"
    ],
    "prerequisites": [
      "Muse app with a US account"
    ],
    "category": "life-admin",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "booking",
      "restaurants",
      "appointments"
    ]
  },
  {
    "slug": "let-muse-call-businesses-for-you",
    "title": "Let Muse call businesses for you",
    "summary": "Users report Muse dialing businesses to beat phone trees, check stock, and haggle, then patching them in live when a human is needed.",
    "problem": "Phone trees and hold music exist to make you hang up before a human ever picks up.",
    "result": "Multiple users report Muse making real calls. raunaq had Muse call Xfinity, beat the phone tree, haggle the bill, and patch him in live for a verification text. mattprd had Muse call Tesla to check Model YL availability and posted the transcript. Frank Chien had Muse handle an insurance business call and sort a cancellation. One caveat from the reporting: Reuters found Meta had quietly used human contractors behind some calls during testing, so not every early call was purely the AI.",
    "prompt": "Call [business] about [issue]. Beat the phone tree, handle the hold, and patch me in live if they need my verification. Report back with what was agreed.",
    "steps": [
      "Give Muse the business name and number",
      "Tell it exactly what to ask or negotiate",
      "Stay reachable for a live patch in",
      "Confirm the outcome it reports"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your phone nearby for verification"
    ],
    "category": "life-admin",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "calls",
      "business",
      "support",
      "booking"
    ]
  },
  {
    "slug": "daily-inbox-triage-with-muse",
    "title": "Daily inbox triage without opening email",
    "summary": "Users report getting a daily digest of only the important emails, with one reviewer saying Muse handled it admirably well.",
    "problem": "The inbox fills faster than anyone can read, and the important message drowns between newsletters and receipts.",
    "result": "Multiple users report working digests. A Business Insider reviewer asked for a daily digest of important emails and said Muse did it admirably well across a 7 day test. A TechRadar tester used Muse on a utility email about a solar panel visit. Peter Yang demoed checking important messages on video.",
    "prompt": "Every morning, scan my inbox and send me a short digest of only the emails that actually need my attention, with one line on why each matters.",
    "steps": [
      "Connect your email to Muse",
      "Ask for a daily digest of important mail",
      "Skim the digest each morning",
      "Tell Muse what counts as important to refine it"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your email connected"
    ],
    "category": "productivity",
    "proof_url": "https://postgoo.com/posts/6aaf34b69f95d1e2355b9b78?type=article",
    "tags": [
      "email",
      "inbox",
      "digest",
      "productivity"
    ]
  },
  {
    "slug": "find-and-cancel-forgotten-subscriptions",
    "title": "Find and cancel forgotten subscriptions",
    "summary": "Users report Muse surfacing subscriptions they forgot, canceling them, and clawing back refunds, one a full year of charges.",
    "problem": "Subscriptions renew silently and free trials convert when you forget, draining money every month for services you never open.",
    "result": "Multiple users report found money. Chris Abraham had Muse find his wife's forgotten monthly book subscription running over a year, cancel it, and get the full year refunded. armand had Muse chase $192 in Amazon returns, a $230 IKEA return, and a $516 vet claim as part of $2,120.95 recovered in total. A Business Insider reviewer ran a subscription audit and kept only what was worth it.",
    "prompt": "Audit my subscriptions. Find every recurring charge, flag the ones I have not used recently, cancel what I approve, and ask for refunds where I was charged for nothing.",
    "steps": [
      "Let Muse scan your statements for recurring charges",
      "Review the forgotten subscriptions it flags",
      "Approve the cancellations",
      "Have it request refunds on unused charges"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your card statements or bank login"
    ],
    "category": "money",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "money",
      "subscriptions",
      "refunds",
      "savings"
    ]
  },
  {
    "slug": "podcast-and-youtube-admin-on-autopilot",
    "title": "Put podcast and YouTube admin on autopilot",
    "summary": "One creator reported Muse running an SEO audit, writing smart chapters, and updating YouTube metadata as an Editor.",
    "problem": "Publishing a podcast episode means SEO, chapters, descriptions, and link checks, hours of admin for every hour of audio.",
    "result": "One user reported a full admin run. Christina Pan had Muse do an SEO audit of her YouTube podcast, create smart chapters, log into YouTube as an Editor with a vaulted credential, update video descriptions, and verify every timestamp link worked. She noted a rival agent actually produced a better SEO audit, so this one is promising but not yet best in class.",
    "prompt": "Audit my latest podcast episode for SEO, write smart chapters with timestamps, update the YouTube description, and verify every link works.",
    "steps": [
      "Connect Muse to your YouTube channel as Editor",
      "Point it at your latest episode",
      "Review the SEO audit and chapters",
      "Approve the metadata updates"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your YouTube login"
    ],
    "category": "creators",
    "proof_url": "https://sfchris.medium.com/i-found-magic-with-muse-metas-ai-personal-assistant-e410a6030c72",
    "tags": [
      "creators",
      "podcast",
      "youtube",
      "seo"
    ]
  },
  {
    "slug": "playlists-and-podcasts-built-by-chat",
    "title": "Build playlists and podcasts by chatting",
    "summary": "One user reported building a 20 song Spotify playlist on command, with daily recurring updates handled by Muse.",
    "problem": "Playlists go stale and building a fresh one takes longer than the mood lasts.",
    "result": "One user reported it working end to end. Matt Deitke had Muse build a 20 song Spotify playlist on command, set daily recurring updates, and generate new podcasts into playlists.",
    "prompt": "Build me a 20 song Spotify playlist for [mood or activity], and update it with fresh tracks every day.",
    "steps": [
      "Connect your Spotify to Muse",
      "Describe the mood or activity",
      "Review the playlist it builds",
      "Set it to update daily"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your Spotify login"
    ],
    "category": "life-admin",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "music",
      "spotify",
      "playlists",
      "podcasts"
    ]
  },
  {
    "slug": "personal-stylist-from-your-measurements",
    "title": "Get a personal stylist from your measurements",
    "summary": "Two users reported feeding Muse their measurements, photos, stores, and budgets and getting complete outfits built around a hero piece.",
    "problem": "Looking good means knowing your measurements, your stores, and what goes with what, all at once, every morning.",
    "result": "Two users reported working setups. shriyanevatia gave Muse her height, weight, measurements, photos, top 20 stores, and budgets; Muse picks a hero piece and builds looks around it, iterating on feedback. Another user built a personal multi brand fashion app with try on views.",
    "prompt": "You are my stylist. My measurements are [list], my budget is [range], and I shop at [stores]. Pick a hero piece and build three complete looks around it.",
    "steps": [
      "Share your measurements, photos, and budgets",
      "List the stores you shop at",
      "Ask Muse to pick a hero piece and build looks",
      "Iterate on the looks you like"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your measurements and a few photos"
    ],
    "category": "shopping",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "fashion",
      "style",
      "shopping",
      "outfits"
    ]
  },
  {
    "slug": "family-and-school-admin-in-one-chat",
    "title": "Run family and school admin from one chat",
    "summary": "One reviewer tested Muse on school digests and party planning and hit real limits, useful to know before you rely on it.",
    "problem": "School apps, activity signups, and party planning scatter across a dozen logins and group chats, all due yesterday.",
    "result": "One detailed test mapped the limits honestly. A Business Insider reviewer asked Muse to digest school and activity notifications and got mixed results because nested apps stymied it. Trampoline park birthday planning failed because it needed real phone calls, and a Girl Scouts renewal failed at payment. Treat this as a know the limits entry: great for summarizing, not yet for booking and paying.",
    "prompt": "Summarize everything my kids school and activity apps need from me this week: forms, payments, and deadlines, in one short list.",
    "steps": [
      "Connect the school and activity apps you use",
      "Ask for a weekly digest of forms and deadlines",
      "Handle bookings and payments yourself",
      "Note which apps Muse cannot reach"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your school app logins"
    ],
    "category": "life-admin",
    "proof_url": "https://postgoo.com/posts/6aaf34b69f95d1e2355b9b78?type=article",
    "tags": [
      "family",
      "school",
      "kids",
      "planning"
    ]
  },
  {
    "slug": "rental-pl-and-claims-without-spreadsheets",
    "title": "Run your rental P&L without spreadsheets",
    "summary": "Users report Muse turning logins into rental profit statements, running a kids allowance bank, and filing a vet claim.",
    "problem": "Rental profit lives across property manager portals and mortgage statements, and reconciling it means spreadsheet Sundays.",
    "result": "Three users reported three distinct wins. AI News gave Muse property management and mortgage logins and got rent versus mortgage profit and loss statements. joecarlsonshow runs a kids family economy bank at 7 percent weekly interest with a daily scheduled ledger. armand had Muse file a $516 dog vet claim.",
    "prompt": "Here are my logins for [property manager] and [mortgage]. Build me a monthly profit and loss statement: rent in versus mortgage and costs out.",
    "steps": [
      "Connect your property and mortgage logins",
      "Ask for a monthly profit and loss",
      "Review the rent versus cost breakdown",
      "Set it to refresh monthly"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your property and mortgage logins"
    ],
    "category": "money",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "money",
      "rental",
      "finance",
      "claims"
    ]
  },
  {
    "slug": "run-your-small-business-by-texting-muse",
    "title": "Run your small business by texting Muse",
    "summary": "One user reported running his plumbing company from bed at 6am, dispatching jobs to staff by text.",
    "problem": "Small business mornings mean a job board, customer texts, and staff pings before coffee, all competing for attention.",
    "result": "One user reported a working morning routine. HouseHackerJon texts Muse from bed at 6am: update the job board, text the customer, notify the office manager on Slack, and alert the technician, all before getting up.",
    "prompt": "Every morning at 6am: update my job board with today's jobs, text each customer their arrival window, notify my office manager on Slack, and alert the technician on call.",
    "steps": [
      "Connect your job board, Slack, and messaging",
      "Define your morning dispatch routine",
      "Text Muse the day's jobs once",
      "Review the confirmations it sends back"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your job board and Slack connected"
    ],
    "category": "work",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "work",
      "business",
      "dispatch",
      "texting"
    ]
  },
  {
    "slug": "log-meals-by-texting-muse",
    "title": "Log meals by texting Muse",
    "summary": "One user reported ditching the food logging app and texting meals to Muse instead; a reviewer found the health coaching mixed.",
    "problem": "Food logging apps demand that you open the app, search the food, and tap through portions, so most people quit by Thursday.",
    "result": "Early and mixed. Alex Cohen gave Muse access to MyFitnessPal and texts meal info all day while Muse logs it, no more app UI. A Business Insider reviewer found the health coaching thinner: resting heart rate advice was trivial, an annual physical booking failed, and a period synced cookie order failed when menstrual data did not sync.",
    "prompt": "Log everything I text you about food into MyFitnessPal today, and give me a running calorie and protein total each evening.",
    "steps": [
      "Connect MyFitnessPal to Muse",
      "Text what you eat through the day",
      "Ask for a running daily total",
      "Review the logged entries weekly"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your MyFitnessPal login"
    ],
    "category": "health",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "health",
      "food",
      "fitness",
      "tracking"
    ]
  },
  {
    "slug": "dispute-credit-report-collections",
    "title": "Dispute credit report collections fast",
    "summary": "One user reported Muse filing disputes that removed two collections from a credit report within about an hour.",
    "problem": "Collections on a credit report drag your score for years, and disputing them means letters, portals, and waiting on hold.",
    "result": "One user reported a strikingly fast result. ChrisUniverse had Muse file credit disputes at 7:09pm and both collections were deleted by 8:25pm, within about an hour.",
    "prompt": "Pull my credit report, identify every collection account, and file a dispute for each one that looks inaccurate. Track the responses.",
    "steps": [
      "Give Muse access to your credit report",
      "Ask it to identify collection accounts",
      "Approve the disputes it drafts",
      "Track the removal confirmations"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your credit report access"
    ],
    "category": "money",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "money",
      "credit",
      "disputes",
      "finance"
    ]
  },
  {
    "slug": "negotiate-marketplace-deals-like-a-pro",
    "title": "Negotiate marketplace deals like a pro",
    "summary": "Users report Muse grinding sellers down on Facebook Marketplace, one winning a MacBook after 50 lowball offers.",
    "problem": "Marketplace haggling means messaging a dozen sellers, lowballing without insulting them, and losing the good listings to faster buyers.",
    "result": "Two users reported negotiation wins. Jean Marc Denis won a MacBook after Muse made 50 lowball offers. Peter Yang demoed shopping Facebook Marketplace with Muse on video, and one analyst called the find, negotiate, and pickup loop a distribution wedge for the agent.",
    "prompt": "Find [item] on Facebook Marketplace near me under [price]. Message sellers, negotiate the price down politely, and arrange pickup once one accepts.",
    "steps": [
      "Tell Muse the item and your max price",
      "Let it find listings and message sellers",
      "Approve the negotiated price",
      "Arrange pickup for the winning deal"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your Facebook login"
    ],
    "category": "shopping",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "shopping",
      "marketplace",
      "deals",
      "negotiation"
    ]
  },
  {
    "slug": "spot-hidden-fees-when-buying-a-car",
    "title": "Spot hidden fees when buying a car",
    "summary": "One user reported Muse spotting a $1,250 hidden dealer fee plus $250 in unneeded upsells during a lease buyout.",
    "problem": "Dealer paperwork hides fees in the fine print, and the finance office counts on you signing before you spot them.",
    "result": "One user reported a real time save. Nick Prince had Muse audit a lease buyout as it happened; it spotted a $1,250 hidden dealer fee plus $250 in unneeded upsells and explained the do it yourself process.",
    "prompt": "Audit this dealer quote line by line. Flag every fee that is not required and every upsell I do not need, and explain what I can do myself.",
    "steps": [
      "Share the dealer quote or buyout paperwork",
      "Ask Muse to audit every line",
      "Question the flagged fees with the dealer",
      "Skip the upsells you do not need"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "The dealer quote or paperwork"
    ],
    "category": "shopping",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "shopping",
      "cars",
      "fees",
      "money"
    ]
  },
  {
    "slug": "birthday-reminders-from-your-social-graph",
    "title": "Get birthday reminders from your social graph",
    "summary": "A single early report claims Muse pulled every friend's birthday off Facebook into calendar files. Lightly verified and experimental.",
    "problem": "Birthdays hide in Facebook profiles you never open, so you remember at midnight or not at all.",
    "result": "A single early report claims the win. BackseatVC posted that pulling every friend's birthday off Facebook into calendar files was the killer use case, with no details on how it ran. Treat this as lightly verified and experimental until more users confirm it.",
    "prompt": "Pull every friend's birthday from Facebook and add them to my calendar with a reminder one day before each.",
    "steps": [
      "Connect your Facebook to Muse",
      "Ask it to collect friends birthdays",
      "Review the calendar entries it creates",
      "Set reminders a day before each"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your Facebook login"
    ],
    "category": "life-admin",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "birthdays",
      "social",
      "calendar",
      "reminders"
    ]
  },
  {
    "slug": "get-paid-for-product-demos",
    "title": "Get paid for product demos",
    "summary": "A single early report claims Muse signed up for paid demo programs via Instagram and earned 3 AirPods plus a $200 gift card. Treat with skepticism.",
    "problem": "Companies pay for product feedback calls, but finding the programs, applying, and calendaring the calls is its own part time job.",
    "result": "A single early report claims the payout, presented skeptically. kanha korgaonkar posted that Muse signed up for product demo reward programs via Instagram, added the calls to a calendar, and earned 3 AirPods plus a $200 gift card. The challenge hashtag framing suggests possible engagement bait, so treat this as unverified until independent users confirm it.",
    "prompt": "Find legitimate paid product demo and user research programs, sign me up, and add every scheduled call to my calendar.",
    "steps": [
      "Ask Muse to find paid demo programs",
      "Review the programs before signing up",
      "Let it calendar the scheduled calls",
      "Track what you actually receive"
    ],
    "prerequisites": [
      "Muse app with a US account"
    ],
    "category": "money",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "money",
      "demos",
      "rewards",
      "sideincome"
    ]
  }
];
const EDITORIAL_UPGRADES_21 = [
  {
    "slug": "negotiate-your-internet-bill-down",
    "title": "Negotiate your internet bill down",
    "summary": "Multiple users report Muse cutting internet bills in half, one from $80 to $40 a month plus 3 months free.",
    "problem": "Internet bills creep up every year while new customers get the promo rate, and the retention department counts on you never calling.",
    "result": "Multiple users report big cuts. chanduiiit had Muse negotiate AT&T fiber from $80 to $40 per month plus 3 months free. Jason Luongo saved $1,920 over 24 months across two homes. raunaq had Muse call Xfinity, beat the phone tree, and haggle the bill live. Peter Yang posted a transcript of a $288 per year Comcast saving.",
    "prompt": "Call my internet provider and negotiate my bill down. Ask for the retention department, cite the new customer promo rate, and do not accept the first offer.",
    "steps": [
      "Give Muse your provider and account details",
      "Tell it your target monthly price",
      "Let it call or chat with support",
      "Confirm the new rate on your next bill"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your internet provider login"
    ],
    "category": "money",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "money",
      "bills",
      "internet",
      "savings"
    ]
  },
  {
    "slug": "turn-a-saved-recipe-reel-into-a-grocery-order",
    "title": "Turn a saved recipe reel into a grocery order",
    "summary": "Multiple users report Muse turning years of saved recipe reels into a cookbook, weekly meals, and a filled grocery cart.",
    "problem": "Saved recipe reels pile up for years and never become dinner, because turning a video into a shopping list is real work.",
    "result": "Multiple users report the saved folder finally paying off. Yusuf Ahmed had Muse turn 5 years of saved Instagram recipe reels into a cookbook. Jess had Muse pick weekly meals from saved posts and do the grocery shopping. buccocapital went from recipe straight to a Whole Foods cart.",
    "prompt": "Look through my saved Instagram recipe reels, pick this week's meals, and fill a grocery cart with everything I need.",
    "steps": [
      "Connect your Instagram saved posts",
      "Ask Muse to pick the week's meals",
      "Review the meal plan",
      "Approve the grocery cart checkout"
    ],
    "prerequisites": [
      "Muse app with a US account",
      "Your Instagram login"
    ],
    "category": "shopping",
    "proof_url": "https://www.museable.xyz/",
    "tags": [
      "food",
      "groceries",
      "recipes",
      "shopping"
    ]
  }
];
const EDITORIAL_STUB_PROOF = "https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/";
async function seedEditorialWorkflows21() {
  if (!EDITORIAL_NEW_21.length && !EDITORIAL_UPGRADES_21.length) return;
  const ed = await pool.query("SELECT id FROM creator_profiles WHERE is_editorial AND status = 'active' LIMIT 1");
  if (!ed.rows[0]) { console.error("editorial seed 21: no active editorial profile"); return; }
  const editorialId = ed.rows[0].id;
  const catRows = await pool.query("SELECT id, slug FROM categories WHERE active");
  const catBySlug = {};
  for (const r of catRows.rows) catBySlug[r.slug] = r.id;
  let inserted = 0, upgraded = 0;
  for (const w of EDITORIAL_NEW_21) {
    const exists = await pool.query("SELECT 1 FROM workflows WHERE slug = $1", [w.slug]);
    if (exists.rows[0]) continue;
    const r = await pool.query(
      `INSERT INTO workflows (creator_id, slug, title, summary, problem, result, prompt, proof_url, category_id, tags, status, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'published', now()) RETURNING id`,
      [editorialId, w.slug, w.title, w.summary || "", w.problem || "", w.result, w.prompt, w.proof_url || null, catBySlug[w.category] || null, w.tags || []]
    );
    const id = r.rows[0].id;
    for (let i = 0; i < (w.steps || []).length; i++) {
      await pool.query("INSERT INTO workflow_steps (workflow_id, position, body) VALUES ($1,$2,$3)", [id, i + 1, w.steps[i]]);
    }
    for (let i = 0; i < (w.prerequisites || []).length; i++) {
      await pool.query("INSERT INTO workflow_prerequisites (workflow_id, position, body) VALUES ($1,$2,$3)", [id, i + 1, w.prerequisites[i]]);
    }
    inserted++;
  }
  for (const w of EDITORIAL_UPGRADES_21) {
    const r = await pool.query(
      `UPDATE workflows SET title=$2, summary=$3, problem=$4, result=$5, prompt=$6, proof_url=$7, category_id=$8, tags=$9, updated_at=now()
       WHERE slug=$1 AND proof_url=$10 RETURNING id`,
      [w.slug, w.title, w.summary || "", w.problem || "", w.result, w.prompt, w.proof_url || null, catBySlug[w.category] || null, w.tags || [], EDITORIAL_STUB_PROOF]
    );
    if (!r.rows[0]) continue;
    const id = r.rows[0].id;
    await pool.query("DELETE FROM workflow_steps WHERE workflow_id=$1", [id]);
    await pool.query("DELETE FROM workflow_prerequisites WHERE workflow_id=$1", [id]);
    for (let i = 0; i < (w.steps || []).length; i++) {
      await pool.query("INSERT INTO workflow_steps (workflow_id, position, body) VALUES ($1,$2,$3)", [id, i + 1, w.steps[i]]);
    }
    for (let i = 0; i < (w.prerequisites || []).length; i++) {
      await pool.query("INSERT INTO workflow_prerequisites (workflow_id, position, body) VALUES ($1,$2,$3)", [id, i + 1, w.prerequisites[i]]);
    }
    upgraded++;
  }
  if (inserted || upgraded) console.log(`editorial seed 21: inserted ${inserted}, upgraded ${upgraded}`);
}

// The promise from the last init() call. handle() awaits it so the referral
// migrations (foreign keys into creator_profiles) are done before any
// request touches the database.
let schemaReady = null;
function init(shared) {
  deps = shared;
  pool = shared.pool;
  schemaReady = ensureCreatorSchema();
  schemaReady.then(() => warmCommunityRegistry()).catch(() => {});
}

// ---------------------------------------------------------------------------
// Sessions. A creator session is a signed cookie carrying the profile id;
// the profile row is loaded on every request so a deactivation takes effect
// at once. The signup cookie carries a verified email for the minutes between
// Google sign in and choosing a handle.
function key(label) {
  return crypto.createHash("sha256").update(label + ":" + deps.DEVICE_SECRET).digest();
}
function signBody(label, data, seconds) {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url");
  const sig = crypto.createHmac("sha256", key(label)).update(body).digest("base64url");
  return body + "." + sig;
}
function readSigned(label, raw) {
  const [body, sig] = String(raw || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", key(label)).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch (_) {
    return null;
  }
}
function cookie(req, name, value, maxAge) {
  const secure = deps.isSecure(req) ? "; Secure" : "";
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}
function clearCookie(req, name) {
  return cookie(req, name, "", 0);
}
async function creatorFromRequest(req) {
  const data = readSigned("creator", deps.parseCookies(req)[CREATOR_COOKIE]);
  if (!data || !data.cid) return null;
  const r = await pool.query("SELECT * FROM creator_profiles WHERE id = $1", [data.cid]);
  const profile = r.rows[0];
  if (!profile) return null;
  return profile;
}
// Any signed in request links the device to the creator, which is what
// blocks that device from rating the creator's own work later.
async function rememberDevice(creatorId, deviceId) {
  if (!creatorId || !deviceId) return;
  await pool.query(
    `INSERT INTO creator_devices (creator_id, device_id) VALUES ($1, $2)
     ON CONFLICT (creator_id, device_id) DO UPDATE SET last_seen_at = now()`,
    [creatorId, deviceId]
  );
}
async function event(kind, fields) {
  await pool.query(
    "INSERT INTO pool_events (kind, workflow_id, creator_id, device_id, actor, detail) VALUES ($1, $2, $3, $4, $5, $6)",
    [kind, fields.workflowId || null, fields.creatorId || null, fields.deviceId || null, fields.actor || null, fields.detail ? JSON.stringify(fields.detail) : null]
  );
}
async function overLimit(table, column, value, limit) {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour, count(*) AS day
       FROM ${table} WHERE ${column} = $1 AND created_at > now() - interval '1 day'`,
    [value]
  );
  return Number(r.rows[0].hour) >= limit.hour || Number(r.rows[0].day) >= limit.day;
}

// ---------------------------------------------------------------------------
// Community X posts ("Add your post" on /posts). A creator submits the link
// to their own X post; we fetch the public post once from X's syndication
// endpoint (the same one scripts/enrich-posts.js uses), store it as pending,
// and a moderator approves or rejects it. Only approved rows render.

// Accepts x.com and twitter.com links; requires a /status/<id> path so a
// profile link can never pass as a post.
function parseXStatusUrl(raw) {
  if (typeof raw !== "string") return null;
  let u;
  try { u = new URL(raw.trim()); } catch (_) { return null; }
  const host = u.hostname.toLowerCase();
  if (host !== "x.com" && host !== "twitter.com" && !host.endsWith(".x.com") && !host.endsWith(".twitter.com")) return null;
  const m = u.pathname.match(/^\/[^/]+\/status\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchPublicTweet(statusId) {
  const resp = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(statusId)}&token=0`, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; BuiltWithMuse/1.0)" },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error("http " + resp.status);
  const d = await resp.json();
  if (!d || !d.id_str) throw new Error("no tweet");
  const photos = (d.photos || []).map((x) => x.url).filter(Boolean).slice(0, 4);
  // Video, the same way scripts/enrich-posts.js reads it: best mp4 variant.
  let videoUrl = null, videoPoster = null;
  const vd = (d.mediaDetails || []).find((m) => m.type === "video" || m.type === "animated_gif");
  if (vd) {
    videoPoster = vd.media_url_https || null;
    const variants = (vd.video_info && vd.video_info.variants) || [];
    const best = variants.filter((v) => v.content_type === "video/mp4").sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    videoUrl = (best && best.url) || null;
  }
  let postedAt = null;
  if (d.created_at) { const t = new Date(d.created_at); if (!Number.isNaN(t.getTime())) postedAt = t.toISOString(); }
  return {
    id: d.id_str,
    name: (d.user && d.user.name) || null,
    handle: d.user && d.user.screen_name ? "@" + d.user.screen_name : null,
    avatar: d.user && d.user.profile_image_url_https ? d.user.profile_image_url_https.replace("_normal", "_200x200") : null,
    verified: Boolean(d.user && (d.user.is_blue_verified || d.user.verified)),
    text: (d.text || "").trim(),
    postedAt,
    photos,
    videoUrl, videoPoster,
    likes: Number(d.favorite_count) || 0,
    replies: Number(d.conversation_count) || 0,
  };
}

// Status ids already in the curated seed, so a submit can never duplicate them.
let seedStatusIds = null;
function getSeedStatusIds() {
  if (!seedStatusIds) seedStatusIds = new Set(wild.load().all.map((i) => i.status_id).filter(Boolean));
  return seedStatusIds;
}

// Approved community posts, cached for a minute. A query failure (for
// example the table not existing yet on first boot) yields no rows.
const communityCache = { at: 0, rows: [] };
async function approvedCommunityPosts() {
  if (Date.now() - communityCache.at < 60000) return communityCache.rows;
  try {
    const r = await pool.query(
      `SELECT w.id, w.tweet_url, w.author_name, w.author_handle, w.author_avatar, w.verified, w.text,
              w.posted_at, w.photos, w.video_url, w.video_poster, w.likes, w.reposts, w.replies,
              c.handle AS submitter_handle, c.display_name AS submitter_name, c.status AS submitter_status
       FROM wild_community_posts w LEFT JOIN creator_profiles c ON c.id = w.creator_id
       WHERE w.status = 'approved' ORDER BY w.created_at DESC LIMIT 60`
    );
    communityCache.rows = r.rows;
    communityCache.at = Date.now();
  } catch (_) { /* keep the previous rows */ }
  return communityCache.rows;
}
function invalidateCommunityCache() { communityCache.at = 0; warmCommunityRegistry(); }

// A DB row shaped like a wild seed item so cardHtml and publicItem work unchanged.
function communityToWildItem(row) {
  const item = {
    id: "community-" + row.id,
    title: row.text ? row.text.slice(0, 90) : "A post on X",
    category: "community",
    url: row.tweet_url,
    platform: "x",
    status_id: row.id,
    text_source: "tweet",
    tweet_text: row.text,
    summary: row.text,
    name: row.author_name,
    handle: row.author_handle,
    posted_at: row.posted_at,
    likes: row.likes || 0,
    reposts: row.reposts || 0,
    replies: row.replies || 0,
    views: 0,
    prompt: null,
    submitterHandle: row.submitter_handle || null,
    submitterName: row.submitter_name || null,
    submitterActive: row.submitter_status === "active",
  };
  item.communityMedia = {
    name: row.author_name, handle: row.author_handle, avatar: row.author_avatar,
    verified: Boolean(row.verified), photos: row.photos || [],
    video: row.video_url ? { url: row.video_url, poster: row.video_poster } : null,
  };
  return item;
}

// Push the approved rows into wild's synchronous registry so pick()
// interleaves them everywhere the unfiltered pool is used. Runs at boot
// and whenever moderation changes the set.
async function warmCommunityRegistry() {
  try { wild.setCommunityItems((await approvedCommunityPosts()).map(communityToWildItem)); } catch (_) { /* seed only until the next warm */ }
}

// ---------------------------------------------------------------------------
// Validation. Every string is trimmed and length checked; nothing is trusted
// from the client beyond its content.
const DASH_RE = /[‐-―−]/g;
function text(value, [min, max], name, errors, { required = min > 0 } = {}) {
  let s = typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(DASH_RE, "-").trim() : "";
  if (!s && !required) return null;
  if (s.length < Math.max(1, min)) errors.push(`${name}_short`);
  if (s.length > max) errors.push(`${name}_long`);
  return s;
}
function list(value, count, each, name, errors) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) { errors.push(`${name}_invalid`); return []; }
  const items = value.map((v) => (typeof v === "string" ? v.replace(DASH_RE, "-").trim() : "")).filter(Boolean);
  if (items.length < count[0]) errors.push(`${name}_few`);
  if (items.length > count[1]) errors.push(`${name}_many`);
  for (const item of items) if (item.length > each[1]) errors.push(`${name}_item_long`);
  return items.slice(0, count[1]);
}
function validUrl(value, name, errors) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  if (s.length > 500 || !/^https?:\/\/[^\s]+$/i.test(s)) { errors.push(`${name}_invalid`); return null; }
  return s;
}
function validImage(value, name, errors) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  // Uploaded pictures arrive as client side resized JPEG data URLs (max ~600KB).
  if (/^data:image\/(png|jpeg|webp);base64,/.test(s)) {
    if (s.length > 800000) { errors.push(name + "_invalid"); return null; }
    return s;
  }
  return validUrl(s, name, errors);
}
function validAvatar(value, errors) { return validImage(value, "avatar", errors); }
// A Muse share link: https://muse.ai/s/<slug>. Anything else is rejected so
// the "Open in Muse" button never points somewhere unexpected.
function validMuseUrl(value, errors) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const m = raw.match(/https?:\/\/[^\s<>"']+/i);
  const candidate = (m ? m[0] : raw).replace(/[.,;:!?)\]]+$/, "");
  try {
    const u = new URL(candidate);
    if (!/^(www\.)?muse\.ai$/i.test(u.hostname) || u.protocol !== "https:" || candidate.length > 300) { errors.push("muse_url_invalid"); return null; }
    return u.origin + u.pathname;
  } catch (_) {
    errors.push("muse_url_invalid");
    return null;
  }
}
function slugify(title) {
  return title.toLowerCase().replace(DASH_RE, "-").replace(/['"’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workflow";
}
// Tags arrive as a comma separated string or an array. At most five survive,
// lowercased, each 2 to 24 chars of letters, numbers and single hyphens.
const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function parseTags(value, errors) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = [];
  for (const item of raw) {
    const tag = String(item).trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (!tag) continue;
    if (seen.includes(tag)) continue;
    if (tag.length < 2 || tag.length > 24 || !TAG_RE.test(tag)) { if (!errors.includes("tag_invalid")) errors.push("tag_invalid"); continue; }
    seen.push(tag);
    if (seen.length >= 5) break;
  }
  return seen;
}
async function uniqueSlug(base, excludeId) {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const r = await pool.query("SELECT id FROM workflows WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2)", [candidate, excludeId || null]);
    if (!r.rows[0]) return candidate;
  }
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

// Parses a workflow body from the client. Drafts only need a title; publishing
// needs the three quick answers: title, what you told Muse, what happened.
// Everything else (summary, problem, steps, category) is optional detail that
// can be added later and helps the workflow rank.
function parseWorkflow(body, { complete }) {
  const errors = [];
  const out = {};
  out.kind = body && body.kind === "artifact" ? "artifact" : "workflow";
  out.title = text(body.title, LIMITS.title, "title", errors);
  out.summary = text(body.summary, LIMITS.summary, "summary", errors, { required: false });
  out.problem = text(body.problem, LIMITS.problem, "problem", errors, { required: false });
  out.result = text(body.result, LIMITS.result, "result", errors, { required: complete });
  out.prompt = text(body.prompt, LIMITS.prompt, "prompt", errors, { required: complete });
  out.proof_url = validUrl(body.proof_url, "proof_url", errors);
  out.steps = list(body.steps, [0, LIMITS.steps[1]], LIMITS.step, "steps", errors);
  if (out.kind !== "artifact" && out.steps.length === 1) errors.push("steps_few");
  out.prerequisites = list(body.prerequisites, LIMITS.prerequisites, LIMITS.prerequisite, "prerequisites", errors);
  out.category = typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
  out.tags = parseTags(body.tags, errors);
  out.screenshot_url = validImage(body.screenshot_url, "screenshot", errors);
  out.muse_url = validMuseUrl(body.muse_url, errors);
  if (out.kind === "artifact") {
    // An artifact can run longer than a workflow result: the thing itself
    // is pasted here. Twenty thousand characters is the ceiling.
    if (out.result && out.result.length <= 20000) {
      const li = errors.indexOf("result_long"); if (li >= 0) errors.splice(li, 1);
    }
    if (complete) {
      if (!out.problem && !errors.includes("problem_short")) errors.push("problem_short");
      // The artifact itself: an image or the pasted text. One of the two.
      if (!out.screenshot_url && !out.result) errors.push("artifact_empty");
      // Text is optional when an image carries the artifact.
      if (out.screenshot_url) { const ri = errors.indexOf("result_short"); if (ri >= 0) errors.splice(ri, 1); }
    }
  }
  return { value: out, errors };
}

async function categoryId(slug) {
  if (!slug) return null;
  const r = await pool.query("SELECT id FROM categories WHERE slug = $1 AND active", [slug]);
  return r.rows[0] ? r.rows[0].id : null;
}

// ---------------------------------------------------------------------------
// Reads.
const WORKFLOW_SELECT = `
  w.id, w.slug, w.kind, w.title, w.summary, w.problem, w.result, w.prompt, w.proof_url, w.screenshot_url, w.muse_url, w.status, w.hidden_at,
  w.published_at, w.created_at, w.updated_at, w.tags,
  (SELECT count(*) FROM workflow_reactions rx WHERE rx.workflow_id = w.id)::int AS reaction_count,
  (SELECT count(*) FROM workflow_saves sv WHERE sv.workflow_id = w.id)::int AS save_count,
  (SELECT count(*) FROM workflow_comments cm WHERE cm.workflow_id = w.id AND cm.hidden_at IS NULL)::int AS comment_count,
  cat.slug AS category, cat.name AS category_name,
  c.id AS creator_id, c.handle, c.display_name, c.avatar_url, c.is_editorial, c.status AS creator_status,
  s.rating_count, s.average, s.weighted_score`;
const WORKFLOW_FROM = `
  FROM workflows w
  JOIN creator_profiles c ON c.id = w.creator_id
  LEFT JOIN categories cat ON cat.id = w.category_id
  LEFT JOIN workflow_stats s ON s.workflow_id = w.id`;
const DISCOVERABLE = `w.status = 'published' AND w.hidden_at IS NULL AND c.status = 'active'`;

function publicWorkflow(row) {
  // Quick submissions can skip the summary; fall back to the result excerpt
  // so cards, hero leads and meta descriptions never render empty.
  const fallbackSummary = row.summary || String(row.result || row.problem || "").replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    id: row.id, slug: row.slug, kind: row.kind || "workflow", title: row.title, summary: fallbackSummary, category: row.category, categoryName: row.category_name,
    status: row.status, publishedAt: row.published_at, updatedAt: row.updated_at,
    creator: { handle: row.handle, displayName: row.display_name, avatarUrl: row.avatar_url, editorial: row.is_editorial, status: row.creator_status },
    ratingCount: Number(row.rating_count || 0), average: row.average === null ? null : Number(row.average), weightedScore: Number(row.weighted_score || 0), proofUrl: row.proof_url, tags: row.tags || [],
    museUrl: row.muse_url || null, reactionCount: Number(row.reaction_count || 0), saveCount: Number(row.save_count || 0), commentCount: Number(row.comment_count || 0),
    readMinutes: readMinutes(row),
    latestComment: row.latest_comment ? { body: row.latest_comment.body, author: row.latest_comment.display_name, avatarUrl: row.latest_comment.avatar_url } : null,
  };
}
async function loadParts(workflowId) {
  const steps = await pool.query("SELECT position, title, body FROM workflow_steps WHERE workflow_id = $1 ORDER BY position", [workflowId]);
  const prereqs = await pool.query("SELECT body FROM workflow_prerequisites WHERE workflow_id = $1 ORDER BY position", [workflowId]);
  return { steps: steps.rows.map((s) => (s.title ? { title: s.title, body: s.body } : s.body)), prerequisites: prereqs.rows.map((p) => p.body) };
}
// Engagement per hour of age, damped so a day old workflow with a few
// reactions can sit next to a week old one with many. Subqueries repeat
// here because Postgres cannot use output aliases inside ORDER BY math.
const TRENDING_EXPR = `(
    (SELECT count(*) FROM workflow_reactions rx WHERE rx.workflow_id = w.id) * 1.0
    + (SELECT count(*) FROM workflow_saves sv WHERE sv.workflow_id = w.id) * 2.0
    + (SELECT count(*) FROM workflow_comments cm WHERE cm.workflow_id = w.id AND cm.hidden_at IS NULL) * 2.0
    + coalesce(s.rating_count, 0) * 2.0 + 1
  ) / power(extract(epoch FROM (now() - coalesce(w.published_at, w.created_at))) / 3600.0 + 6, 0.7)`;
function sortClause(sort) {
  if (sort === "trending") return `${TRENDING_EXPR} DESC, w.published_at DESC`;
  if (sort === "most") return "s.rating_count DESC NULLS LAST, s.weighted_score DESC, w.published_at DESC";
  if (sort === "new") return "w.published_at DESC, w.id";
  return "s.weighted_score DESC, s.rating_count DESC NULLS LAST, w.published_at DESC";
}
async function listWorkflows({ sort = "top", category = "", q = "", page = 1, handle = "", tag = "", followerId = null, limit = PAGE_SIZE, kind = "" }) {
  const where = [DISCOVERABLE];
  const params = [];
  if (followerId) { params.push(followerId); where.push(`w.creator_id IN (SELECT followed_id FROM creator_follows WHERE follower_id = $${params.length})`); }
  if (category) { params.push(category); where.push(`cat.slug = $${params.length}`); }
  if (handle) { params.push(handle.toLowerCase()); where.push(`lower(c.handle) = $${params.length}`); }
  if (kind) { params.push(kind); where.push(`w.kind = $${params.length}`); }
  if (tag) { params.push(tag.toLowerCase()); where.push(`$${params.length} = ANY (w.tags)`); }
  if (q) { params.push("%" + q.replace(/[%_]/g, "") + "%"); where.push(`(w.title ILIKE $${params.length} OR w.summary ILIKE $${params.length} OR w.problem ILIKE $${params.length} OR c.display_name ILIKE $${params.length} OR c.handle ILIKE $${params.length})`); }
  const size = Math.max(1, Math.min(48, Number(limit) || PAGE_SIZE));
  const offset = (page - 1) * size;
  params.push(size + 1, offset);
  const r = await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE ${where.join(" AND ")} ORDER BY ${sortClause(sort)} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const total = (await pool.query(`SELECT count(*) AS n ${WORKFLOW_FROM} WHERE ${where.join(" AND ")}`, params.slice(0, -2))).rows[0].n;
  const rows = await enrichRows(r.rows.slice(0, size));
  return { rows, hasMore: r.rows.length > size, total: Number(total) };
}
// The newest visible comment on each workflow in a page of rows, so a list
// row can show one line of what someone said. One query for the page.
async function enrichRows(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const cm = await pool.query(
    `SELECT DISTINCT ON (wc.workflow_id) wc.workflow_id, wc.body, c.display_name, c.avatar_url
       FROM workflow_comments wc JOIN creator_profiles c ON c.id = wc.creator_id
      WHERE wc.workflow_id = ANY($1) AND wc.hidden_at IS NULL ORDER BY wc.workflow_id, wc.created_at DESC`, [ids]);
  const byId = new Map(cm.rows.map((x) => [x.workflow_id, x]));
  return rows.map((r) => ({ ...r, latest_comment: byId.get(r.id) || null }));
}
function readMinutes(row) {
  const words = [row.summary, row.problem, row.result, row.prompt].join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 160));
}
async function newWorkflows() {
  const r = await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE ${DISCOVERABLE} AND w.published_at > now() - interval '14 days' AND coalesce(s.rating_count, 0) < 3 ORDER BY w.published_at DESC LIMIT 4`);
  return r.rows;
}
async function workflowBySlug(slug) {
  const r = await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE w.slug = $1`, [slug]);
  return r.rows[0] || null;
}
async function workflowById(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE w.id = $1`, [id]);
  return r.rows[0] || null;
}
async function creatorByHandle(handle) {
  const r = await pool.query(
    `SELECT c.*, s.workflow_count, s.rating_count, s.average, s.weighted_score
       FROM creator_profiles c LEFT JOIN creator_stats s ON s.creator_id = c.id WHERE lower(c.handle) = lower($1)`,
    [handle]
  );
  return r.rows[0] || null;
}
function publicCreator(row) {
  return {
    handle: row.handle, displayName: row.display_name, bio: row.bio, avatarUrl: row.avatar_url, websiteUrl: row.website_url, xUrl: row.x_url, youtubeUrl: row.youtube_url, instagramUrl: row.instagram_url, tiktokUrl: row.tiktok_url, linkedinUrl: row.linkedin_url, threadsUrl: row.threads_url, links: Array.isArray(row.links) ? row.links.filter((l) => l && l.label && l.url).slice(0, 3) : [],
    editorial: row.is_editorial, status: row.status, joinedAt: row.created_at,
    workflowCount: Number(row.workflow_count || 0), ratingCount: Number(row.rating_count || 0), weightedScore: Number(row.weighted_score || 0),
  };
}
// A member number is a join order rank: how many members signed up before
// this one, plus one. Removed accounts do not hold numbers, so the count
// only ever moves when someone ahead leaves for good.
async function memberNumber(row) {
  if (!row || !row.created_at || !row.id) return null;
  const r = await pool.query("SELECT count(*)::int AS n FROM creator_profiles WHERE status <> 'removed' AND (created_at < $1 OR (created_at = $1 AND id <= $2))", [row.created_at, row.id]);
  return r.rows[0] ? r.rows[0].n : null;
}
async function stats(workflowId) {
  const r = await pool.query("SELECT rating_count, average, weighted_score FROM workflow_stats WHERE workflow_id = $1", [workflowId]);
  const row = r.rows[0] || {};
  return { ratingCount: Number(row.rating_count || 0), average: row.average === null || row.average === undefined ? null : Number(row.average), weightedScore: Number(row.weighted_score || 0) };
}
// Visible comments for a workflow, oldest first, with like counts. viewerId
// marks which ones the signed in creator already liked (null for guests).
async function listComments(workflowId, viewerId) {
  const r = await pool.query(
    `SELECT wc.id, wc.body, wc.created_at, wc.creator_id, c.handle, c.display_name, c.avatar_url,
            (SELECT count(*) FROM comment_likes cl WHERE cl.comment_id = wc.id) AS likes,
            ${viewerId ? "(SELECT count(*) FROM comment_likes cl WHERE cl.comment_id = wc.id AND cl.creator_id = $2)" : "0"} AS liked
     FROM workflow_comments wc JOIN creator_profiles c ON c.id = wc.creator_id
     WHERE wc.workflow_id = $1 AND wc.hidden_at IS NULL ORDER BY wc.created_at ASC LIMIT 100`,
    viewerId ? [workflowId, viewerId] : [workflowId]
  );
  return r.rows.map((x) => ({
    id: x.id, body: x.body, createdAt: x.created_at,
    creator: { id: x.creator_id, handle: x.handle, displayName: x.display_name, avatarUrl: x.avatar_url },
    likes: Number(x.likes), liked: Number(x.liked) > 0,
  }));
}
async function isOwnerDevice(creatorId, deviceId) {
  const r = await pool.query("SELECT 1 FROM creator_devices WHERE creator_id = $1 AND device_id = $2", [creatorId, deviceId]);
  return Boolean(r.rows[0]);
}
async function setting(keyName, fallback) {
  const r = await pool.query("SELECT value FROM pool_settings WHERE key = $1", [keyName]);
  return r.rows[0] ? r.rows[0].value : fallback;
}

// ---------------------------------------------------------------------------
// Writes.
async function writeParts(client, workflowId, value) {
  await client.query("DELETE FROM workflow_steps WHERE workflow_id = $1", [workflowId]);
  await client.query("DELETE FROM workflow_prerequisites WHERE workflow_id = $1", [workflowId]);
  for (let i = 0; i < value.steps.length; i++) {
    await client.query("INSERT INTO workflow_steps (workflow_id, position, body) VALUES ($1, $2, $3)", [workflowId, i + 1, value.steps[i]]);
  }
  for (let i = 0; i < value.prerequisites.length; i++) {
    await client.query("INSERT INTO workflow_prerequisites (workflow_id, position, body) VALUES ($1, $2, $3)", [workflowId, i + 1, value.prerequisites[i]]);
  }
}
async function createWorkflow(creator, value, { status = "draft" } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const slug = value.kind === "artifact" ? await uniqueSlug("a-" + crypto.randomBytes(6).toString("hex")) : await uniqueSlug(slugify(value.title));
    const cat = await categoryId(value.category);
    const r = await client.query(
      `INSERT INTO workflows (creator_id, slug, kind, title, summary, problem, result, prompt, proof_url, screenshot_url, muse_url, category_id, tags, status, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CASE WHEN $14 = 'published' THEN now() ELSE NULL END) RETURNING id, slug`,
      [creator.id, slug, value.kind || "workflow", value.title, value.summary || "", value.problem || "", value.result || "", value.prompt, value.proof_url, value.screenshot_url, value.muse_url || null, cat, value.tags || [], status]
    );
    await writeParts(client, r.rows[0].id, value);
    await client.query("COMMIT");
    return r.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
async function updateWorkflow(existing, value, editorId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (existing.status === "published" || existing.status === "unpublished") {
      const parts = await loadParts(existing.id);
      await client.query("INSERT INTO workflow_revisions (workflow_id, editor_id, snapshot) VALUES ($1, $2, $3)", [
        existing.id, editorId, JSON.stringify({ title: existing.title, summary: existing.summary, problem: existing.problem, result: existing.result, prompt: existing.prompt, proof_url: existing.proof_url, screenshot_url: existing.screenshot_url, category: existing.category, tags: existing.tags || [], ...parts }),
      ]);
    }
    // The slug follows the title while the work is a draft and freezes once published.
    const slug = existing.kind === "artifact" ? existing.slug : existing.status === "draft" ? await uniqueSlug(slugify(value.title), existing.id) : existing.slug;
    const cat = await categoryId(value.category);
    await client.query(
      `UPDATE workflows SET title = $2, summary = $3, problem = $4, result = $5, prompt = $6, proof_url = $7, screenshot_url = $8, category_id = $9, slug = $10, tags = $11, muse_url = $12, updated_at = now() WHERE id = $1`,
      [existing.id, value.title, value.summary || "", value.problem || "", value.result || "", value.prompt, value.proof_url, value.screenshot_url, cat, slug, value.tags || [], value.muse_url || null]
    );
    await writeParts(client, existing.id, value);
    await client.query("COMMIT");
    return slug;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
async function fullWorkflowValue(row) {
  const parts = await loadParts(row.id);
  return {
    kind: row.kind || "workflow", title: row.title, summary: row.summary, problem: row.problem, result: row.result, prompt: row.prompt, proof_url: row.proof_url, screenshot_url: row.screenshot_url, muse_url: row.muse_url, category: row.category, tags: row.tags || [],
    steps: parts.steps.map((s) => (typeof s === "string" ? s : s.body)), prerequisites: parts.prerequisites,
  };
}
async function publishAllowed(creator) {
  const age = await pool.query("SELECT created_at < now() - interval '1 day' AS old FROM creator_profiles WHERE id = $1", [creator.id]);
  const cap = age.rows[0] && age.rows[0].old ? PUBLISH_CAP.perDay : PUBLISH_CAP.firstDay;
  const n = await pool.query("SELECT count(*) AS n FROM workflows WHERE creator_id = $1 AND published_at > now() - interval '1 day'", [creator.id]);
  return Number(n.rows[0].n) < cap;
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by pages and JSON.
function ratingLabel(w) {
  const n = w.ratingCount || 0;
  if (n === 0) return { text: "New", stars: "", count: "" };
  if (n < 3) return { text: "New", stars: "", count: `${n} rating${n === 1 ? "" : "s"}` };
  return { text: w.average.toFixed(1), stars: "★".repeat(Math.round(w.average)) + "☆".repeat(5 - Math.round(w.average)), count: `${n} ratings` };
}
function ratingHtml(w) {
  const r = ratingLabel(w);
  if (r.text === "New") return `<span class="rating"><span class="new">New</span>${r.count ? ` <span>${esc(r.count)}</span>` : ""}</span>`;
  return `<span class="rating"><span class="stars" aria-hidden="true">${r.stars}</span> ${esc(r.text)} <span style="color:var(--muted-2);font-weight:600">${esc(r.count)}</span></span>`;
}
function dateLabel(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function countsHtml(w) {
  const bits = [];
  if (w.reactionCount) bits.push(`<span title="Reactions">&#128293; ${w.reactionCount}</span>`);
  if (w.saveCount) bits.push(`<span title="Saves">&#128278; ${w.saveCount}</span>`);
  if (w.commentCount) bits.push(`<span title="Comments">&#128172; ${w.commentCount}</span>`);
  return bits.length ? `<span class="counts">${bits.join("")}</span>` : "";
}
function cardHtml(row) {
  const w = publicWorkflow(row);
  const c = w.creator;
  return `<a class="card" href="/workflows/${esc(w.slug)}">
  <span class="card-head">${avatarHtml({ displayName: c.displayName, avatarUrl: c.avatarUrl }, "28px")}<span class="who"><b>${esc(c.displayName)}</b><span>@${esc(c.handle)}${c.editorial ? " · editorial" : ""}</span></span><span class="tag">${esc(w.categoryName || "Workflow")}</span></span>
  <h3>${esc(w.title)}</h3>
  ${w.summary && w.summary !== "No description" ? `<p>${esc(w.summary)}</p>` : ""}
  ${w.tags.length ? `<span class="tags">${w.tags.slice(0, 3).map((t) => `#${esc(t)}`).join(" ")}</span>` : ""}
  <span class="foot">${countsHtml(w) || '<span class="counts"><span>Useful · 0</span></span>'}<span class="when">${esc(dateLabel(w.updatedAt))}</span></span>
</a>`;
}
// An artifact row: the same editorial row with the picture up front and an
// Artifact badge, so a list of artifacts reads as a gallery of results.
function artifactRowHtml(row, savedSet) {
  const w = publicWorkflow(row);
  const c = w.creator;
  const saved = Boolean(savedSet && savedSet.has(w.id));
  return `<article class="row">
  <a class="row-who" href="/creators/${esc(c.handle)}">${avatarHtml({ displayName: c.displayName, avatarUrl: c.avatarUrl }, "28px")}<span>${esc(c.displayName)}</span><span class="badge soft">Artifact</span></a>
  <h2><a href="/workflows/${esc(w.slug)}">${esc(w.title)}</a></h2>
  ${row.screenshot_url ? `<a href="/workflows/${esc(w.slug)}"><img class="row-shot" src="${esc(row.screenshot_url)}" alt="Artifact shared by ${esc(c.displayName)}" loading="lazy" /></a>` : ""}
  ${w.summary ? `<p class="dek">${esc(w.summary)}</p>` : ""}
  <div class="row-meta">${w.reactionCount ? `<span>Useful · ${w.reactionCount}</span>` : ""}<span>${w.commentCount} comment${w.commentCount === 1 ? "" : "s"}</span><span>${esc(dateLabel(w.updatedAt))}</span><button class="quiet-link share-btn" type="button" data-share-url="${esc(SITE + "/workflows/" + w.slug + "?s=1")}" data-share-title="${esc(w.title)}">Share</button><button class="quiet-link save-btn${saved ? " on" : ""}" type="button" data-workflow="${esc(w.id)}" aria-pressed="${saved}" aria-label="${saved ? "Saved. Click to unsave." : "Save this artifact"}">${saved ? "Saved" : "Save"}</button></div>
</article>`;
}
// A feed row in the editorial layout: creator line, title, dek, meta and
// the latest comment when there is one.
// The workflow ids this visitor already saved, in one query. Signed in
// saves are keyed by creator, signed out saves by device.
async function savedWorkflowIds(viewer, deviceId) {
  const conds = [], params = [];
  if (viewer) { params.push(viewer.id); conds.push(`creator_id = $${params.length}`); }
  if (deviceId) { params.push(deviceId); conds.push(`(device_id = $${params.length} AND creator_id IS NULL)`); }
  if (!conds.length) return new Set();
  const r = await pool.query(`SELECT workflow_id FROM workflow_saves WHERE ${conds.join(" OR ")}`, params);
  return new Set(r.rows.map((x) => x.workflow_id));
}
function rowHtml(row, savedSet) {
  const w = publicWorkflow(row);
  const c = w.creator;
  const saved = Boolean(savedSet && savedSet.has(w.id));
  return `<article class="row">
  <a class="row-who" href="/creators/${esc(c.handle)}">${avatarHtml({ displayName: c.displayName, avatarUrl: c.avatarUrl }, "28px")}<span>${esc(c.displayName)}</span>${c.editorial ? '<span class="badge editorial">Editorial</span>' : ""}</a>
  <h2><a href="/workflows/${esc(w.slug)}">${esc(w.title)}</a></h2>
  ${w.summary && w.summary !== "No description" ? `<p class="dek">${esc(w.summary)}</p>` : ""}
  <div class="row-meta"><span>${w.readMinutes} min read</span><span>Useful · ${w.reactionCount}</span><span>${w.commentCount} comment${w.commentCount === 1 ? "" : "s"}</span>${w.categoryName ? `<a class="cat" href="/workflows?category=${esc(w.category)}">${esc(w.categoryName)}</a>` : ""}<button class="quiet-link share-btn" type="button" data-share-url="${esc(SITE + "/workflows/" + w.slug + "?s=1")}" data-share-title="${esc(w.title)}">Share</button><button class="quiet-link save-btn${saved ? " on" : ""}" type="button" data-workflow="${esc(w.id)}" aria-pressed="${saved}" aria-label="${saved ? "Saved. Click to unsave." : "Save this workflow"}">${saved ? "Saved" : "Save"}</button></div>
  ${w.latestComment ? `<a class="row-quote" href="/workflows/${esc(w.slug)}#comments">${avatarHtml({ displayName: w.latestComment.author, avatarUrl: w.latestComment.avatarUrl }, "24px")}<span>${esc(w.latestComment.body.slice(0, 140))}</span></a>` : ""}
</article>`;
}
function initials(name) {
  return String(name || "?").split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}
function commentHtml(cm, viewer = {}) {
  const canDelete = Boolean(viewer.owner || (viewer.id && viewer.id === cm.creator.id));
  return `<div class="comment" data-comment="${esc(cm.id)}">
    <div class="comment-head">${avatarHtml({ displayName: cm.creator.displayName, avatarUrl: cm.creator.avatarUrl }, "36px")}<div><b>${esc(cm.creator.displayName)}</b><span>@${esc(cm.creator.handle)}</span></div></div>
    <p>${esc(cm.body)}</p>
    <div class="comment-foot">
      <button class="quiet-link like-btn${cm.liked ? " on" : ""}" type="button" data-comment="${esc(cm.id)}" aria-pressed="${cm.liked}">Like${cm.likes ? ` (${cm.likes})` : ""}</button>
      <button class="quiet-link report-comment" type="button" data-comment="${esc(cm.id)}">Report</button>${canDelete ? `<button class="quiet-link delete-comment" type="button" data-comment="${esc(cm.id)}">Delete</button>` : ""}
    </div>
  </div>`;
}
function avatarHtml(creator, size = "") {
  const img = creator.avatarUrl || creator.avatar_url;
  return `<div class="avatar"${size ? ` style="width:${size};height:${size}"` : ""}>${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" />` : esc(initials(creator.displayName || creator.display_name))}</div>`;
}
function creatorScoreLabel(c) {
  if (!c.ratingCount) return "New";
  return c.weightedScore.toFixed(1);
}

const SESSION_JS = `fetch("/api/session", { method: "POST", credentials: "same-origin" }).catch(() => {});`;
// Fills the header account slot on server rendered pages: avatar plus quick
// links when signed in, a sign in link otherwise. Mirrors the SPA account chip.
const ACCOUNT_JS = `
      (() => {
        const slot = document.getElementById("account-slot");
        if (!slot) return;
        const esc = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
        const initials = (n) => String(n || "?").split(/\\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
        fetch("/api/v1/me", { credentials: "same-origin" }).then((r) => r.json().catch(() => null)).then((d) => {
          const me = d && d.ok ? d : null;
          if (me && me.creator) {
            const c = me.creator;
            slot.innerHTML = '<div class="acct"><button class="acct-btn" type="button" aria-haspopup="menu" aria-expanded="false">' +
              (c.avatarUrl ? '<img src="' + esc(c.avatarUrl) + '" alt="" referrerpolicy="no-referrer" />' : "<i>" + esc(initials(c.displayName)) + "</i>") +
              '<span class="who">' + esc(c.displayName) + '</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
              '<div class="acct-menu" role="menu" hidden><small>@' + esc(c.handle) + '</small><a role="menuitem" href="/creators/' + esc(c.handle) + '">View profile</a><a role="menuitem" href="/creator">Dashboard</a><a role="menuitem" href="/#mycodes">My codes</a><a role="menuitem" href="/#saved">Saved</a><div class="sep"></div><button role="menuitem" type="button" id="slot-signout">Sign out</button></div></div>';
            const btn = slot.querySelector(".acct-btn"), menu = slot.querySelector(".acct-menu");
            const set = (open) => { menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
            btn.addEventListener("click", (e) => { e.stopPropagation(); set(menu.hidden); });
            document.addEventListener("click", (e) => { if (!slot.contains(e.target)) set(false); });
            document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
            document.getElementById("slot-signout").addEventListener("click", async () => {
              try { await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "fetch" } }); } catch (_) {}
              location.reload();
            });
          } else {
            slot.innerHTML = '<a href="/creator">Sign in</a>';
          }
        }).catch(() => {});
      })();`;

// Strip the protocol and a trailing slash for display. Plain string ops on
// purpose: this runs inside template literals where backslash escapes in
// regexes silently break (the served page gets a different pattern).
function shortUrl(u) {
  let s = String(u || "");
  if (s.startsWith("https://")) s = s.slice(8);
  else if (s.startsWith("http://")) s = s.slice(7);
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

// ---------------------------------------------------------------------------
// Pages.
// Every fourth row in the feed is a real post from X or Threads, so the
// feed shows what people are getting Muse to do even while creators are few.
function interleaveWild(rows, { ours = "", page = 1, savedSet = null } = {}) {
  const posts = wild.pick({ ours, limit: 6, offset: ((page - 1) * 6) % 40 });
  const out = [];
  let n = 0;
  rows.forEach((r, i) => {
    out.push(rowHtml(r, savedSet));
    if ((i + 1) % 4 === 0 && posts[n]) { out.push(`<div class="row wild-row"><span class="wild-label">Posted on ${esc(posts[n].platform === "x" ? "X" : posts[n].platform === "threads" ? "Threads" : "Instagram")}</span>${wild.cardHtml(posts[n], { caption: false })}</div>`); n += 1; }
  });
  if (rows.length < 4 && posts[0]) out.push(`<div class="row wild-row"><span class="wild-label">Posted on ${esc(posts[0].platform === "x" ? "X" : posts[0].platform === "threads" ? "Threads" : "Instagram")}</span>${wild.cardHtml(posts[0], { caption: false })}</div>`);
  return out;
}
async function creatorsToFollow(limit = 6) {
  const r = await pool.query(
    `SELECT c.*, s.workflow_count, s.rating_count, s.average, s.weighted_score,
            (SELECT count(*) FROM creator_follows f WHERE f.followed_id = c.id)::int AS followers,
            (SELECT count(*) FROM workflow_reactions r JOIN workflows w ON w.id = r.workflow_id WHERE w.creator_id = c.id)::int AS useful,
            (SELECT count(*) FROM workflow_reactions r JOIN workflows w ON w.id = r.workflow_id WHERE w.creator_id = c.id AND r.created_at > now() - interval '7 days')::int AS useful_week
       FROM creator_profiles c LEFT JOIN creator_stats s ON s.creator_id = c.id
      WHERE c.status = 'active' AND NOT c.is_editorial AND coalesce(s.workflow_count, 0) > 0
      ORDER BY useful_week DESC, followers DESC, useful DESC, coalesce(s.weighted_score, 0) DESC, c.created_at DESC LIMIT $1`, [limit]);
  return r.rows.map((row) => ({ ...publicCreator(row), followers: Number(row.followers || 0), useful: Number(row.useful || 0), usefulWeek: Number(row.useful_week || 0) }));
}
async function pageIndex(url, req) {
  const viewer = req ? await creatorFromRequest(req).catch(() => null) : null;
  const wanted = url.searchParams.get("sort");
  const sort = ["trending", "top", "most", "new", "following"].includes(wanted) ? wanted : "trending";
  const category = (url.searchParams.get("category") || "").replace(/[^a-z-]/g, "").slice(0, 40);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const tag = (url.searchParams.get("tag") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  const page = Math.max(1, Math.min(200, Number(url.searchParams.get("page")) || 1));
  const cats = (await pool.query("SELECT slug, name FROM categories WHERE active ORDER BY position")).rows;
  const { rows, hasMore, total } = sort === "following" && !viewer
    ? { rows: [], hasMore: false, total: 0 }
    : await listWorkflows({ sort: sort === "following" ? "new" : sort, category, q, page, tag, followerId: sort === "following" ? viewer.id : null, kind: "workflow" });
  const savedSet = await savedWorkflowIds(viewer, deps.deviceFromCookie(req));
  const top = await creatorsToFollow(3);
  const link = (over) => {
    const p = new URLSearchParams();
    const merged = { sort, category, q, tag, page: 1, ...over };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "sort" && v === "trending") && !(k === "page" && v === 1)) p.set(k, String(v));
    const s = p.toString();
    return "/workflows" + (s ? "?" + s : "");
  };
  const catName = category ? (cats.find((c) => c.slug === category) || {}).name : "";
  const title = q ? `Muse workflows matching "${q}" | Built with Muse` : catName ? `${catName} workflows for Muse | Built with Muse` : "Workflows worth trying | Built with Muse";
  const description = catName
    ? `${catName} workflows for Meta's Muse: the exact prompt and what happened, from named creators, rated by the community.`
    : "Practical stories and exact prompts from people using Muse. React to what works, save what you want to try, follow the creators.";
  const chips = cats.map((c) => `<a class="chip" href="${esc(link({ category: category === c.slug ? "" : c.slug }))}"${category === c.slug ? ' aria-current="true"' : ""}>${esc(c.name)}</a>`).join("");
  const sorts = [["trending", "Trending"], ["new", "New"], ["top", "Top rated"], ["following", "Following"]].map(([k, label]) => `<a class="chip solid" href="${esc(link({ sort: k }))}"${sort === k ? ' aria-current="true"' : ""}>${label}</a>`).join("") + `<a class="chip solid" href="/posts">Social &#8599;</a>`;
  const empty = sort === "following" && !viewer
    ? `<div class="empty">Follow creators and their new workflows land here. <a href="/creator">Sign in with Google</a> to start.</div>`
    : `<div class="empty">${q ? "Nothing matches that search yet." : sort === "following" ? "You are not following anyone yet. Open a workflow you like and follow its creator." : "No workflows here yet. Be the first to publish one."}</div>`;
  const body = `
        <section class="page-head">
          <h1>${q ? `Results for "${esc(q)}"` : catName ? esc(catName) : sort === "following" ? "From creators you follow" : "Workflows worth trying"}</h1>
          <p class="lead">${q ? `${total} workflow${total === 1 ? "" : "s"} match.` : "Practical stories and exact prompts from people using Muse."}</p>
        </section>
        <div class="two-col">
          <div class="main">
            <div class="filter-row">
              <div class="chips">${chips}</div>
              <div class="chips">${sorts}</div>
            </div>
            <form class="search-row" action="/workflows" method="get" role="search">
              <input type="search" name="q" value="${esc(q)}" placeholder="Search workflows or creators" aria-label="Search workflows" maxlength="80" />
              ${category ? `<input type="hidden" name="category" value="${esc(category)}" />` : ""}
              ${sort !== "trending" ? `<input type="hidden" name="sort" value="${esc(sort)}" />` : ""}
              <button class="cta ghost" type="submit">Search</button>
            </form>
            ${tag ? `<div class="chips" style="margin-bottom:10px"><span class="chip" aria-current="true">#${esc(tag)}</span><a class="chip" href="${esc(link({ tag: "" }))}">Clear</a></div>` : ""}
            ${rows.length ? `<div class="rows">${interleaveWild(rows, { ours: category, page, savedSet }).join("")}</div>` : empty}
            ${page > 1 || hasMore ? `<div class="pager">${page > 1 ? `<a class="cta ghost" href="${esc(link({ page: page - 1 }))}">Newer</a>` : ""}${hasMore ? `<a class="cta ghost" href="${esc(link({ page: page + 1 }))}">More</a>` : ""}</div>` : ""}
          </div>
          <aside class="rail">
            <div class="rail-box">
              <div class="k">Top creators this week</div>
              ${top.length ? `<ol class="rank-list">${top.map((cr, i) => `<li><span class="rank">${i + 1}</span><a href="/creators/${esc(cr.handle)}">${esc(cr.displayName)}</a><span class="n">${cr.usefulWeek} useful</span></li>`).join("")}</ol>` : `<p>No creators ranked yet. The first to publish and collect reactions lands here.</p>`}
              <a class="link" href="/creators">View creators</a>
            </div>
            <div class="rail-box tint">
              <h3>Become a creator</h3>
              <p>Document what you already did with Muse. Your next useful workflow could be the one people follow.</p>
              <a class="cta" href="/submit">Start posting</a>
            </div>
          </aside>
        </div>`;
  return layout({
    title, description, path: "/workflows", current: "/workflows", body, script: SESSION_JS + ACCOUNT_JS,
    jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: SITE + "/workflows", description, isPartOf: { "@id": SITE + "/#website" } },
    noindex: Boolean(q) || Boolean(tag) || Boolean(category) || page > 1 || sort !== "trending",
    extraScript: wild.COPY_JS + wild.SHARE_JS + wild.SAVE_JS,
  });
}

function notFoundPage(what) {
  return layout({
    title: "Not found | Built with Muse", description: "That page does not exist.", path: "/workflows", noindex: true, current: "/workflows",
    body: `<section class="hero"><div><div class="eyebrow">Not found</div><h1>That ${what} is not here.</h1><p class="lead">It may have been unpublished, or the link is wrong.</p><p style="margin-top:22px"><a class="cta" href="/workflows">Browse the pool</a></p></div></section>`,
  });
}

async function pageWorkflow(slug, req) {
  const row = await workflowBySlug(slug);
  const creator = row ? await creatorFromRequest(req) : null;
  const isOwner = row && creator && creator.id === row.creator_id;
  const isMod = row && deps.isAdmin(req);
  if (!row || row.status === "removed" || row.creator_status === "removed") return { status: 404, html: notFoundPage("workflow") };
  const visible = row.status === "published" && (!row.hidden_at || isOwner || isMod);
  if (!visible && !isOwner && !isMod) return { status: 404, html: notFoundPage("workflow") };
  const w = publicWorkflow(row);
  const isArtifact = w.kind === "artifact";
  const parts = await loadParts(row.id);
  const deviceId = deps.deviceFromCookie(req);
  let yourRating = null;
  if (deviceId) {
    const r = await pool.query("SELECT score FROM workflow_ratings WHERE workflow_id = $1 AND device_id = $2", [row.id, deviceId]);
    yourRating = r.rows[0] ? r.rows[0].score : null;
  }
  let savedNow = false;
  let saveCount = 0;
  {
    const s = await pool.query("SELECT count(*) AS n FROM workflow_saves WHERE workflow_id = $1", [row.id]);
    saveCount = Number(s.rows[0].n);
    if (creator) {
      const mine = await pool.query("SELECT 1 FROM workflow_saves WHERE workflow_id = $1 AND creator_id = $2", [row.id, creator.id]);
      savedNow = Boolean(mine.rows[0]);
      // Adopt a save from before they signed in so it follows the account.
      if (!savedNow && deviceId) {
        const moved = await pool.query(
          `UPDATE workflow_saves SET creator_id = $2, device_id = NULL
            WHERE workflow_id = $1 AND device_id = $3 AND creator_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM workflow_saves WHERE workflow_id = $1 AND creator_id = $2)`,
          [row.id, creator.id, deviceId]
        );
        savedNow = moved.rowCount > 0;
      }
    } else if (deviceId) {
      const mine = await pool.query("SELECT 1 FROM workflow_saves WHERE workflow_id = $1 AND device_id = $2", [row.id, deviceId]);
      savedNow = Boolean(mine.rows[0]);
    }
  }
  const comments = await listComments(row.id, creator ? creator.id : null);
  const reactionRows = (await pool.query("SELECT kind, count(*)::int AS n, bool_or(device_id = $2) AS mine FROM workflow_reactions WHERE workflow_id = $1 GROUP BY kind", [row.id, deviceId || ""])).rows;
  const reactions = REACTION_KINDS.map(([kind, emoji, label]) => { const found = reactionRows.find((x) => x.kind === kind); return { kind, emoji, label, n: found ? found.n : 0, mine: found ? Boolean(found.mine) : false }; });
  const ownerBlocked = isOwner || (deviceId ? await isOwnerDevice(row.creator_id, deviceId) : false);
  const creatorUseful = Number((await pool.query("SELECT count(*) AS n FROM workflow_reactions r JOIN workflows x ON x.id = r.workflow_id WHERE x.creator_id = $1", [row.creator_id])).rows[0].n);
  const more = (await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE ${DISCOVERABLE} AND c.id = $1 AND w.id <> $2 ORDER BY s.weighted_score DESC LIMIT 3`, [row.creator_id, row.id])).rows;
  const related = row.category ? (await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE ${DISCOVERABLE} AND cat.slug = $1 AND w.id <> $2 ORDER BY s.weighted_score DESC LIMIT 3`, [row.category, row.id])).rows : [];
  if (related.length < 3) {
    const have = new Set(related.map((m) => m.id));
    const fill = (await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE ${DISCOVERABLE} AND w.id <> $1 ORDER BY s.weighted_score DESC LIMIT 6`, [row.id])).rows.filter((m) => !have.has(m.id)).slice(0, 3 - related.length);
    related.push(...fill);
  }
  const creatorRow = await creatorByHandle(row.handle);
  const c = publicCreator(creatorRow);
  const creatorMemberNo = await memberNumber(creatorRow);
  const memberTotal = Number((await pool.query("SELECT count(*)::int AS n FROM creator_profiles WHERE status = 'active'")).rows[0].n);
  let following = false;
  let followerCount = 0;
  {
    const fc = await pool.query("SELECT count(*) AS n FROM creator_follows WHERE followed_id = $1", [row.creator_id]);
    followerCount = Number(fc.rows[0].n);
    if (creator && creator.id !== row.creator_id) {
      const f = await pool.query("SELECT 1 FROM creator_follows WHERE follower_id = $1 AND followed_id = $2", [creator.id, row.creator_id]);
      following = Boolean(f.rows[0]);
    }
  }
  const canFollow = creator && creator.id !== row.creator_id && !c.editorial;
  const stepsHtml = parts.steps.map((s) => (typeof s === "string" ? `<li><span>${esc(s)}</span></li>` : `<li><span><strong>${esc(s.title)}</strong>${esc(s.body)}</span></li>`)).join("");
  const title = `${w.title} | Built with Muse`;
  const description = w.summary;
  const rl = ratingLabel(w);
  const stateNote = row.status !== "published" ? `<div class="callout"><strong>${row.status === "draft" ? "Draft" : "Unpublished"}</strong>Only you can see this page.</div>` : row.hidden_at ? `<div class="callout"><strong>Hidden after reports</strong>Visitors cannot see this workflow until a moderator restores it.</div>` : "";
  const deactivated = row.creator_status === "deactivated" ? `<div class="callout"><strong>Deactivated creator</strong>This creator's account is deactivated. The workflow stays readable but is no longer listed.</div>` : "";
  const isPublic = row.status === "published" && !row.hidden_at && row.creator_status === "active";
  const shareUrl = SITE + "/workflows/" + w.slug + "?s=1";
  const kitText = isArtifact ? "Made with Muse: " + w.title : "Worth stealing: " + w.title;
  const kitX = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(kitText) + "&url=" + encodeURIComponent(shareUrl) + "&via=" + PLATFORM_HANDLE;
  const kitThreads = "https://www.threads.net/intent/post?text=" + encodeURIComponent(kitText + " " + shareUrl + " via @" + PLATFORM_HANDLE);
  const stripWrap = (k, copy, buttons) => `<div style="margin:28px 0;padding:22px 24px;border:1px solid var(--line);border-radius:var(--radius);background:rgba(255,255,255,.05)"><div style="color:var(--muted-2);font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">${k}</div><p style="margin:0 0 14px;color:var(--muted);line-height:1.5;font-size:15px">${copy}</p><div style="display:flex;gap:10px;flex-wrap:wrap">${buttons}</div></div>`;
  const joinStrip = !isPublic ? "" : isOwner
    ? stripWrap("This page is yours", "Send it around. Every visit is a reader who can follow you, react to the work and find your other pages from your profile.", `<a class="cta" href="/submit">Publish another</a><a class="cta ghost" href="/creator">Your dashboard</a>`)
    : creator
      ? stripWrap("Your turn", `You are one of ${memberTotal} members here. Publish your own ${isArtifact ? "artifact" : "workflow"} and put it in front of the whole community.`, `<a class="cta" href="${isArtifact ? "/submit?type=artifact" : "/submit"}">Publish yours</a><a class="cta ghost" href="${isArtifact ? "/artifacts" : "/workflows"}">${isArtifact ? "More artifacts" : "More workflows"}</a>`)
      : stripWrap("Join the community", `Muse paused its own sharing, so members show their work here instead. ${memberTotal} members publish workflows and artifacts, carry a member number, and get featured when their work helps people.`, `<a class="cta" href="/">Get a code</a><a class="cta ghost" href="/submit">Publish yours</a>`);
  const faqItems = [];
  if (w.summary) faqItems.push({ q: isArtifact ? "What is this artifact?" : "What does this workflow do?", a: w.summary });
  if (row.prompt) faqItems.push({ q: isArtifact ? "What prompt made this artifact?" : "What prompt does this workflow use?", a: row.prompt.length > 300 ? row.prompt.slice(0, 300).trimEnd() + "..." : row.prompt });
  faqItems.push(isArtifact
    ? { q: "How was this made?", a: "The prompt the author used is on this page, above the artifact. Copy it into Muse and adjust the details to your situation. The artifact above is what the author got, and the page stays up even while sharing inside Muse is paused." }
    : { q: "How do I use this workflow?", a: "Copy the prompt from this page into Muse and adjust the details to your situation. The result above is what the author got. Every workflow here is free to use; you just need access to Muse, and if you do not have an invite yet you can claim a community code on the homepage." });
  const faqHtml = isPublic && faqItems.length ? `<section class="faq"><h2>Questions about this workflow</h2>${faqItems.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join("")}</section>` : "";
  const body = `
        <section class="hero solo">
          <div>
            <div class="eyebrow">${esc(isArtifact ? "Artifact" : (w.categoryName || "Workflow"))}</div>
            <h1 class="title-case">${esc(w.title)}</h1>
            <p class="lead">${esc(w.summary)}</p>
            <div class="meta"><span>by <a href="/creators/${esc(c.handle)}">${esc(c.displayName)}</a>${c.editorial ? ' <span class="badge editorial">Editorial</span>' : ""}${FEATURED_SLUGS.includes(w.slug) ? ' <span class="badge editorial">Featured</span>' : ""}</span><span>Updated ${esc(dateLabel(w.updatedAt))}</span><span>Useful · ${w.reactionCount}</span></div>
            ${w.tags.length ? `<div class="tags">${w.tags.map((t) => `<a class="chip" href="/workflows?tag=${esc(t)}">#${esc(t)}</a>`).join("")}</div>` : ""}
            <div class="react-row" id="react-row" data-workflow="${esc(w.id)}">
              ${reactions.map((r) => `<button class="react-btn${r.mine ? " on" : ""}" type="button" data-kind="${r.kind}" aria-pressed="${r.mine}" title="${esc(r.label)}"><span class="e" aria-hidden="true">${r.emoji}</span>${esc(r.label)}<b>${r.n || ""}</b></button>`).join("")}
              <button class="react-btn share-btn" type="button" data-share-url="${esc(SITE + "/workflows/" + w.slug + "?s=1")}" data-share-title="${esc(w.title)}" title="Share this workflow"><span class="e" aria-hidden="true">&#8599;</span>Share</button>
              ${row.muse_url ? `<a class="react-btn muse-link" href="${esc(row.muse_url)}" target="_blank" rel="noopener noreferrer nofollow"><span class="e" aria-hidden="true">&#9679;</span>Open in Muse</a>` : ""}
              <span class="rate-status" id="react-status" aria-live="polite"></span>
            </div>${isPublic ? `
            <div class="kit-row">
              <span class="kit-label">Share this ${isArtifact ? "artifact" : "workflow"}</span>
              <a class="react-btn" data-kit="x" href="${esc(kitX)}" target="_blank" rel="noopener">Post to X</a>
              <a class="react-btn" data-kit="threads" href="${esc(kitThreads)}" target="_blank" rel="noopener">Post to Threads</a>
              <button class="react-btn" type="button" data-kit="copy" data-kit-url="${esc(shareUrl)}">Copy link</button>
              <span class="rate-status" id="kit-status" aria-live="polite"></span>
            </div>` : ""}
          </div>

        </section>
        ${row.prompt ? `<section class="prompt-block">
          <div class="k">${isArtifact ? "The prompt behind it" : "Say this to Muse"}</div>
          <pre class="prompt" id="prompt-text">${esc(row.prompt)}</pre>
          <div class="prompt-actions"><button class="cta" type="button" id="copy-prompt">Copy prompt</button><span class="rate-status" id="copy-status" aria-live="polite"></span></div>
          <p class="prompt-hint">${isArtifact ? "Copy it into Muse and make it yours." : "Copy it into Muse and run it."}</p>
        </section>` : ""}
        <div class="layout">
          <article>
            ${stateNote}${deactivated}
            ${(w.problem || row.problem) ? `<h2>${isArtifact ? "What they were making" : "The problem"}</h2><p>${esc(w.problem || row.problem).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />")}</p>` : ""}
            ${parts.prerequisites.length ? `<h2>Before you start</h2><ul>${parts.prerequisites.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
            ${parts.steps.length ? `<h2>Steps</h2><ol class="steps">${stepsHtml}</ol>` : ""}
            ${isArtifact && !row.result ? "" : `<h2>${isArtifact ? "The artifact" : "The result"}</h2>
            <p>${esc(row.result).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />")}</p>`}
            ${faqHtml}
            ${row.screenshot_url ? `<figure class="proof-shot"><img src="${esc(row.screenshot_url)}" alt="${isArtifact ? "The artifact, shared by its author" : "Screenshot from the workflow author"}" loading="lazy" /><figcaption>${isArtifact ? "Shared by the author." : "Screenshot shared by the author as proof."}</figcaption></figure>` : ""}
            ${row.proof_url ? `<div class="proof-box"><span class="badge proof">Proof attached</span><a href="${esc(row.proof_url)}" target="_blank" rel="noopener noreferrer nofollow">Open the source</a></div>` : ""}
            <div class="report-box">
              <div class="save-report-row">
                <button class="save-icon save-btn${savedNow ? " on" : ""}" type="button" data-workflow="${esc(w.id)}" aria-label="${savedNow ? "Saved. Click to unsave." : "Save this workflow"}" aria-pressed="${savedNow ? "true" : "false"}">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>
                </button>
                <span class="rate-status" id="save-status" aria-live="polite">${saveCount ? `${saveCount} save${saveCount === 1 ? "" : "s"}` : ""}</span>
                <details id="report-details">
                  <summary>Report this workflow</summary>
                <form id="report-form" data-workflow="${esc(w.id)}">
                  <p class="wild-note" style="margin:8px 0 0">Reports go to a moderator with your message. They are for spam, unsafe or stolen content, not for disagreeing with a result.</p>
                  <select name="reason" aria-label="Reason"><option value="spam">Spam</option><option value="unsafe">Unsafe or harmful</option><option value="stolen">Stolen from someone else</option><option value="other">Something else</option></select>
                  <textarea name="detail" rows="3" maxlength="500" placeholder="Tell the moderator what is wrong (optional message)"></textarea>
                  <div style="display:flex;gap:10px;align-items:center;margin-top:10px"><button class="cta ghost" type="submit">Send report</button><span class="rate-status" id="report-status" aria-live="polite"></span></div>
                </form>
                </details>
              </div>
            </div>
            ${joinStrip}
          </article>
          <aside class="rail">
            <div class="rail-box">
              <div class="k">Creator</div>
              <div class="profile-head">${avatarHtml(c, "56px")}<div><h3 style="margin:0">${esc(c.displayName)}</h3><p style="margin:0">@${esc(c.handle)}${creatorMemberNo ? ` · Member #${creatorMemberNo}` : ""}</p></div></div>
              <div class="stat-row">${creatorUseful ? `<div class="stat"><b>${creatorUseful}</b><span>Useful</span></div>` : ""}${followerCount ? `<div class="stat"><b data-followers>${followerCount}</b><span>Followers</span></div>` : ""}<div class="stat"><b>${c.workflowCount}</b><span>Workflows</span></div></div>
              <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap"><a class="link" href="/creators/${esc(c.handle)}">See the profile</a>${canFollow ? `<button class="follow-btn lg${following ? " on" : ""}" type="button" data-handle="${esc(c.handle)}">${following ? "Following" : "Follow"}</button>` : ""}${followerCount ? `<span class="rate-status">${followerCount} follower${followerCount === 1 ? "" : "s"}</span>` : ""}</div>
            </div>
            ${more.length ? `<div class="rail-box"><div class="k">More from this creator</div>${more.map((m) => `<a class="link" href="/workflows/${esc(m.slug)}">${esc(m.title)}<small>${esc(ratingLabel(publicWorkflow(m)).text === "New" ? "New" : ratingLabel(publicWorkflow(m)).text + " · " + ratingLabel(publicWorkflow(m)).count)}</small></a>`).join("")}</div>` : ""}
            ${related.length ? `<div class="rail-box"><div class="k">Related in ${esc(w.categoryName)}</div>${related.map((m) => `<a class="link" href="/workflows/${esc(m.slug)}">${esc(m.title)}<small>by ${esc(m.display_name)}</small></a>`).join("")}</div>` : ""}
            ${(() => { const posts = wild.pick({ ours: row.category, limit: 2 }); return posts.length ? `<div class="rail-box"><div class="k">Posted on X and Threads</div>${posts.map((p) => `<a class="link" href="/posts/${esc(p.category)}#post-${esc(p.id)}">${esc(p.title)}<small>${esc(p.handle || p.name || "")} on ${esc(p.platform === "x" ? "X" : p.platform)}</small></a>`).join("")}<a class="link" href="/posts">All ${wild.load().total + wild.communityCount()} posts</a></div>` : ""; })()}
            <div class="rail-box">
              <div class="k">Not in Muse yet?</div>
              <p>The community pool hands out free invite codes.</p>
              <a class="cta" href="/">Get a code</a>
            </div>
          </aside>
        </div>
        <section class="comments" id="comments">
          <div class="section-title"><h2>Discussion</h2><p>${comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "No comments yet"}</p></div>
          <div id="comment-list">${comments.map((cm) => commentHtml(cm, { id: creator ? creator.id : null, owner: isOwner })).join("") || `<div class="empty">Be the first to share how this worked for you.</div>`}</div>
          ${creator
            ? `<form id="comment-form" data-workflow="${esc(w.id)}">
                <textarea name="body" rows="3" maxlength="500" placeholder="Tried it? Share what happened." aria-label="Write a comment"></textarea>
                <div style="display:flex;gap:10px;align-items:center;margin-top:10px"><button class="cta" type="submit">Post comment</button><span class="rate-status" id="comment-status" aria-live="polite"></span></div>
              </form>`
            : `<p><a class="cta ghost" href="/creator">Sign in to join the discussion</a></p>`}
        </section>`;
  const script = `${SESSION_JS}${ACCOUNT_JS}
      (() => {
        const post = (path, options) => fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, ...options });
        document.querySelectorAll(".report-btn").forEach((b) => b.addEventListener("click", () => {
          const d = document.getElementById("report-details"); if (!d) return;
          d.open = true; d.scrollIntoView({ behavior: "smooth", block: "center" });
          const ta = d.querySelector("textarea"); if (ta) setTimeout(() => ta.focus(), 400);
        }));
        const form = document.getElementById("report-form");
        if (form) form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const s = document.getElementById("report-status"); s.className = "rate-status"; s.textContent = "Sending";
          const r = await post("/api/v1/workflows/" + form.dataset.workflow + "/report", { method: "POST", body: JSON.stringify({ reason: form.reason.value, detail: form.detail.value }) });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.ok) { s.textContent = d.duplicate ? "You already reported this." : "Thanks. A moderator will look."; form.querySelector("button").disabled = true; }
          else { s.className = "rate-status err"; s.textContent = d.error === "rate_limited" ? "Too many reports from this device." : "Could not send. Reload and try again."; }
        });
        const rrow = document.getElementById("react-row");
        if (rrow) rrow.querySelectorAll(".react-btn[data-kind]").forEach((b) => b.addEventListener("click", async () => {
          const st = document.getElementById("react-status"); st.className = "rate-status"; st.textContent = "";
          b.disabled = true;
          try {
            const r = await post("/api/v1/workflows/" + rrow.dataset.workflow + "/react", { method: "POST", body: JSON.stringify({ kind: b.dataset.kind }) });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            d.reactions.forEach((x) => { const el = rrow.querySelector('.react-btn[data-kind="' + x.kind + '"]'); if (!el) return; el.classList.toggle("on", x.mine); el.setAttribute("aria-pressed", String(x.mine)); el.querySelector("b").textContent = x.n || ""; });
          } catch (e) {
            st.className = "rate-status err";
            st.textContent = { own_work: "That one is yours.", no_device: "Reload the page and try again.", rate_limited: "Slow down a little." }[e.message] || "Could not save that. Try again.";
          }
          b.disabled = false;
        }));
        document.querySelectorAll(".save-btn").forEach((saveBtn) => saveBtn.addEventListener("click", async () => {
          const s = document.getElementById("save-status"); s.className = "rate-status"; s.textContent = "Saving";
          try {
            const r = await post("/api/v1/workflows/" + saveBtn.dataset.workflow + "/save", { method: "POST" });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            document.querySelectorAll(".save-btn").forEach((b) => {
              b.classList.toggle("on", d.saved);
              b.setAttribute("aria-pressed", String(d.saved));
              b.setAttribute("aria-label", d.saved ? "Saved. Click to unsave." : "Save this workflow");
            });
            s.textContent = d.saves ? d.saves + (d.saves === 1 ? " save" : " saves") : "";
          } catch (err) {
            s.className = "rate-status err";
            if (err && err.message === "sign_in_required") {
              s.innerHTML = 'Sign in to keep this workflow on every device. <a href="/creator" style="color:#8f6b2d;font-weight:700">Sign in with Google</a>';
            } else {
              s.textContent = "Could not save. Reload and try again.";
            }
          }
        }));
        const copyBtn = document.getElementById("copy-prompt");
        if (copyBtn) copyBtn.addEventListener("click", async () => {
          const t = document.getElementById("prompt-text").textContent;
          const s = document.getElementById("copy-status"); s.className = "rate-status"; s.textContent = "Copying";
          const done = () => { s.textContent = "Copied!"; setTimeout(() => { s.textContent = ""; }, 2000); };
          try { await navigator.clipboard.writeText(t); done(); }
          catch (_) {
            const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
            try { document.execCommand("copy"); done(); } catch (_) { s.className = "rate-status err"; s.textContent = "Copy failed. Select the text manually."; }
            ta.remove();
          }
        });
        document.querySelectorAll(".follow-btn").forEach((btn) => btn.addEventListener("click", async () => {
          const handle = btn.dataset.handle;
          const wasFollowing = btn.classList.contains("on");
          btn.disabled = true;
          try {
            const r = await post("/api/v1/creators/" + encodeURIComponent(handle) + "/follow", { method: wasFollowing ? "DELETE" : "POST" });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            document.querySelectorAll(".follow-btn").forEach((b) => {
              b.classList.toggle("on", d.following);
              b.textContent = d.following ? "Following" : "Follow";
              b.disabled = false;
            });
          } catch (_) {
            btn.disabled = false;
          }
        }));
        const cform = document.getElementById("comment-form");
        if (cform) cform.addEventListener("submit", async (e) => {
          e.preventDefault();
          const s = document.getElementById("comment-status"); s.className = "rate-status"; s.textContent = "Posting";
          const r = await post("/api/v1/workflows/" + cform.dataset.workflow + "/comments", { method: "POST", body: JSON.stringify({ body: cform.body.value }) });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.ok) { location.reload(); }
          else { s.className = "rate-status err"; s.textContent = d.error === "rate_limited" ? "Too many comments right now. Wait a bit." : "Could not post. Try again."; }
        });
        document.querySelectorAll(".like-btn").forEach((b) => b.addEventListener("click", async () => {
          const r = await post("/api/v1/comments/" + b.dataset.comment + "/like", { method: "POST" });
          if (r.status === 401) { window.location.href = "/creator"; return; }
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) return;
          b.classList.toggle("on", d.liked); b.setAttribute("aria-pressed", String(d.liked));
          b.textContent = "Like" + (d.likes ? " (" + d.likes + ")" : "");
        }));
        document.querySelectorAll(".delete-comment").forEach((b) => b.addEventListener("click", async () => {
          if (!window.confirm("Delete this comment? This cannot be undone.")) return;
          const r = await post("/api/v1/comments/" + b.dataset.comment, { method: "DELETE" });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) { b.textContent = "Could not delete"; return; }
          const node = b.closest(".comment"); if (node) node.remove();
          const left = document.querySelectorAll("#comment-list .comment").length;
          const label = document.querySelector("#comments .section-title p");
          if (label) label.textContent = left ? left + " comment" + (left === 1 ? "" : "s") : "No comments yet";
          if (!left) document.getElementById("comment-list").innerHTML = '<div class="empty">Be the first to share how this worked for you.</div>';
        }));
        document.querySelectorAll(".report-comment").forEach((b) => b.addEventListener("click", async () => {
          if (!window.confirm("Report this comment as inappropriate?")) return;
          const r = await post("/api/v1/comments/" + b.dataset.comment + "/report", { method: "POST", body: JSON.stringify({ reason: "other" }) });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.ok) { b.disabled = true; b.textContent = d.duplicate ? "Already reported" : "Reported"; }
        }));
      })();` + wild.SHARE_JS + KIT_JS;
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "HowTo", name: w.title, description: w.summary, url: SITE + "/workflows/" + w.slug,
      author: { "@type": c.editorial ? "Organization" : "Person", name: c.displayName, url: SITE + "/creators/" + c.handle },
      datePublished: w.publishedAt, dateModified: w.updatedAt,
      step: parts.steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, text: typeof s === "string" ? s : s.body })) },
    ...(isPublic && faqItems.length ? [{ "@type": "FAQPage", mainEntity: faqItems.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) }] : []),
  ] };
  return { status: 200, html: layout({ title, description, path: "/workflows/" + w.slug, ogType: "article", ogImage: SITE + "/og/workflow-share-v2.png", current: "/workflows", body, script, jsonld, extraCss: KIT_CSS + FAQ_CSS, noindex: row.status !== "published" || Boolean(row.hidden_at) || row.creator_status !== "active" }) };
}

async function pageCreator(handle, req) {
  const row = await creatorByHandle(handle);
  if (!row || row.status === "removed") return { status: 404, html: notFoundPage("creator") };
  const c = publicCreator(row);
  const memberNo = await memberNumber(row);
  const isMod = deps.isAdmin(req);
  const hidden = row.status === "deactivated";
  const viewer = await creatorFromRequest(req).catch(() => null);
  const isOwner = Boolean(viewer && viewer.id === row.id);
  let following = false;
  const followerCount = Number((await pool.query("SELECT count(*) AS n FROM creator_follows WHERE followed_id = $1", [row.id])).rows[0].n);
  const useful = Number((await pool.query("SELECT count(*) AS n FROM workflow_reactions r JOIN workflows w ON w.id = r.workflow_id WHERE w.creator_id = $1", [row.id])).rows[0].n);
  if (viewer && !isOwner) {
    const f = await pool.query("SELECT 1 FROM creator_follows WHERE follower_id = $1 AND followed_id = $2", [viewer.id, row.id]);
    following = Boolean(f.rows[0]);
  }
  const canFollow = !isOwner && !row.is_editorial;
  const { rows } = hidden && !isMod ? { rows: [] } : await listWorkflows({ handle: c.handle, sort: "new", page: 1, kind: "workflow" });
  const { rows: artifactRows } = hidden && !isMod ? { rows: [] } : await listWorkflows({ handle: c.handle, sort: "new", page: 1, kind: "artifact", limit: 12 });
  const feedPosts = hidden ? [] : (await listFeedPosts({ viewerId: viewer ? viewer.id : null, creatorId: row.id, limit: 10 })).posts;
  const savedSet = await savedWorkflowIds(viewer, deps.deviceFromCookie(req));
  const badge = c.editorial ? "Editorial" : new Date(c.joinedAt) < new Date("2026-10-15T00:00:00Z") ? "Founding creator" : "Creator";
  const socials = [["websiteUrl", "Website"], ["xUrl", "X"], ["instagramUrl", "Instagram"], ["threadsUrl", "Threads"], ["linkedinUrl", "LinkedIn"], ["youtubeUrl", "YouTube"], ["tiktokUrl", "TikTok"]].filter(([k]) => c[k]);
  const title = `${c.displayName} (@${c.handle}) on Built with Muse`;
  const description = c.bio || `Muse workflows published by ${c.displayName}: ${c.workflowCount} workflow${c.workflowCount === 1 ? "" : "s"}${followerCount ? `, ${followerCount} follower${followerCount === 1 ? "" : "s"}` : ""}.`;
  const body = `
        <section class="profile-center">
          ${avatarHtml(c, "96px")}
          <h1 class="title-case">${esc(c.displayName)}</h1>
          <span class="badge ${c.editorial ? "editorial" : "soft"}">${badge}</span>${memberNo ? ` <span class="badge soft">Member #${memberNo}</span>` : ""}${hidden ? ' <span class="badge off">Deactivated</span>' : ""}
          <p class="handle">@${esc(c.handle)}</p>
          ${c.bio ? `<p class="bio">${esc(c.bio)}</p>` : ""}
          ${socials.length ? `<div class="social-row">${socials.map(([k, label]) => `<a href="${esc(c[k])}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`).join("")}</div>` : ""}
          ${c.links.length ? `<div class="profile-links">${c.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow"><span>${esc(l.label)}</span><i aria-hidden="true">&#8599;</i></a>`).join("")}</div>` : ""}
          <div class="profile-stats">${followerCount ? `<span><b data-followers>${followerCount}</b> follower${followerCount === 1 ? "" : "s"}</span>` : ""}<span><b>${c.workflowCount}</b> workflow${c.workflowCount === 1 ? "" : "s"}</span>${useful ? `<span><b>${useful}</b> useful</span>` : ""}</div>
          <div class="profile-actions">
            ${isOwner ? `<a class="cta" href="/submit">Document your workflow</a><a class="cta ghost" href="/creator#profile">Edit profile</a>` : canFollow ? `<button class="cta follow-btn${following ? " on" : ""}" type="button" data-handle="${esc(c.handle)}">${following ? "Following" : "Follow"}</button>` : ""}
            <button class="cta ghost share-btn" type="button" data-share-url="${esc(SITE + "/creators/" + c.handle)}" data-share-title="${esc(c.displayName + " on Built with Muse")}">Share profile</button>
          </div>
          <span class="rate-status" id="share-status-p" aria-live="polite"></span>
        </section>
        ${c.editorial ? `<div class="callout narrow"><strong>Researched, not community authored</strong>These workflows were written up by the Built with Muse team from public reports and Meta's announcements.</div>` : ""}
        ${hidden ? `<div class="callout narrow"><strong>Deactivated</strong>This creator has deactivated their account. Their workflows are no longer listed.</div>` : ""}
        <div class="narrow">
          <div class="tabs" role="tablist">
            <button class="tab" type="button" role="tab" aria-selected="true" data-tab="workflows">Workflows</button>
            <button class="tab" type="button" role="tab" aria-selected="false" data-tab="about">About</button>
          </div>
          <div id="tab-workflows">${rows.length ? `<div class="rows">${rows.map((r) => rowHtml(r, savedSet)).join("")}</div>` : `<div class="empty">Nothing published yet.</div>`}</div>
          <div id="tab-about" hidden>
            <div class="about-box">
              ${c.bio ? `<p>${esc(c.bio)}</p>` : ""}
              <p class="muted">Joined ${esc(new Date(c.joinedAt).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }))}${socials.length ? ` · ${socials.map(([k, label]) => `<a href="${esc(c[k])}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`).join(" · ")}` : ""}</p>
            </div>
          </div>
          ${artifactRows.length ? `<div class="section-title"><h2>Artifacts</h2></div><div class="rows">${artifactRows.map((r) => artifactRowHtml(r, savedSet)).join("")}</div>` : ""}
          ${feedPosts.length ? `<div class="section-title"><h2>Posts</h2></div><div class="rows">${feedPosts.map((p) => feedCardHtml(p, viewer)).join("")}</div>` : ""}
        </div>`;
  const jsonld = { "@context": "https://schema.org", "@type": c.editorial ? "Organization" : "Person", name: c.displayName, url: SITE + "/creators/" + c.handle, description };
  const script = `
      (() => {
        const post = (path, options) => fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, ...options });
        document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
          document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
          document.getElementById("tab-workflows").hidden = t.dataset.tab !== "workflows";
          document.getElementById("tab-about").hidden = t.dataset.tab !== "about";
        }));
        document.querySelectorAll(".share-btn").forEach((b) => b.addEventListener("click", async () => {
          const url = b.dataset.shareUrl, title = b.dataset.shareTitle, st = document.getElementById("share-status-p");
          try {
            if (navigator.share) { await navigator.share({ title, url }); return; }
            await navigator.clipboard.writeText(url);
            st.className = "rate-status"; st.textContent = "Profile link copied."; setTimeout(() => { st.textContent = ""; }, 2000);
          } catch (_) { st.className = "rate-status"; st.textContent = url; }
        }));
        document.querySelectorAll(".follow-btn").forEach((btn) => btn.addEventListener("click", async () => {
          const handle = btn.dataset.handle;
          const wasFollowing = btn.classList.contains("on");
          btn.disabled = true;
          try {
            const r = await post("/api/v1/creators/" + encodeURIComponent(handle) + "/follow", { method: wasFollowing ? "DELETE" : "POST" });
            if (r.status === 401) { window.location.href = "/creator"; return; }
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            btn.classList.toggle("on", d.following);
            btn.textContent = d.following ? "Following" : "Follow";
            document.querySelectorAll("[data-followers]").forEach((el) => { el.textContent = String(Math.max(0, Number(el.textContent) + (d.following ? 1 : -1))); });
          } catch (_) {}
          btn.disabled = false;
        }));
      })();`;
  return { status: 200, html: layout({ title, description, path: "/creators/" + c.handle, ogType: "profile", current: "/creators", body, script: SESSION_JS + ACCOUNT_JS + script + wild.SAVE_JS + FEED_JS, extraCss: FEED_CSS + ARTIFACT_CSS, jsonld, noindex: hidden }) };
}

// The creators page: the week's top three, then everyone with an audience,
// published work and total community response.
async function pageLeaderboard() {
  const all = await creatorsToFollow(60);
  const top = all.slice(0, 3);
  const title = "Meet the people building with Muse | Built with Muse";
  const description = "Follow creators who share useful work, exact prompts and honest results.";
  const badge = (cr) => (new Date(cr.joinedAt) < new Date("2026-10-15T00:00:00Z") ? "Founding creator" : "Creator");
  const body = `
        <section class="page-head">
          <h1>Meet the people building with Muse</h1>
          <p class="lead">Follow creators who share useful work, exact prompts and honest results.</p>
        </section>
        <section class="tint-panel">
          <div class="panel-head"><div><h2>Top creators this week</h2><p>The creators whose work is helping people most right now.</p></div><span class="badge soft">Weekly leaders</span></div>
          ${top.length ? `<div class="top3">${top.map((cr, i) => `<a class="top3-card" href="/creators/${esc(cr.handle)}"><span class="rank">${i + 1}</span><span class="who">${avatarHtml(cr, "36px")}<b>${esc(cr.displayName)}</b></span><small>${cr.usefulWeek ? `${cr.usefulWeek} useful this week` : `${cr.workflowCount} workflow${cr.workflowCount === 1 ? "" : "s"}`} · ${badge(cr)}</small></a>`).join("")}</div>` : `<div class="empty">No creators ranked yet. Publish a workflow and collect the first reactions.</div>`}
        </section>
        <section class="page-head" style="margin-top:36px">
          <h2 class="h1-like">All creators</h2>
          <p class="lead">See their published work and how the community responds to it.</p>
        </section>
        ${all.length ? `<div class="creator-rows">${all.map((cr) => `<a class="creator-row" href="/creators/${esc(cr.handle)}">${avatarHtml(cr, "44px")}<span class="who"><b>${esc(cr.displayName)}</b><span class="badge soft">${badge(cr)}</span></span><span class="stats">${cr.followers ? `<span><b>${cr.followers}</b>followers</span>` : ""}<span><b>${cr.workflowCount}</b>workflows</span>${cr.useful ? `<span><b>${cr.useful}</b>total useful</span>` : ""}</span></a>`).join("")}</div>` : `<div class="empty">No creators yet. <a href="/creator">Be the first.</a></div>`}
        <div class="quote-band" id="quote-band"><p>Muse is new and there are no big names yet. Share your workflows and become <em class="hl">the person people follow</em>.</p><a class="cta" href="/submit">Become a creator</a></div>`;
  return { status: 200, html: layout({ title, description, path: "/creators", current: "/creators", body, script: SESSION_JS + ACCOUNT_JS, jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: SITE + "/creators", description } }) };
}

async function pageArtifacts(url, req) {
  const viewer = req ? await creatorFromRequest(req).catch(() => null) : null;
  const page = Math.max(1, Math.min(200, Number(url.searchParams.get("page")) || 1));
  const { rows, hasMore } = await listWorkflows({ sort: "new", page, kind: "artifact", limit: 24 });
  const savedSet = await savedWorkflowIds(viewer, deps.deviceFromCookie(req));
  const memberTotal = Number((await pool.query("SELECT count(*)::int AS n FROM creator_profiles WHERE status = 'active'")).rows[0].n);
  const title = "Artifacts people made with Muse | Built with Muse";
  const description = "Muse paused its own sharing. Members show the artifacts they made here instead: the finished thing, the prompt behind it, and the person who made it.";
  const body = `
        <section class="page-head">
          <div class="eyebrow">Community artifacts</div>
          <h1>Muse sharing is paused. Your work still deserves an audience.</h1>
          <p class="lead">Meta switched off share links inside Muse on October 20, 2026. This page is where the work gets shown instead: the artifact itself, the prompt behind it, and the maker, on a page that stays up. ${memberTotal} members are here.</p>
          <div class="artifact-cta-row"><a class="cta" href="/submit?type=artifact">Share your artifact</a><a class="cta ghost" href="/">Get a Muse code</a></div>
        </section>
        ${rows.length ? `<div class="rows">${rows.map((r) => artifactRowHtml(r, savedSet)).join("")}</div>` : `<div class="empty">No artifacts yet. The first one sets the bar. <a href="/submit?type=artifact">Share yours</a>.</div>`}
        ${hasMore ? `<div class="artifact-cta-row"><a class="cta ghost" href="/artifacts?page=${page + 1}">More artifacts</a></div>` : ""}`;
  return { status: 200, html: layout({ title, description, path: "/artifacts", current: "/artifacts", body, script: SESSION_JS + ACCOUNT_JS + wild.SAVE_JS, extraCss: ARTIFACT_CSS, jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: SITE + "/artifacts", description } }) };
}

async function sitemapXml() {
  const workflows = (await pool.query(`SELECT w.slug, w.updated_at ${WORKFLOW_FROM} WHERE ${DISCOVERABLE} ORDER BY w.published_at DESC LIMIT 5000`)).rows;
  const creators = (await pool.query(`SELECT handle, updated_at FROM creator_profiles WHERE status = 'active' AND EXISTS (SELECT 1 FROM workflows w WHERE w.creator_id = creator_profiles.id AND w.status = 'published')`)).rows;
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const urls = [`  <url><loc>${SITE}/feed</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`, `  <url><loc>${SITE}/workflows</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`, `  <url><loc>${SITE}/artifacts</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`, `  <url><loc>${SITE}/creators</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`, `  <url><loc>${SITE}/posts</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`]
    .concat(wild.load().categories.map((c) => `  <url><loc>${SITE}/posts/${esc(c.id)}</loc><lastmod>${esc(wild.load().updated)}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`))
    .concat(workflows.map((w) => `  <url><loc>${SITE}/workflows/${esc(w.slug)}</loc><lastmod>${day(w.updated_at)}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`))
    .concat(creators.map((c) => `  <url><loc>${SITE}/creators/${esc(c.handle)}</loc><lastmod>${day(c.updated_at)}</lastmod><changefreq>weekly</changefreq><priority>0.5</priority></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

// Share card for the code-pool share link (/share). Unfurlers read the invite
// codes card here; human visitors are passed through to the homepage.
function shareCardPage() {
  const card = SITE + "/og/homepage-share.png";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Active Muse Invite Codes | Built with Muse</title>
<meta name="robots" content="noindex, nofollow" />
<link rel="canonical" href="${SITE}/" />
<meta property="og:title" content="Active Muse Invite Codes | Built with Muse" />
<meta property="og:description" content="Muse is still invite only. Here is where people are finding working codes." />
<meta property="og:url" content="${SITE}/share" />
<meta property="og:type" content="website" />
<meta property="og:image" content="${card}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Active Muse Invite Codes | Built with Muse" />
<meta name="twitter:description" content="Muse is still invite only. Here is where people are finding working codes." />
<meta name="twitter:image" content="${card}" />
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#fff;color:#111}a{color:#2656ff}</style>
</head>
<body>
<p>Taking you to <a href="/">Built with Muse</a></p>
<script>location.replace("/");</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Feed. The post box sits at the top of /feed and articles are the
// longer option written at /feed/new. One stream, newest first: original
// posts and reposts interleaved by time, the way X mixes them. Every
// post carries the X action bar: reply (real comments on the post page),
// repost, like and share. Likes and reposts are one per account across
// both kinds. Workflows stay on their own pages and never appear here.
// Post and comment bodies are plain text: blank lines become paragraphs
// and every character is escaped at render, so a post can never inject
// markup.
const FEED_LIMITS = { quickBody: [1, 500], articleTitle: [3, 120], articleBody: [1, 20000], commentBody: [1, 500] };
const FEED_PAGE_SIZE = 30;
const FEED_SELECT = `
  fp.id, fp.creator_id, fp.kind, fp.title, fp.body, fp.status, fp.created_at,
  (SELECT count(*) FROM feed_likes fl WHERE fl.post_id = fp.id)::int AS like_count,
  (SELECT count(*) FROM feed_comments fc WHERE fc.post_id = fp.id AND fc.status = 'published')::int AS comment_count,
  (SELECT count(*) FROM feed_reposts fr WHERE fr.post_id = fp.id)::int AS repost_count,
  c.handle, c.display_name, c.avatar_url, c.is_editorial, c.status AS creator_status`;
const FEED_FROM = `
  FROM feed_posts fp
  JOIN creator_profiles c ON c.id = fp.creator_id`;
// Publicly visible: the post is published, its author is an active
// account, and it is a quick post or an article. Rows of any other kind
// (the legacy workflow entries) can never render.
const FEED_VISIBLE = `fp.status = 'published' AND c.status = 'active' AND fp.kind IN ('quick', 'article')`;

const FEED_CSS = `
/* Feed design (tweets for quick posts, Substack for articles). Every
   color comes from the --fx tokens below, so the dark theme is one block
   of token values instead of a rule per surface. Dark values are tuned to
   the site navy: body text over 12:1, muted text over 7:1, the faintest
   meta over 6:1, and the accent blue lifted so links read on navy. */
:root { --fx-ink: #0b1220; --fx-text: #1c2536; --fx-muted: #4b5675; --fx-faint: #5f6b8c; --fx-line: #e3e8f4; --fx-line-strong: #cfd8ee; --fx-surface: #ffffff; --fx-surface-2: #f5f7fd; --fx-hover: rgba(26, 86, 255, .035); --fx-accent: #1a56ff; --fx-accent-soft: rgba(26, 86, 255, .1); --fx-like: #e0245e; --fx-like-soft: rgba(224, 36, 94, .1); --fx-repost: #00a36c; --fx-repost-soft: rgba(0, 163, 108, .1); --fx-danger: #d92d20; --fx-serif: Charter, "Iowan Old Style", "Source Serif Pro", Georgia, serif; --fx-shadow: 0 1px 2px rgba(11, 18, 32, .04), 0 8px 24px rgba(11, 18, 32, .05); }
:root[data-theme="dark"] { --fx-ink: #f5f8ff; --fx-text: #e2e9ff; --fx-muted: #b4c3ef; --fx-faint: #93a6dc; --fx-line: rgba(255, 255, 255, .11); --fx-line-strong: rgba(255, 255, 255, .2); --fx-surface: #10214b; --fx-surface-2: #172b5e; --fx-hover: rgba(255, 255, 255, .03); --fx-accent: #7aa0ff; --fx-accent-soft: rgba(122, 160, 255, .16); --fx-like: #ff6b96; --fx-like-soft: rgba(255, 107, 150, .14); --fx-repost: #3ddba3; --fx-repost-soft: rgba(61, 219, 163, .14); --fx-danger: #ff7a70; --fx-shadow: 0 1px 2px rgba(0, 0, 0, .25), 0 10px 30px rgba(0, 0, 0, .25); }

/* Legacy article form wrappers, still used by the guest article page. */
.feed-wrap { max-width: 720px; margin: 0 auto; }
.feed-box { background: var(--fx-surface); border: 1px solid var(--fx-line); border-radius: 16px; padding: 18px 20px; box-shadow: var(--fx-shadow); margin-bottom: 10px; }
.feed-signin { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }

/* Page layout: the timeline card plus a sticky rail on wide screens. */
.fx-layout { display: grid; grid-template-columns: minmax(0, 640px) 300px; gap: 28px; justify-content: center; align-items: start; }
.fx-layout > .fx-col { margin: 0; }
.fx-rail { position: sticky; top: 20px; display: grid; gap: 16px; }
@media (max-width: 1060px) { .fx-layout { grid-template-columns: minmax(0, 640px); } .fx-rail { display: none; } }
.fx-col { max-width: 640px; margin: 0 auto; background: var(--fx-surface); border: 1px solid var(--fx-line); border-radius: 18px; box-shadow: var(--fx-shadow); overflow: clip; color: var(--fx-text); }

/* Sticky header with title and tabs. */
.fx-top { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--fx-surface) 88%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--fx-line); }
.fx-top-title { margin: 0; padding: 16px 20px 4px; font-size: 22px; line-height: 1.2; letter-spacing: -0.02em; color: var(--fx-ink); }
.fx-tabs { display: flex; padding: 0 8px; }
.fx-tabs a { flex: 1; display: flex; justify-content: center; color: var(--fx-muted); font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px 10px 0 0; }
.fx-tabs a:hover { background: var(--fx-hover); color: var(--fx-ink); }
.fx-tabs a span { position: relative; padding: 14px 2px; }
.fx-tabs a[aria-current="page"] { color: var(--fx-ink); font-weight: 700; }
.fx-tabs a[aria-current="page"] span::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; border-radius: 999px; background: var(--fx-accent); }

/* Composer. */
.fx-signin { padding: 14px 20px; border-bottom: 1px solid var(--fx-line); }
.fx-compose { padding: 16px 20px 12px; border-bottom: 1px solid var(--fx-line); }
.fx-compose-top { display: flex; gap: 12px; align-items: flex-start; }
.fx-compose textarea { flex: 1; min-width: 0; border: 0; background: transparent; padding: 10px 0 6px; min-height: 0; height: auto; max-height: 260px; overflow-y: auto; resize: none; font: inherit; font-size: 19px; line-height: 1.4; color: var(--fx-ink); box-shadow: none; }
.fx-compose textarea::placeholder { color: var(--fx-faint); }
.fx-compose textarea:focus { outline: none; border: 0; box-shadow: none; }
.fx-compose-actions { display: flex; align-items: center; gap: 12px; margin: 10px 0 0 56px; padding-top: 12px; border-top: 1px solid var(--fx-line); }
.fx-compose-actions > :first-child { margin-right: auto; }
.fx-compose-actions .rate-status { min-height: 0; font-size: 13px; color: var(--fx-muted); }
.fx-compose-actions .rate-status:empty { display: none; }
.fx-write-link { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 14px; border: 1px solid var(--fx-line-strong); border-radius: 999px; color: var(--fx-ink); font-size: 13.5px; font-weight: 600; text-decoration: none; background: transparent; }
.fx-write-link:hover { background: var(--fx-hover); border-color: var(--fx-accent); }
.fx-count { color: var(--fx-faint); font-size: 13px; font-variant-numeric: tabular-nums; }
.fx-count:empty { display: none; }
.fx-count.low { color: var(--fx-danger); font-weight: 700; }
.fx-post-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 0 20px; border: 0; border-radius: 999px; background: var(--blue); color: #fff; font: inherit; font-size: 14.5px; font-weight: 700; text-decoration: none; cursor: pointer; }
.fx-post-btn:hover { background: var(--blue-deep); color: #fff; }
.fx-post-btn:disabled { opacity: .55; cursor: default; }
.fx-compose-actions .fx-post-btn { margin-left: 0; }
.fx-ava-ghost { background: var(--fx-surface-2) !important; border: 1px dashed var(--fx-line-strong); }
.fx-guest-prompt { flex: 1; padding: 10px 0 6px; color: var(--fx-faint); font-size: 19px; line-height: 1.4; text-decoration: none; }
.fx-guest-prompt:hover { color: var(--fx-ink); }
.fx-guest-note { color: var(--fx-muted); font-size: 13.5px; }

/* Latest read: the Substack moment at the top of For you. */
.fx-feature { display: block; padding: 20px; border-bottom: 1px solid var(--fx-line); text-decoration: none; color: inherit; background: linear-gradient(180deg, var(--fx-accent-soft), transparent 70%); }
.fx-feature:hover .fx-feature-title { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 4px; }
.fx-kicker { display: inline-flex; align-items: center; gap: 8px; color: var(--fx-accent); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 10px; }
.fx-feature-title { margin: 0 0 8px; font-family: var(--fx-serif); font-size: clamp(24px, 3.4vw, 30px); font-weight: 700; line-height: 1.18; letter-spacing: -0.015em; color: var(--fx-ink); text-wrap: balance; }
.fx-feature-dek { margin: 0 0 14px; color: var(--fx-muted); font-size: 16px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.fx-feature-by { display: flex; align-items: center; gap: 10px; color: var(--fx-muted); font-size: 14px; }
.fx-feature-by b { color: var(--fx-ink); font-weight: 700; }

/* Timeline rows, tweet style. */
.fx-row { display: block; padding: 16px 20px; border: 0; border-bottom: 1px solid var(--fx-line); border-radius: 0; box-shadow: none; background: transparent; cursor: pointer; transition: background .12s ease; }
.fx-row:last-of-type { border-bottom: 0; }
.fx-row:hover { background: var(--fx-hover); }
.rows .fx-row { background: var(--fx-surface); border: 1px solid var(--fx-line); border-radius: 16px; margin-bottom: 10px; }
.fx-row-in { display: flex; gap: 12px; }
.fx-repost-note { display: flex; align-items: center; gap: 8px; margin: 0 0 6px 30px; color: var(--fx-muted); font-size: 13px; font-weight: 700; }
.fx-repost-note svg { width: 16px; height: 16px; display: block; }
.fx-repost-note svg path { fill: currentColor; }
.fx-repost-note a { color: inherit; text-decoration: none; }
.fx-repost-note a:hover { text-decoration: underline; }
.fx-avawrap { flex: 0 0 auto; align-self: flex-start; line-height: 0; text-decoration: none; }
.fx-ava { display: grid; place-items: center; border-radius: 50%; overflow: hidden; background: var(--fx-surface-2); }
.fx-ava img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fx-init { color: #fff; font-family: "Archivo", sans-serif; font-weight: 700; line-height: 1; }
.fx-main { flex: 1; min-width: 0; }
.fx-head { display: flex; align-items: baseline; gap: 5px; font-size: 15px; white-space: nowrap; overflow: hidden; margin-bottom: 2px; }
.fx-name { font-weight: 700; color: var(--fx-ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; }
.fx-name:hover { text-decoration: underline; }
.fx-sub { color: var(--fx-faint); overflow: hidden; text-overflow: ellipsis; }
.fx-time { color: var(--fx-faint); text-decoration: none; flex: 0 0 auto; }
a.fx-time:hover { text-decoration: underline; color: var(--fx-muted); }
.fx-title { font-size: 16px; font-weight: 700; line-height: 1.3; color: var(--fx-ink); margin: 2px 0 3px; }
.fx-title a { color: inherit; text-decoration: none; }
.fx-text { font-size: 15.5px; line-height: 1.5; color: var(--fx-text); overflow-wrap: anywhere; }
.fx-text p { margin: 0 0 10px; font-size: inherit; line-height: inherit; color: inherit; }
.fx-text p:last-child { margin-bottom: 0; }
.fx-text a { color: var(--fx-accent); text-decoration: none; }
.fx-text a:hover { text-decoration: underline; }

/* Article card inside a row, Substack style. */
.fx-article-card { display: block; margin: 8px 0 2px; padding: 16px 18px; border: 1px solid var(--fx-line-strong); border-radius: 14px; text-decoration: none; color: inherit; background: var(--fx-surface); transition: border-color .12s ease, background .12s ease; }
.fx-article-card:hover { border-color: var(--fx-accent); background: var(--fx-hover); }
.fx-article-kicker { display: block; color: var(--fx-accent); font-size: 11.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 8px; }
.fx-article-title { margin: 0 0 6px; font-family: var(--fx-serif); font-size: 21px; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; color: var(--fx-ink); }
.fx-article-dek { margin: 0 0 12px; color: var(--fx-muted); font-size: 15px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.fx-article-more { color: var(--fx-accent); font-size: 14px; font-weight: 700; }

/* Action bar. */
.fx-actions { display: flex; align-items: center; margin-top: 8px; }
.fx-bar-group { display: flex; align-items: center; justify-content: space-between; flex: 1; max-width: 440px; }
.fx-bar-group > :first-child { margin-left: -8px; }
.fx-act, .fx-like { display: inline-flex; align-items: center; gap: 2px; background: none; border: 0; padding: 0; cursor: pointer; color: var(--fx-faint); font: inherit; font-size: 13px; text-decoration: none; transition: color .12s ease; }
.fx-act .fx-ico, .fx-heart { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; transition: background .12s ease; }
.fx-act svg, .fx-like svg { width: 18px; height: 18px; display: block; }
.fx-act svg path { fill: currentColor; }
.fx-like svg path { fill: none; stroke: currentColor; stroke-width: 1.8; }
.fx-act b, .fx-like b { font-weight: 500; font-variant-numeric: tabular-nums; }
.fx-act b:empty, .fx-like b:empty { display: none; }
.fx-act:disabled, .fx-like:disabled { opacity: .6; cursor: default; }
.fx-reply:hover, .fx-share:hover { color: var(--fx-accent); }
.fx-reply:hover .fx-ico, .fx-share:hover .fx-ico { background: var(--fx-accent-soft); }
.fx-repost:hover, .fx-repost.on { color: var(--fx-repost); }
.fx-repost:hover .fx-ico { background: var(--fx-repost-soft); }
.fx-like:hover, .fx-like.on { color: var(--fx-like); }
.fx-like:hover .fx-heart { background: var(--fx-like-soft); }
.fx-like.on svg path { fill: currentColor; }
.fx-del { margin-left: auto; background: none; border: 0; padding: 4px 0 4px 12px; color: var(--fx-faint); font: inherit; font-size: 13px; cursor: pointer; }
.fx-del:hover { color: var(--fx-danger); text-decoration: underline; }
.fx-pager { display: flex; justify-content: space-between; padding: 16px 20px; border-top: 1px solid var(--fx-line); }
.fx-pager a { color: var(--fx-accent); font-size: 14px; font-weight: 700; text-decoration: none; }
.fx-pager a:hover { text-decoration: underline; }
.fx-empty { padding: 56px 24px; text-align: center; color: var(--fx-muted); }
.fx-empty p { margin: 0 0 16px; font-size: 15.5px; }

/* Rail cards. */
.fx-card { background: var(--fx-surface); border: 1px solid var(--fx-line); border-radius: 18px; box-shadow: var(--fx-shadow); padding: 18px 20px; color: var(--fx-text); }
.fx-card h2 { margin: 0 0 6px; font-size: 18px; letter-spacing: -0.015em; color: var(--fx-ink); }
.fx-card p { margin: 0 0 14px; color: var(--fx-muted); font-size: 14.5px; line-height: 1.5; }
.fx-card .fx-post-btn { width: 100%; }
.fx-people { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 2px; }
.fx-people a { display: flex; align-items: center; gap: 10px; padding: 8px 10px; margin: 0 -10px; border-radius: 12px; text-decoration: none; color: inherit; }
.fx-people a:hover { background: var(--fx-hover); }
.fx-people .who { min-width: 0; display: grid; }
.fx-people b { color: var(--fx-ink); font-size: 14.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-people .who span { color: var(--fx-faint); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-people em { margin-left: auto; font-style: normal; color: var(--fx-muted); font-size: 12.5px; white-space: nowrap; }
.fx-rail-links { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 0 6px; }
.fx-rail-links a { color: var(--fx-faint); font-size: 13px; text-decoration: none; }
.fx-rail-links a:hover { color: var(--fx-ink); text-decoration: underline; }

/* Post page. */
.fx-post { padding: 0; border: 0; border-radius: 0; box-shadow: none; background: transparent; }
.fx-post-main { padding: 18px 20px 4px; display: flex; gap: 12px; }
.fx-post-main .fx-text { font-size: 18px; line-height: 1.55; }
.fx-post-title { font-size: 20px; font-weight: 800; line-height: 1.25; letter-spacing: -0.01em; color: var(--fx-ink); margin: 4px 0 6px; }
.fx-bar { margin-top: 12px; padding: 4px 20px; border-top: 1px solid var(--fx-line); border-bottom: 1px solid var(--fx-line); }
.fx-author { display: flex; gap: 12px; align-items: center; padding: 16px 20px; border-top: 1px solid var(--fx-line); }
.fx-author-main { flex: 1; min-width: 0; }
.fx-author-main b { display: block; font-size: 15px; color: var(--fx-ink); }
.fx-author-main span { color: var(--fx-faint); font-size: 14px; }
.fx-profile-link { flex: 0 0 auto; border: 1px solid var(--fx-line-strong); border-radius: 999px; padding: 7px 16px; color: var(--fx-ink); font-size: 14px; font-weight: 700; text-decoration: none; }
.fx-profile-link:hover { background: var(--fx-hover); border-color: var(--fx-accent); }
.fx-comment-form { display: flex; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--fx-line); align-items: flex-start; }
.fx-comment-main { flex: 1; min-width: 0; }
.fx-comment-main textarea { width: 100%; border: 0; background: transparent; padding: 9px 0 4px; min-height: 0; height: auto; max-height: 200px; overflow-y: auto; resize: none; font: inherit; font-size: 17px; line-height: 1.4; color: var(--fx-ink); box-shadow: none; }
.fx-comment-main textarea::placeholder { color: var(--fx-faint); }
.fx-comment-main textarea:focus { outline: none; border: 0; box-shadow: none; }
.fx-comment-actions { display: flex; align-items: center; gap: 14px; margin-top: 6px; }
.fx-comment-actions .rate-status { min-height: 0; font-size: 13px; }
.fx-comment-actions .rate-status:empty { display: none; }
.fx-comment-actions .fx-post-btn { margin-left: auto; }
.fx-comment { display: flex; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--fx-line); }
.fx-comment .fx-text { font-size: 15px; }
.fx-comment .fx-actions { margin-top: 2px; }

/* Article reading page and editor, Substack style. */
.fa-read { max-width: 700px; margin: 0 auto; padding: 0 4px; color: var(--fx-text); }
.fa-back { margin: 0 0 22px; }
.fa-back a { color: var(--fx-muted); font-size: 14px; font-weight: 600; text-decoration: none; }
.fa-back a::before { content: "\\2190"; margin-right: 6px; }
.fa-back a:hover { color: var(--fx-ink); }
.fa-article { background: transparent; border: 0; border-radius: 0; box-shadow: none; padding: 0; margin: 0 0 36px; }
.fa-title { margin: 0 0 20px; font-family: var(--fx-serif); font-size: clamp(32px, 5vw, 46px); font-weight: 700; line-height: 1.12; letter-spacing: -0.02em; color: var(--fx-ink); text-wrap: balance; }
.fa-dek { margin: 0 0 22px; font-size: 19px; line-height: 1.45; color: var(--fx-muted); }
.fa-byline { display: flex; align-items: center; gap: 12px; margin: 0 0 4px; }
.fa-byline-main { display: grid; gap: 2px; min-width: 0; }
.fa-author { color: var(--fx-ink); font-size: 15px; font-weight: 700; text-decoration: none; }
a.fa-author:hover { text-decoration: underline; }
.fa-meta { color: var(--fx-faint); font-size: 14px; }
.fa-article .fx-bar { padding: 4px 0; margin: 18px 0 30px; }
.fa-article .fx-bar-group { max-width: 360px; }
.fa-article .fx-bar-group > :first-child { margin-left: -8px; }
.fa-body p { margin: 0 0 1.35em; font-family: var(--fx-serif); font-size: 20px; line-height: 1.7; color: var(--fx-text); overflow-wrap: anywhere; }
.fa-body a { color: var(--fx-accent); }
.fa-replies { max-width: 700px; }
.fa-replies .fx-signin a { text-decoration: none; font-weight: 600; color: var(--fx-accent); }
.fa-replies-title { margin: 0; padding: 18px 20px 14px; font-size: 18px; color: var(--fx-ink); border-bottom: 1px solid var(--fx-line); }
.fa-replies-title span { color: var(--fx-faint); font-weight: 600; }
.fa-guest { padding: 8px 0 40px; }
.fa-editor { display: grid; gap: 14px; }
.fa-ed-bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--fx-line); background: color-mix(in srgb, var(--bg) 90%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
.fa-ed-bar .quiet-link { color: var(--fx-muted); font-size: 14px; font-weight: 600; text-decoration: none; }
.fa-ed-bar .rate-status { min-height: 0; font-size: 13px; }
.fa-ed-bar .rate-status:empty { display: none; }
.fa-ed-count { margin-left: auto; color: var(--fx-faint); font-size: 13px; }
.fa-ed-bar .fx-post-btn { margin-left: 0; }
.fa-editor .fa-byline { margin-top: 10px; }
.fa-editor textarea.fa-ed-title, .fa-editor textarea.fa-ed-body, :root[data-theme="dark"] .fa-editor textarea.fa-ed-title, :root[data-theme="dark"] .fa-editor textarea.fa-ed-body { width: 100%; border: 0; border-radius: 0; background: transparent; box-shadow: none; padding: 0; resize: none; overflow: hidden; color: var(--fx-ink); }
.fa-editor textarea.fa-ed-title { min-height: 0; font-family: var(--fx-serif); font-size: clamp(32px, 5vw, 46px); font-weight: 700; line-height: 1.12; letter-spacing: -0.02em; }
.fa-editor textarea.fa-ed-body { min-height: 360px; font-family: var(--fx-serif); font-size: 20px; line-height: 1.7; }
.fa-editor textarea:focus { outline: none; border: 0; box-shadow: none; }
.fa-editor textarea::placeholder { color: var(--fx-faint); }

/* The shared dark form rule paints textareas with a raised fill; the
   borderless composers here stay transparent. */
/* The shared article card rule (and its dark variant) would box these
   <article> elements; the feed draws its own surfaces. */
.fa-article, :root[data-theme="dark"] .fa-article, :root[data-theme="dark"] .fx-post { background: transparent; border: 0; box-shadow: none; }
:root[data-theme="dark"] .fx-col .fx-row { background: transparent; }
:root[data-theme="dark"] .fx-col .fx-row:hover { background: var(--fx-hover); }
:root[data-theme="dark"] .fx-compose textarea, :root[data-theme="dark"] .fx-comment-main textarea { background: transparent; border: 0; box-shadow: none; color: var(--fx-ink); }

@media (max-width: 640px) {
  .fx-row, .fx-compose, .fx-feature { padding-left: 16px; padding-right: 16px; }
  .fx-compose-actions { margin-left: 0; }
  .fa-body p, .fa-editor textarea.fa-ed-body { font-size: 18px; }
  .fx-guest-note { font-size: 12.5px; }
}
`;

function publicFeedPost(row, liked, reposted) {
  return {
    id: row.id, kind: row.kind,
    title: row.title || "",
    body: row.body || "",
    createdAt: row.created_at,
    likeCount: Number(row.like_count || 0), liked: Boolean(liked),
    commentCount: Number(row.comment_count || 0),
    repostCount: Number(row.repost_count || 0), reposted: Boolean(reposted),
    creator: { id: row.creator_id, handle: row.handle, displayName: row.display_name, avatarUrl: row.avatar_url, editorial: row.is_editorial },
  };
}
async function likedFeedIds(viewerId, ids) {
  if (!viewerId || !ids.length) return new Set();
  const r = await pool.query("SELECT post_id FROM feed_likes WHERE creator_id = $1 AND post_id = ANY($2)", [viewerId, ids]);
  return new Set(r.rows.map((x) => x.post_id));
}
async function repostedFeedIds(viewerId, ids) {
  if (!viewerId || !ids.length) return new Set();
  const r = await pool.query("SELECT post_id FROM feed_reposts WHERE creator_id = $1 AND post_id = ANY($2)", [viewerId, ids]);
  return new Set(r.rows.map((x) => x.post_id));
}
async function listFeedPosts({ viewerId = null, creatorId = null, page = 1, limit = FEED_PAGE_SIZE } = {}) {
  const where = [FEED_VISIBLE];
  const params = [];
  if (creatorId) { params.push(creatorId); where.push(`fp.creator_id = $${params.length}`); }
  params.push(limit + 1, (page - 1) * limit);
  const r = await pool.query(`SELECT ${FEED_SELECT} ${FEED_FROM} WHERE ${where.join(" AND ")} ORDER BY fp.created_at DESC, fp.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const rows = r.rows.slice(0, limit);
  const ids = rows.map((x) => x.id);
  const liked = await likedFeedIds(viewerId, ids);
  const reposted = await repostedFeedIds(viewerId, ids);
  return { posts: rows.map((x) => publicFeedPost(x, liked.has(x.id), reposted.has(x.id))), hasMore: r.rows.length > limit };
}
// The /feed stream: original posts and reposts interleaved by time.
// Each source is fetched a page deep (any entry in the merged page is
// inside the top page of its own source), merged in memory and sliced.
// A repost entry carries the original post plus who reposted it; a
// removed original or a deactivated reposter takes the entry out.
// kind narrows the stream to one tab: "quick" for Posts, "article" for
// Articles, null for everything.
async function listFeedStream({ viewerId = null, page = 1, limit = FEED_PAGE_SIZE, kind = null } = {}) {
  const take = page * limit + 1;
  const params = [take];
  let kindWhere = "";
  if (kind === "quick" || kind === "article") { params.push(kind); kindWhere = ` AND fp.kind = $2`; }
  const [pr, rr] = await Promise.all([
    pool.query(`SELECT ${FEED_SELECT} ${FEED_FROM} WHERE ${FEED_VISIBLE}${kindWhere} ORDER BY fp.created_at DESC, fp.id DESC LIMIT $1`, params),
    pool.query(`SELECT ${FEED_SELECT}, fr.creator_id AS reposter_id, fr.created_at AS reposted_at, rc.handle AS reposter_handle, rc.display_name AS reposter_name ${FEED_FROM}
      JOIN feed_reposts fr ON fr.post_id = fp.id
      JOIN creator_profiles rc ON rc.id = fr.creator_id
      WHERE ${FEED_VISIBLE}${kindWhere} AND rc.status = 'active'
      ORDER BY fr.created_at DESC LIMIT $1`, params),
  ]);
  const entries = [];
  for (const row of pr.rows) entries.push({ row, sortAt: new Date(row.created_at).getTime(), repost: null });
  for (const row of rr.rows) entries.push({ row, sortAt: new Date(row.reposted_at).getTime(), repost: { id: row.reposter_id, handle: row.reposter_handle, displayName: row.reposter_name } });
  entries.sort((a, b) => b.sortAt - a.sortAt);
  const pageEntries = entries.slice((page - 1) * limit, page * limit);
  const ids = [...new Set(pageEntries.map((e) => e.row.id))];
  const liked = await likedFeedIds(viewerId, ids);
  const reposted = await repostedFeedIds(viewerId, ids);
  return {
    posts: pageEntries.map((e) => ({ ...publicFeedPost(e.row, liked.has(e.row.id), reposted.has(e.row.id)), repostedBy: e.repost })),
    hasMore: entries.length > page * limit,
  };
}
function publicFeedComment(row) {
  return {
    id: row.id, body: row.body || "", createdAt: row.created_at,
    creator: { id: row.creator_id, handle: row.handle, displayName: row.display_name, avatarUrl: row.avatar_url, editorial: row.is_editorial },
  };
}
async function listFeedComments(postId, limit = 100) {
  const r = await pool.query(`SELECT fc.id, fc.body, fc.created_at, fc.creator_id, c.handle, c.display_name, c.avatar_url, c.is_editorial
    FROM feed_comments fc JOIN creator_profiles c ON c.id = fc.creator_id
    WHERE fc.post_id = $1 AND fc.status = 'published' AND c.status = 'active'
    ORDER BY fc.created_at DESC, fc.id DESC LIMIT $2`, [postId, limit]);
  return r.rows.map(publicFeedComment);
}
async function latestFeedArticle() {
  const r = await pool.query(`SELECT ${FEED_SELECT} ${FEED_FROM} WHERE ${FEED_VISIBLE} AND fp.kind = 'article' ORDER BY fp.created_at DESC, fp.id DESC LIMIT 1`);
  return r.rows[0] ? publicFeedPost(r.rows[0], false, false) : null;
}
// Most active posters over the last 30 days, for the rail.
async function activeFeedPeople(limit = 5) {
  const r = await pool.query(`SELECT c.handle, c.display_name, c.avatar_url, count(*)::int AS posts ${FEED_FROM}
    WHERE ${FEED_VISIBLE} AND fp.created_at > now() - interval '30 days'
    GROUP BY c.id, c.handle, c.display_name, c.avatar_url ORDER BY posts DESC, max(fp.created_at) DESC LIMIT $1`, [limit]);
  return r.rows.map((x) => ({ handle: x.handle, displayName: x.display_name, avatarUrl: x.avatar_url, posts: x.posts }));
}
async function feedPostById(id) {
  if (!/^[0-9a-f-]{36}$/.test(id || "")) return null;
  const r = await pool.query(`SELECT ${FEED_SELECT} ${FEED_FROM} WHERE fp.id = $1`, [id]);
  return r.rows[0] || null;
}
// Relative time the way a timeline shows it: 5m, 2h, 3d, then a short
// date. Computed at render from the stored timestamp.
function timeLabel(value) {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  if (d < 7) return d + "d";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
// Feed avatar: a true circle at a fixed size. The shared avatarHtml is a
// rounded square whose letter scales with the global font, which clipped
// badly at small sizes; the feed renders its own so the image or letter
// always sits centered inside 40px. Letter avatars get a quiet, deep
// background picked from the handle so a creator keeps one color.
const FX_AVATAR_COLORS = ["#5b6abf", "#3e7d74", "#8a5a83", "#a15c48", "#5d7d3a", "#5f6878", "#7a6238", "#44648f"];
function feedAvatarHtml(creator, size = 40) {
  const img = creator.avatarUrl || creator.avatar_url;
  const name = creator.displayName || creator.display_name || "?";
  if (img) return `<span class="fx-ava" style="width:${size}px;height:${size}px"><img src="${esc(img)}" alt="" referrerpolicy="no-referrer" /></span>`;
  const seed = String(creator.handle || name).split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const bg = FX_AVATAR_COLORS[seed % FX_AVATAR_COLORS.length];
  return `<span class="fx-ava" style="width:${size}px;height:${size}px;background:${bg}"><span class="fx-init" style="font-size:${Math.round(size * 0.38)}px">${esc(initials(name))}</span></span>`;
}
// Runs on text that is already escaped: turns bare URLs into links.
// Trailing sentence punctuation stays outside the link, and the trim
// never eats the tail of an escaped entity like &amp;
function linkifyEscaped(s) {
  return s.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/g, (m) => {
    let url = m, trail = "";
    while (url.length && /[.,;:!?)\]]/.test(url.slice(-1)) && !/&(amp|lt|gt|quot|#39);$/.test(url)) {
      trail = url.slice(-1) + trail;
      url = url.slice(0, -1);
    }
    const href = url.startsWith("www.") ? "https://" + url : url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
}
// Plain text to paragraphs: escape first, linkify, then blank lines split
// paragraphs and single line breaks stay visible. Same shape as the
// workflow pages use for their result text.
function paragraphsHtml(body) {
  return `<p>${linkifyEscaped(esc(body)).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />")}</p>`;
}
function feedExcerpt(body, n = 220) {
  const s = String(body || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n).trimEnd() + "..." : s;
}
// Reading time the way Substack shows it: words at 230 a minute, never
// under one minute.
function readMinutes(body) {
  const words = String(body || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}
const FX_REPLY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 4.42-3.584 8.005-8.005 8.005H9.62l-3.9 3.9v-3.9c-2.327-.66-3.969-2.72-3.969-5.265zm2.002 0c0 3.317 2.687 6.005 6.005 6.005h6.371l-4.468 4.468v-4.468H9.756c-3.318 0-6.003-2.688-6.005-6.005z"/></svg>`;
const FX_REPOST_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/></svg>`;
const FX_SHARE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>`;
function feedLikeBtn(p) {
  return `<button class="fx-like${p.liked ? " on" : ""}" type="button" data-feed-like="${esc(p.id)}" aria-pressed="${p.liked}" aria-label="Like"><span class="fx-heart"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></span><b>${p.likeCount || ""}</b></button>`;
}
// The X action bar: reply, repost, like, share, icons with counts and
// no labels, spread across the content column. On feed rows the reply
// is a link into the post page; on the post page it focuses the reply
// box instead. Counts render only above zero, the way X hides them.
function feedReplyBtn(p, onPostPage) {
  const inner = `<span class="fx-ico">${FX_REPLY_ICON}</span><b data-feed-reply-count="${esc(p.id)}">${p.commentCount || ""}</b>`;
  return onPostPage
    ? `<button class="fx-act fx-reply" type="button" data-feed-reply-focus aria-label="Reply">${inner}</button>`
    : `<a class="fx-act fx-reply" href="/feed/${esc(p.id)}" aria-label="Reply">${inner}</a>`;
}
function feedRepostBtn(p) {
  return `<button class="fx-act fx-repost${p.reposted ? " on" : ""}" type="button" data-feed-repost="${esc(p.id)}" aria-pressed="${Boolean(p.reposted)}" aria-label="Repost"><span class="fx-ico">${FX_REPOST_ICON}</span><b>${p.repostCount || ""}</b></button>`;
}
function feedShareBtn(p) {
  return `<button class="fx-act fx-share" type="button" data-feed-share="${esc(p.id)}" aria-label="Share"><span class="fx-ico">${FX_SHARE_ICON}</span><b></b></button>`;
}
function feedActionBar(p, { own = false, onPostPage = false, delLabel = "Delete" } = {}) {
  return `<div class="fx-actions${onPostPage ? " fx-bar" : ""}"><div class="fx-bar-group">${feedReplyBtn(p, onPostPage)}${feedRepostBtn(p)}${feedLikeBtn(p)}${feedShareBtn(p)}</div>${own ? `<button class="fx-del" type="button" data-feed-delete="${esc(p.id)}"${onPostPage ? ` data-feed-delete-redirect="/feed"` : ""}>${delLabel}</button>` : ""}</div>`;
}
// A timeline row: avatar column, then name, handle and relative time on
// one line, the post, and the action bar. A quick post is just the text,
// the way a tweet reads. An article shows as a Substack style card inside
// the row: a small "Article" kicker with the reading time, the title, a
// two line dek and a read link, so long writing stands apart from quick
// posts without leaving the timeline. A repost entry is the same row with
// one small muted line above it.
function feedCardHtml(p, viewer) {
  const c = p.creator;
  const own = Boolean(viewer && viewer.id === c.id);
  const head = `<div class="fx-head"><a class="fx-name" href="/creators/${esc(c.handle)}">${esc(c.displayName)}</a><span class="fx-sub">@${esc(c.handle)}</span><span class="fx-sub">&middot;</span><a class="fx-time" href="/feed/${esc(p.id)}">${esc(timeLabel(p.createdAt))}</a></div>`;
  const actions = feedActionBar(p, { own });
  const inner = p.kind === "article"
    ? `<a class="fx-article-card" href="/feed/${esc(p.id)}"><span class="fx-article-kicker">Article &middot; ${readMinutes(p.body)} min read</span><h3 class="fx-article-title">${esc(p.title)}</h3><p class="fx-article-dek">${esc(feedExcerpt(p.body, 200))}</p><span class="fx-article-more">Read the article</span></a>`
    : `<div class="fx-text">${paragraphsHtml(p.body)}</div>`;
  let note = "";
  if (p.repostedBy) {
    const rb = p.repostedBy;
    const who = viewer && viewer.id === rb.id ? "You" : `<a href="/creators/${esc(rb.handle)}">${esc(rb.displayName)}</a>`;
    note = `<div class="fx-repost-note">${FX_REPOST_ICON}<span>${who} reposted</span></div>`;
  }
  return `<article class="fx-row" data-feed-card="${esc(p.id)}">${note}<div class="fx-row-in"><a class="fx-avawrap" href="/creators/${esc(c.handle)}">${feedAvatarHtml(c, 44)}</a><div class="fx-main">${head}${inner}${actions}</div></div></article>`;
}
// A comment on the post page: same timeline language as a post row,
// one size quieter. Delete shows to the comment author and to the
// post author.
function feedCommentHtml(cm, viewer, post) {
  const c = cm.creator;
  const canDelete = Boolean(viewer && (viewer.id === c.id || viewer.id === post.creator.id));
  const head = `<div class="fx-head"><a class="fx-name" href="/creators/${esc(c.handle)}">${esc(c.displayName)}</a><span class="fx-sub">@${esc(c.handle)}</span><span class="fx-sub">&middot;</span><span class="fx-time">${esc(timeLabel(cm.createdAt))}</span></div>`;
  const del = canDelete ? `<div class="fx-actions"><button class="fx-del" type="button" data-feed-comment-delete="${esc(cm.id)}">Delete</button></div>` : "";
  return `<div class="fx-comment" data-feed-comment="${esc(cm.id)}" data-feed-comment-post="${esc(post.id)}"><a class="fx-avawrap" href="/creators/${esc(c.handle)}">${feedAvatarHtml(c)}</a><div class="fx-main">${head}<div class="fx-text">${paragraphsHtml(cm.body)}</div>${del}</div></div>`;
}
// The Latest read block: kicker, serif headline, dek and byline, the
// whole block one link into the article.
function feedFeatureHtml(p) {
  const c = p.creator;
  return `<a class="fx-feature" href="/feed/${esc(p.id)}"><span class="fx-kicker">Latest read &middot; ${readMinutes(p.body)} min</span><h2 class="fx-feature-title">${esc(p.title)}</h2><p class="fx-feature-dek">${esc(feedExcerpt(p.body, 240))}</p><span class="fx-feature-by">${feedAvatarHtml(c, 28)}<span><b>${esc(c.displayName)}</b> &middot; ${esc(timeLabel(p.createdAt))}</span></span></a>`;
}
// Right rail on wide screens: a prompt to write, the people posting
// most this month, and a few site links.
function feedRailHtml({ signedIn, people }) {
  const write = `<div class="fx-card"><h2>Write on Built with Muse</h2><p>Quick posts for what you just got Muse to do. Articles for the full story, with the prompts.</p><a class="fx-post-btn" href="${signedIn ? "/feed/new" : "/creator"}">${signedIn ? "Write an article" : "Sign in to write"}</a></div>`;
  const who = people.length ? `<div class="fx-card"><h2>People posting</h2><ul class="fx-people">${people.map((c) => `<li><a href="/creators/${esc(c.handle)}">${feedAvatarHtml(c, 36)}<span class="who"><b>${esc(c.displayName)}</b><span>@${esc(c.handle)}</span></span><em>${c.posts} ${c.posts === 1 ? "post" : "posts"}</em></a></li>`).join("")}</ul></div>` : "";
  return `<aside class="fx-rail" aria-label="More">${write}${who}<nav class="fx-rail-links" aria-label="Explore"><a href="/workflows">Workflows</a><a href="/artifacts">Artifacts</a><a href="/creators">Creators</a><a href="/blog">Blog</a><a href="/submit">Publish a workflow</a></nav></aside>`;
}
function feedAuthorCard(p) {
  const c = p.creator;
  return `<div class="fx-author"><a class="fx-avawrap" href="/creators/${esc(c.handle)}">${feedAvatarHtml(c, 44)}</a><div class="fx-author-main"><b>${esc(c.displayName)}</b><span>@${esc(c.handle)}</span></div><a class="fx-profile-link" href="/creators/${esc(c.handle)}">View profile</a></div>`;
}

// Action bar, share and delete wiring for every page that renders feed
// cards or a post page. A post can appear several times in one stream
// (its own row plus repost entries), so a toggle updates every button
// for that post at once. A signed out tap on like or repost goes to the
// sign in page, the same way comment likes and follows behave.
const FEED_JS = `
      (() => {
        const post = (path, options) => fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, ...options });
        const syncToggle = (attr, id, on, count) => document.querySelectorAll("[" + attr + '="' + id + '"]').forEach((x) => {
          x.classList.toggle("on", on);
          x.setAttribute("aria-pressed", String(on));
          const n = x.querySelector("b");
          if (n) n.textContent = count || "";
        });
        document.querySelectorAll("[data-feed-like]").forEach((b) => b.addEventListener("click", async () => {
          b.disabled = true;
          try {
            const r = await post("/api/v1/feed/" + b.dataset.feedLike + "/like", { method: "POST", body: "{}" });
            if (r.status === 401) { window.location.href = "/creator"; return; }
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) return;
            syncToggle("data-feed-like", b.dataset.feedLike, d.liked, d.likes);
          } catch (_) {}
          b.disabled = false;
        }));
        document.querySelectorAll("[data-feed-repost]").forEach((b) => b.addEventListener("click", async () => {
          b.disabled = true;
          try {
            const r = await post("/api/v1/feed/" + b.dataset.feedRepost + "/repost", { method: "POST", body: "{}" });
            if (r.status === 401) { window.location.href = "/creator"; return; }
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) return;
            syncToggle("data-feed-repost", b.dataset.feedRepost, d.reposted, d.reposts);
          } catch (_) {}
          b.disabled = false;
        }));
        document.querySelectorAll("[data-feed-share]").forEach((b) => b.addEventListener("click", async () => {
          const url = window.location.origin + "/feed/" + b.dataset.feedShare;
          if (navigator.share) {
            try { await navigator.share({ url }); return; }
            catch (e) { if (e && e.name === "AbortError") return; }
          }
          try {
            await navigator.clipboard.writeText(url);
            const n = b.querySelector("b");
            if (n) { n.textContent = "Copied"; setTimeout(() => { n.textContent = ""; }, 1600); }
          } catch (_) {}
        }));
        document.querySelectorAll("[data-feed-reply-focus]").forEach((b) => b.addEventListener("click", () => {
          const t = document.getElementById("feed-comment-body");
          if (t) { t.scrollIntoView({ block: "center", behavior: "smooth" }); t.focus({ preventScroll: true }); }
        }));
        document.querySelectorAll("[data-feed-comment-delete]").forEach((b) => b.addEventListener("click", async () => {
          if (!window.confirm("Delete this comment? This cannot be undone.")) return;
          try {
            const r = await post("/api/v1/feed/comments/" + b.dataset.feedCommentDelete, { method: "DELETE" });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) return;
            const row = b.closest("[data-feed-comment]");
            const postId = row ? row.dataset.feedCommentPost : "";
            if (row) row.remove();
            if (postId) document.querySelectorAll('[data-feed-reply-count="' + postId + '"]').forEach((n) => {
              const next = Math.max(0, (parseInt(n.textContent, 10) || 0) - 1);
              n.textContent = next || "";
            });
          } catch (_) {}
        }));
        document.querySelectorAll("[data-feed-delete]").forEach((b) => b.addEventListener("click", async () => {
          if (!window.confirm("Delete this post? This cannot be undone.")) return;
          try {
            const r = await post("/api/v1/feed/" + b.dataset.feedDelete, { method: "DELETE" });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) return;
            if (b.dataset.feedDeleteRedirect) { window.location.href = b.dataset.feedDeleteRedirect; return; }
            document.querySelectorAll('[data-feed-card="' + b.dataset.feedDelete + '"]').forEach((card) => card.remove());
          } catch (_) {}
        }));
        document.querySelectorAll("[data-feed-card]").forEach((card) => card.addEventListener("click", (e) => {
          if (e.target.closest("a, button")) return;
          window.location.href = "/feed/" + card.dataset.feedCard;
        }));
      })();`;
const FEED_COMMENT_JS = `
      (() => {
        const form = document.getElementById("feed-comment-form");
        if (!form) return;
        const body = document.getElementById("feed-comment-body");
        const status = document.getElementById("feed-comment-status");
        const btn = document.getElementById("feed-comment-post");
        const grow = () => { body.style.height = "auto"; body.style.height = Math.min(body.scrollHeight, 200) + "px"; };
        body.addEventListener("input", grow);
        grow();
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const value = body.value.trim();
          status.className = "rate-status";
          if (!value) { status.textContent = "Write something first."; return; }
          if (value.length > 500) { status.textContent = "Keep it under 500 characters."; return; }
          btn.disabled = true;
          status.textContent = "Posting";
          try {
            const r = await fetch("/api/v1/feed/" + form.dataset.feedCommentForm + "/comments", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify({ body: value }) });
            if (r.status === 401) { window.location.href = "/creator"; return; }
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            window.location.reload();
          } catch (err) {
            status.className = "rate-status err";
            status.textContent = err && err.message === "rate_limited" ? "Too many comments right now. Wait a bit." : "Could not post. Try again.";
            btn.disabled = false;
          }
        });
      })();`;
const FEED_QUICK_JS = `
      (() => {
        const form = document.getElementById("feed-quick-form");
        if (!form) return;
        const body = document.getElementById("feed-quick-body");
        const status = document.getElementById("feed-quick-status");
        const btn = document.getElementById("feed-quick-post");
        const count = document.getElementById("feed-quick-count");
        // Remaining characters show only near the 500 limit, like X.
        const grow = () => {
          body.style.height = "auto"; body.style.height = Math.min(body.scrollHeight, 260) + "px";
          const left = 500 - body.value.length;
          if (count) { count.textContent = left <= 60 ? String(left) : ""; count.classList.toggle("low", left <= 20); }
        };
        body.addEventListener("input", grow);
        grow();
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const value = body.value.trim();
          status.className = "rate-status";
          if (!value) { status.textContent = "Write something first."; return; }
          if (value.length > 500) { status.textContent = "Keep it under 500 characters."; return; }
          btn.disabled = true;
          status.textContent = "Posting";
          try {
            const r = await fetch("/api/v1/feed", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify({ kind: "quick", body: value }) });
            if (r.status === 401) { window.location.href = "/creator"; return; }
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) throw new Error(d.error || "failed");
            window.location.href = "/feed/" + d.id;
          } catch (err) {
            status.className = "rate-status err";
            status.textContent = err && err.message === "rate_limited" ? "Too many posts right now. Wait a bit." : "Could not post. Try again.";
            btn.disabled = false;
          }
        });
      })();`;
const FEED_ARTICLE_JS = `
      (() => {
        const form = document.getElementById("feed-article-form");
        if (!form) return;
        const status = document.getElementById("fa-status");
        const btn = document.getElementById("fa-publish");
        const titleEl = document.getElementById("fa-title");
        const bodyEl = document.getElementById("fa-body");
        const countEl = document.getElementById("fa-count");
        // Both fields grow with their text so the page scrolls, not the box.
        // Enter in the title moves to the body instead of a line break.
        const grow = (el, min) => { el.style.height = "auto"; el.style.height = Math.max(min, el.scrollHeight) + "px"; };
        const words = () => {
          const n = bodyEl.value.trim().split(/\\s+/).filter(Boolean).length;
          countEl.textContent = n + (n === 1 ? " word" : " words") + (n ? " \\u00b7 " + Math.max(1, Math.round(n / 230)) + " min read" : "");
        };
        titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bodyEl.focus(); } });
        titleEl.addEventListener("input", () => { titleEl.value = titleEl.value.replace(/\\n/g, " "); grow(titleEl, 0); });
        bodyEl.addEventListener("input", () => { grow(bodyEl, 360); words(); });
        grow(titleEl, 0); grow(bodyEl, 360); words();
        const MSG = {
          title_short: "Give it a title of at least 3 characters.", title_long: "Keep the title under 120 characters.",
          body_short: "Write the article first.", body_long: "That article is over the limit. Trim it a little.",
          rate_limited: "Too many posts right now. Wait a bit."
        };
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const payload = { kind: "article", title: document.getElementById("fa-title").value.trim(), body: document.getElementById("fa-body").value };
          status.className = "rate-status";
          btn.disabled = true;
          status.textContent = "Publishing";
          try {
            const r = await fetch("/api/v1/feed", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify(payload) });
            if (r.status === 401) { window.location.href = "/creator"; return; }
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) {
              const errs = (d.errors || []).map((code) => MSG[code]).filter(Boolean);
              throw new Error(errs[0] || MSG[d.error] || "Could not publish. Try again.");
            }
            window.location.href = "/feed/" + d.id;
          } catch (err) {
            status.className = "rate-status err";
            status.textContent = err.message || "Could not publish. Try again.";
            btn.disabled = false;
          }
        });
      })();`;

async function pageFeed(url, req) {
  const viewer = req ? await creatorFromRequest(req).catch(() => null) : null;
  const page = Math.max(1, Math.min(200, Number(url.searchParams.get("page")) || 1));
  // Tabs across the top of the column, X style: everything, quick posts
  // only, or articles only (the Substack side of the feed).
  const TABS = [["", "For you", null], ["posts", "Posts", "quick"], ["articles", "Articles", "article"]];
  const tabKey = TABS.some((t) => t[0] === url.searchParams.get("tab")) ? url.searchParams.get("tab") : "";
  const tab = TABS.find((t) => t[0] === tabKey);
  const tabHref = (key, p = 1) => {
    const q = new URLSearchParams();
    if (key) q.set("tab", key);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return "/feed" + (s ? "?" + s : "");
  };
  const { posts, hasMore } = await listFeedStream({ viewerId: viewer ? viewer.id : null, page, kind: tab[2] });
  // Latest read: the newest article leads the For you tab on page one,
  // Substack style, and its own row is left out of the stream below.
  const featured = !tabKey && page === 1 ? await latestFeedArticle() : null;
  const people = await activeFeedPeople();
  const signedIn = Boolean(viewer && viewer.status === "active");
  const PROMPT = "What are you getting Muse to do?";
  // Signed out visitors see the same composer shape, inert, with one sign
  // in button where Post would be, so the page reads as a timeline they
  // can join rather than a lone button above it.
  const composer = signedIn
    ? `<div class="fx-compose">
            <form id="feed-quick-form">
              <div class="fx-compose-top">
                <a class="fx-avawrap" href="/creators/${esc(viewer.handle)}">${feedAvatarHtml(viewer, 44)}</a>
                <textarea id="feed-quick-body" rows="1" maxlength="500" placeholder="${PROMPT}" aria-label="${PROMPT}"></textarea>
              </div>
              <div class="fx-compose-actions">
                <a class="fx-write-link" href="/feed/new">Write an article</a>
                <span class="fx-count" id="feed-quick-count" aria-hidden="true"></span>
                <span class="rate-status" id="feed-quick-status" aria-live="polite"></span>
                <button class="fx-post-btn" type="submit" id="feed-quick-post">Post</button>
              </div>
            </form>
          </div>`
    : `<div class="fx-compose fx-compose-guest">
            <div class="fx-compose-top">
              <span class="fx-ava fx-ava-ghost" style="width:44px;height:44px"></span>
              <a class="fx-guest-prompt" href="/creator">${PROMPT}</a>
            </div>
            <div class="fx-compose-actions">
              <span class="fx-guest-note">Sign in to post, reply and write articles.</span>
              <a class="fx-post-btn" href="/creator">Sign in</a>
            </div>
          </div>`;
  const tabsHtml = `<div class="fx-top">
            <h1 class="fx-top-title">Feed</h1>
            <nav class="fx-tabs" aria-label="Feed">${TABS.map(([key, label]) => `<a href="${tabHref(key)}"${key === tabKey ? ` aria-current="page"` : ""}><span>${label}</span></a>`).join("")}</nav>
          </div>`;
  const emptyText = tab[2] === "article" ? "No articles yet. Long reads land here." : tab[2] === "quick" ? "No posts yet." : "Nothing here yet.";
  const empty = posts.length ? "" : `<div class="fx-empty"><p>${emptyText}</p>${signedIn ? `<a class="fx-write-link" href="${tab[2] === "article" ? "/feed/new" : "#feed-quick-body"}">${tab[2] === "article" ? "Write the first one" : "Write the first post"}</a>` : ""}</div>`;
  const stream = featured ? posts.filter((p) => p.repostedBy || p.id !== featured.id) : posts;
  const body = `
        <div class="fx-layout">
          <div class="fx-col">
            ${tabsHtml}
            ${composer}
            ${featured ? feedFeatureHtml(featured) : ""}
            ${stream.map((p) => feedCardHtml(p, viewer)).join("")}
            ${empty}
            ${page > 1 || hasMore ? `<div class="fx-pager">${page > 1 ? `<a href="${tabHref(tabKey, page - 1)}">Newer</a>` : "<span></span>"}${hasMore ? `<a href="${tabHref(tabKey, page + 1)}">More</a>` : ""}</div>` : ""}
          </div>
          ${feedRailHtml({ signedIn, people })}
        </div>`;
  const description = "Quick posts and long reads from people building with Muse, Meta's personal AI agent.";
  return layout({
    title: "Feed | Built with Muse",
    description,
    path: "/feed", current: "/feed", body, script: SESSION_JS + ACCOUNT_JS + FEED_JS + FEED_QUICK_JS, extraCss: FEED_CSS,
    jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", name: "Feed | Built with Muse", url: SITE + "/feed", description },
    noindex: page > 1 || Boolean(tabKey),
  });
}

async function pageFeedPost(id, req) {
  const row = await feedPostById(id);
  const viewer = req ? await creatorFromRequest(req).catch(() => null) : null;
  if (!row || row.status !== "published" || row.creator_status === "removed") return { status: 404, html: notFoundPage("post") };
  // Only posts have a page here. A row of any other kind (a legacy
  // workflow entry) is not part of the feed and gets no permalink.
  if (row.kind !== "quick" && row.kind !== "article") return { status: 404, html: notFoundPage("post") };
  const liked = viewer ? (await likedFeedIds(viewer.id, [row.id])).has(row.id) : false;
  const reposted = viewer ? (await repostedFeedIds(viewer.id, [row.id])).has(row.id) : false;
  const p = publicFeedPost(row, liked, reposted);
  const c = p.creator;
  const own = Boolean(viewer && viewer.id === c.id);
  const head = `<div class="fx-head"><a class="fx-name" href="/creators/${esc(c.handle)}">${esc(c.displayName)}</a><span class="fx-sub">@${esc(c.handle)}</span><span class="fx-sub">&middot;</span><span class="fx-time">${esc(dateLabel(p.createdAt))}</span></div>`;
  const actions = feedActionBar(p, { own, onPostPage: true, delLabel: "Delete this post" });
  const comments = await listFeedComments(row.id);
  const signedIn = Boolean(viewer && viewer.status === "active");
  const commentBox = signedIn ? `
          <form class="fx-comment-form" id="feed-comment-form" data-feed-comment-form="${esc(p.id)}">
            <a class="fx-avawrap" href="/creators/${esc(viewer.handle)}">${feedAvatarHtml(viewer)}</a>
            <div class="fx-comment-main">
              <textarea id="feed-comment-body" rows="1" maxlength="500" placeholder="Post your reply" aria-label="Post your reply"></textarea>
              <div class="fx-comment-actions">
                <span class="rate-status" id="feed-comment-status" aria-live="polite"></span>
                <button class="fx-post-btn" type="submit" id="feed-comment-post">Reply</button>
              </div>
            </div>
          </form>` : "";
  const commentsHtml = `
          <div class="fx-comments">${commentBox}
          ${comments.map((cm) => feedCommentHtml(cm, viewer, p)).join("")}
          </div>`;
  let title, description, main, jsonld = null;
  if (p.kind === "article") {
    // Articles read like a Substack post: a wide reading column with the
    // title up top, the byline with date and reading time, the action bar,
    // then the body in a serif at reading size. Replies and the author
    // card follow in the timeline column below.
    title = `${p.title} | Built with Muse`;
    description = feedExcerpt(p.body, 160);
    const body = `
        <div class="fa-read">
          <div class="fa-back"><a href="/feed?tab=articles">All articles</a></div>
          <article class="fa-article">
            <h1 class="fa-title">${esc(p.title)}</h1>
            <div class="fa-byline">
              <a class="fx-avawrap" href="/creators/${esc(c.handle)}">${feedAvatarHtml(c, 44)}</a>
              <div class="fa-byline-main">
                <a class="fa-author" href="/creators/${esc(c.handle)}">${esc(c.displayName)}</a>
                <span class="fa-meta">${esc(dateLabel(p.createdAt))} &middot; ${readMinutes(p.body)} min read</span>
              </div>
            </div>
            ${actions}
            <div class="fa-body">${paragraphsHtml(p.body)}</div>
          </article>
        </div>
        <div class="fx-col fa-replies">
          <h2 class="fa-replies-title">Replies${p.commentCount ? ` <span>${p.commentCount}</span>` : ""}</h2>
          ${signedIn ? "" : `<div class="fx-signin"><a class="quiet-link" href="/creator">Sign in to reply</a></div>`}
          ${commentsHtml}
          ${feedAuthorCard(p)}
        </div>`;
    jsonld = { "@context": "https://schema.org", "@type": "Article", headline: p.title, description, url: SITE + "/feed/" + p.id, datePublished: p.createdAt, author: { "@type": c.editorial ? "Organization" : "Person", name: c.displayName, url: SITE + "/creators/" + c.handle } };
    return { status: 200, html: layout({ title, description, path: "/feed/" + p.id, ogType: "article", current: "/feed", body, script: SESSION_JS + ACCOUNT_JS + FEED_JS + FEED_COMMENT_JS, extraCss: FEED_CSS, jsonld }) };
  } else {
    title = `${feedExcerpt(p.body, 60)} | Built with Muse`;
    description = feedExcerpt(p.body, 160);
    main = `
          <div class="fx-post-main">
            <a class="fx-avawrap" href="/creators/${esc(c.handle)}">${feedAvatarHtml(c)}</a>
            <div class="fx-main">
              ${head}
              <div class="fx-text">${paragraphsHtml(p.body)}</div>
            </div>
          </div>
          ${actions}`;
  }
  const body = `
        <div class="fx-col">
          <article class="fx-post">${main}
          </article>
          ${commentsHtml}
          ${feedAuthorCard(p)}
        </div>`;
  return { status: 200, html: layout({ title, description, path: "/feed/" + p.id, ogType: p.kind === "article" ? "article" : "website", current: "/feed", body, script: SESSION_JS + ACCOUNT_JS + FEED_JS + FEED_COMMENT_JS, extraCss: FEED_CSS, jsonld }) };
}

async function pageFeedNew(req) {
  const viewer = req ? await creatorFromRequest(req).catch(() => null) : null;
  const title = "Write an article | Built with Muse";
  const description = "Write an article";
  if (!viewer || viewer.status !== "active") {
    return { status: 200, html: layout({
      title, description, path: "/feed/new", current: "/feed", noindex: true, extraCss: FEED_CSS, script: SESSION_JS + ACCOUNT_JS,
      body: `
        <div class="fa-read">
          <div class="fa-back"><a href="/feed">Back to the feed</a></div>
          <div class="fa-guest">
            <h1 class="fa-title">Write an article</h1>
            <p class="fa-dek">Long reads sit in the feed next to quick posts. Sign in to start one.</p>
            <a class="cta" href="/creator">Sign in with Google</a>
          </div>
        </div>`,
    }) };
  }
  // A Substack style editor: no boxes or labels, a large title line and
  // the body under it, with Publish in a thin bar on top.
  return { status: 200, html: layout({
    title, description, path: "/feed/new", current: "/feed", noindex: true, extraCss: FEED_CSS, script: SESSION_JS + ACCOUNT_JS + FEED_ARTICLE_JS,
    body: `
        <div class="fa-read">
          <form id="feed-article-form" class="fa-editor" novalidate>
            <div class="fa-ed-bar">
              <a class="quiet-link" href="/feed">Back to the feed</a>
              <span class="fa-ed-count" id="fa-count">0 words</span>
              <span class="rate-status" id="fa-status" aria-live="polite"></span>
              <button class="fx-post-btn" type="submit" id="fa-publish">Publish</button>
            </div>
            <div class="fa-byline">
              ${feedAvatarHtml(viewer, 36)}
              <div class="fa-byline-main"><span class="fa-author">${esc(viewer.display_name || viewer.displayName || viewer.handle)}</span></div>
            </div>
            <textarea id="fa-title" class="fa-ed-title" name="title" rows="1" maxlength="120" placeholder="Title" aria-label="Title" autocomplete="off"></textarea>
            <textarea id="fa-body" class="fa-ed-body" name="body" placeholder="Start writing. A blank line starts a new paragraph." aria-label="Article"></textarea>
          </form>
        </div>`,
  }) };
}

// ---------------------------------------------------------------------------
// The request handler. Returns true when it handled the request.
async function handle(req, res, url, ctx) {
  const { reply, ip, ua, body: readBody } = ctx;
  // Deterministic schema readiness: never run a query before the creator
  // tables (and the referral foreign keys) exist.
  if (schemaReady) await schemaReady;
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "v1", ...]
  const deviceId = deps.deviceFromCookie(req);
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  // Same origin check for every write: a cross site form cannot set this header.
  if (mutating && req.headers["x-requested-with"] !== "fetch") return reply(403, { ok: false, error: "forbidden" });

  // ----- pages -----
  if (parts[1] === "pages") {
    const html = async (out) => { res.writeHead(out.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(out.html); };
    if (parts[2] === "workflows" && parts.length === 3) return html({ status: 200, html: await pageIndex(url, req) });
    if (parts[2] === "workflows" && parts.length === 4) return html(await pageWorkflow(decodeURIComponent(parts[3]).toLowerCase(), req));
    if (parts[2] === "creators" && parts.length === 3) return html(await pageLeaderboard());
    if (parts[2] === "creators" && parts.length === 4) return html(await pageCreator(decodeURIComponent(parts[3]), req));
    if (parts[2] === "creator" && parts.length === 3) return html({ status: 200, html: dashboardPage() });
    if (parts[2] === "submit" && parts.length === 3) return html({ status: 200, html: submitPage(url.searchParams.get("type") === "artifact") });
    if (parts[2] === "artifacts" && parts.length === 3) return html(await pageArtifacts(url, req));
    if (parts[2] === "feed" && parts.length === 3) return html({ status: 200, html: await pageFeed(url, req) });
    if (parts[2] === "feed" && parts[3] === "new" && parts.length === 4) return html(await pageFeedNew(req));
    if (parts[2] === "feed" && parts.length === 4) return html(await pageFeedPost(decodeURIComponent(parts[3]), req));
    if (parts[2] === "share" && parts.length === 3) return html({ status: 200, html: shareCardPage() });
    if (parts[2] === "posts" && parts.length === 3) {
      const { rows } = await listWorkflows({ sort: "trending", page: 1, limit: 6, kind: "workflow" });
      const community = (await approvedCommunityPosts()).map(communityToWildItem);
      wild.setCommunityItems(community);
      const postViewer = await creatorFromRequest(req).catch(() => null);
      const postSaved = await savedWorkflowIds(postViewer, deviceId);
      const postOpts = { q: (url.searchParams.get("q") || "").slice(0, 80), type: (url.searchParams.get("type") || "").replace(/[^a-z]/g, ""), page: Number(url.searchParams.get("page")) || 1 };
      return html({ status: 200, html: await wild.pageHub(rows.length ? `<div class="rows">${rows.map((r) => rowHtml(r, postSaved)).join("")}</div>` : "", community, postOpts) });
    }
    if (parts[2] === "posts" && parts.length === 4) {
      const id = decodeURIComponent(parts[3]).toLowerCase();
      const ours = wild.WILD_TO_OURS[id];
      const { rows } = ours ? await listWorkflows({ sort: "trending", page: 1, limit: 4, category: ours, kind: "workflow" }) : { rows: [] };
      const catViewer = await creatorFromRequest(req).catch(() => null);
      const catSaved = await savedWorkflowIds(catViewer, deviceId);
      const catOpts = { q: (url.searchParams.get("q") || "").slice(0, 80), type: (url.searchParams.get("type") || "").replace(/[^a-z]/g, ""), page: Number(url.searchParams.get("page")) || 1 };
      const out = await wild.pageCategory(id, rows.length ? `<div class="rows">${rows.map((r) => rowHtml(r, catSaved)).join("")}</div>` : "", catOpts);
      return html(out ? { status: 200, html: out } : { status: 404, html: notFoundPage("page") });
    }
    if (parts[2] === "sitemap") {
      const xml = await sitemapXml();
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" });
      return res.end(xml);
    }
    return html({ status: 404, html: notFoundPage("page") });
  }

  // ----- admin -----
  if (parts[1] === "admin" && parts[2] === "pool") {
    const who = deps.adminIdentity(req);
    if (!who) return reply(401, { ok: false, error: "unauthorized" });
    const actor = who.email || "token";
    if (req.method === "GET" && parts[3] === "overview") {
      const r = await pool.query(`SELECT
        (SELECT count(*) FROM workflows WHERE status = 'published') AS published,
        (SELECT count(*) FROM workflows WHERE status = 'published' AND hidden_at IS NOT NULL) AS hidden,
        (SELECT count(*) FROM workflows WHERE status = 'draft') AS drafts,
        (SELECT count(*) FROM creator_profiles WHERE status = 'active') AS creators,
        (SELECT count(*) FROM workflow_reactions) AS reactions,
        (SELECT count(*) FROM workflow_reactions WHERE created_at > now() - interval '1 day') AS reactions_24h,
        (SELECT count(*) FROM workflow_reports WHERE status = 'open') AS open_reports,
        (SELECT count(*) FROM workflow_reports WHERE created_at > now() - interval '1 day') AS reports_24h,
        (SELECT count(*) FROM workflows WHERE published_at > now() - interval '1 day') AS published_24h`);
      return reply(200, { ok: true, ...Object.fromEntries(Object.entries(r.rows[0]).map(([k, v]) => [k, Number(v)])) });
    }
    if (req.method === "GET" && parts[3] === "reports") {
      const r = await pool.query(`SELECT rp.id, rp.reason, rp.detail, rp.status, rp.created_at, left(rp.device_id, 8) AS device, w.id AS workflow_id, w.slug, w.title, w.status AS workflow_status, w.hidden_at, c.handle,
          (SELECT count(*) FROM workflow_reports x WHERE x.workflow_id = w.id AND x.status = 'open') AS open_count
        FROM workflow_reports rp JOIN workflows w ON w.id = rp.workflow_id JOIN creator_profiles c ON c.id = w.creator_id
        ORDER BY (rp.status = 'open') DESC, rp.created_at DESC LIMIT 200`);
      return reply(200, { ok: true, rows: r.rows });
    }
    if (req.method === "GET" && parts[3] === "workflows") {
      const status = ["draft", "published", "unpublished", "removed", "hidden"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "published";
      const where = status === "hidden" ? "w.status = 'published' AND w.hidden_at IS NOT NULL" : "w.status = $1";
      const r = await pool.query(`SELECT w.id, w.slug, w.title, w.status, w.hidden_at, w.published_at, w.updated_at, w.exclude_from_reputation, c.handle, c.status AS creator_status, (SELECT count(*) FROM workflow_reactions x WHERE x.workflow_id = w.id)::int AS reaction_count, (SELECT count(*) FROM workflow_reports x WHERE x.workflow_id = w.id AND x.status = 'open')::int AS open_reports
        FROM workflows w JOIN creator_profiles c ON c.id = w.creator_id LEFT JOIN workflow_stats s ON s.workflow_id = w.id WHERE ${where} ORDER BY w.updated_at DESC LIMIT 300`, status === "hidden" ? [] : [status]);
      return reply(200, { ok: true, rows: r.rows });
    }
    if (req.method === "GET" && parts[3] === "creators") {
      const r = await pool.query(`SELECT c.id, c.handle, c.display_name, c.email, c.status, c.is_editorial, c.created_at, s.workflow_count,
          (SELECT count(*) FROM workflow_reactions r JOIN workflows w ON w.id = r.workflow_id WHERE w.creator_id = c.id)::int AS useful,
          (SELECT count(*) FROM creator_follows f WHERE f.followed_id = c.id)::int AS followers
        FROM creator_profiles c LEFT JOIN creator_stats s ON s.creator_id = c.id ORDER BY c.created_at DESC LIMIT 2000`);
      return reply(200, { ok: true, rows: r.rows });
    }
    if (req.method === "POST" && parts[3] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[4] || "")) {
      const body = await readBody();
      const id = parts[4];
      if (parts[5] === "hide") { await pool.query("UPDATE workflows SET hidden_at = coalesce(hidden_at, now()) WHERE id = $1", [id]); await event("admin_hide", { workflowId: id, actor }); return reply(200, { ok: true }); }
      if (parts[5] === "restore") { await pool.query("UPDATE workflows SET hidden_at = NULL, status = CASE WHEN status = 'removed' THEN 'published' ELSE status END, removed_reason = NULL, exclude_from_reputation = false WHERE id = $1", [id]); await pool.query("UPDATE workflow_reports SET status = 'dismissed' WHERE workflow_id = $1 AND status = 'open'", [id]); await event("admin_restore", { workflowId: id, actor }); return reply(200, { ok: true }); }
      if (parts[5] === "remove") {
        const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
        if (!reason) return reply(400, { ok: false, error: "reason_required" });
        await pool.query("UPDATE workflows SET status = 'removed', removed_reason = $2, exclude_from_reputation = $3, updated_at = now() WHERE id = $1", [id, reason, Boolean(body.excludeFromReputation)]);
        await pool.query("UPDATE workflow_reports SET status = 'resolved' WHERE workflow_id = $1 AND status = 'open'", [id]);
        await event("admin_remove", { workflowId: id, actor, detail: { reason, exclude: Boolean(body.excludeFromReputation) } });
        return reply(200, { ok: true });
      }
    }
    if (req.method === "POST" && parts[3] === "reports" && /^\d+$/.test(parts[4] || "") && ["resolve", "dismiss"].includes(parts[5])) {
      await pool.query("UPDATE workflow_reports SET status = $2 WHERE id = $1", [Number(parts[4]), parts[5] === "resolve" ? "resolved" : "dismissed"]);
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && parts[3] === "creators" && /^[0-9a-f-]{36}$/.test(parts[4] || "") && parts[5] === "status") {
      const body = await readBody();
      if (!["active", "deactivated", "removed"].includes(body.status)) return reply(400, { ok: false, error: "bad_status" });
      await pool.query("UPDATE creator_profiles SET status = $2, updated_at = now() WHERE id = $1", [parts[4], body.status]);
      await event("admin_creator_status", { creatorId: parts[4], actor, detail: { status: body.status } });
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && parts[3] === "feed") {
      const status = ["published", "removed"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "published";
      const r = await pool.query(`SELECT fp.id, fp.kind, fp.title, fp.body, fp.status, fp.created_at, c.handle, c.display_name,
          (SELECT count(*) FROM feed_likes fl WHERE fl.post_id = fp.id)::int AS like_count,
          (SELECT count(*) FROM feed_comments fc WHERE fc.post_id = fp.id AND fc.status = 'published')::int AS comment_count,
          (SELECT count(*) FROM feed_reposts fr WHERE fr.post_id = fp.id)::int AS repost_count
        FROM feed_posts fp JOIN creator_profiles c ON c.id = fp.creator_id WHERE fp.status = $1 ORDER BY fp.created_at DESC LIMIT 200`, [status]);
      return reply(200, { ok: true, rows: r.rows });
    }
    if (req.method === "POST" && parts[3] === "feed" && /^[0-9a-f-]{36}$/.test(parts[4] || "") && ["remove", "restore"].includes(parts[5])) {
      const to = parts[5] === "remove" ? "removed" : "published";
      await pool.query("UPDATE feed_posts SET status = $2 WHERE id = $1", [parts[4], to]);
      await event("admin_feed_" + parts[5], { actor, detail: { postId: parts[4] } });
      return reply(200, { ok: true });
    }
    return reply(404, { ok: false, error: "not_found" });
  }

  // ----- admin: community posts -----
  if (parts[1] === "admin" && parts[2] === "wild") {
    const who = deps.adminIdentity(req);
    if (!who) return reply(401, { ok: false, error: "unauthorized" });
    const actor = who.email || "token";
    if (req.method === "GET" && parts[3] === "submissions") {
      const status = ["pending", "approved", "rejected"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "pending";
      const r = await pool.query(
        `SELECT w.id, w.tweet_url, w.author_name, w.author_handle, w.text, w.likes, w.replies, w.status, w.created_at, w.reviewed_at,
                w.video_url, c.handle AS creator_handle, c.display_name AS creator_display
         FROM wild_community_posts w JOIN creator_profiles c ON c.id = w.creator_id
         WHERE w.status = $1 ORDER BY w.created_at DESC LIMIT 200`, [status]);
      const counts = await pool.query("SELECT status, count(*)::int AS n FROM wild_community_posts GROUP BY status");
      return reply(200, { ok: true, rows: r.rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])) });
    }
    if (req.method === "POST" && parts[3] === "submissions" && parts[4] && ["approve", "reject"].includes(parts[5])) {
      const to = parts[5] === "approve" ? "approved" : "rejected";
      await pool.query("UPDATE wild_community_posts SET status = $2, reviewed_at = now() WHERE id = $1", [parts[4], to]);
      await event("admin_wild_" + parts[5], { actor, detail: { id: parts[4] } });
      invalidateCommunityCache();
      return reply(200, { ok: true });
    }
    return reply(404, { ok: false, error: "not_found" });
  }

  if (parts[1] !== "v1") return false;

  // ----- public reads -----
  if (req.method === "GET" && parts[2] === "wild" && parts.length === 3) {
    const limit = Math.max(1, Math.min(12, Number(url.searchParams.get("limit")) || 3));
    const category = (url.searchParams.get("category") || "").replace(/[^a-z-]/g, "");
    // The registry is refreshed here (60s cache) so pick() interleaves the
    // latest approved community posts into the unfiltered pool.
    if (!category) wild.setCommunityItems((await approvedCommunityPosts()).map(communityToWildItem));
    const posts = wild.pick({ category, limit }).map(wild.publicItem);
    const total = wild.load().total + (category ? 0 : wild.communityCount());
    return reply(200, { ok: true, total, posts }, { "Cache-Control": "public, max-age=600" });
  }
  // A creator adds their own X post to Social. The link must be a real post
  // URL, the post must be publicly readable, and duplicates are rejected.
  // The row lands in the moderation queue as pending; nothing public yet.
  if (req.method === "POST" && parts[2] === "wild" && parts[3] === "submit" && parts.length === 4) {
    const creator = await creatorFromRequest(req);
    if (!creator) return reply(401, { ok: false, error: "signin_required" });
    const body = await readBody();
    const statusId = parseXStatusUrl(body.tweet_url);
    if (!statusId) return reply(400, { ok: false, error: "bad_url" });
    if (getSeedStatusIds().has(statusId)) return reply(409, { ok: false, error: "already_listed" });
    const dup = await pool.query("SELECT status FROM wild_community_posts WHERE id = $1", [statusId]);
    if (dup.rows.length) return reply(409, { ok: false, error: "already_listed" });
    if (await overLimit("wild_community_posts", "creator_id", creator.id, { hour: 3, day: 10 })) {
      return reply(429, { ok: false, error: "rate_limited" });
    }
    let tweet;
    try { tweet = await fetchPublicTweet(statusId); }
    catch (_) { return reply(400, { ok: false, error: "fetch_failed" }); }
    if (!tweet.text) return reply(400, { ok: false, error: "empty_post" });
    if (getSeedStatusIds().has(tweet.id)) return reply(409, { ok: false, error: "already_listed" });
    await pool.query(
      `INSERT INTO wild_community_posts (id, tweet_url, creator_id, author_name, author_handle, author_avatar, verified, text, posted_at, photos, video_url, video_poster, likes, replies)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO NOTHING`,
      [tweet.id, body.tweet_url.trim().slice(0, 300), creator.id, tweet.name, tweet.handle, tweet.avatar, tweet.verified, tweet.text.slice(0, 2000), tweet.postedAt, tweet.photos, tweet.videoUrl, tweet.videoPoster, tweet.likes, tweet.replies]
    );
    await event("wild_submit", { creatorId: creator.id, detail: { status_id: tweet.id } });
    return reply(200, { ok: true, status: "pending" });
  }
  if (req.method === "GET" && parts[2] === "categories") {
    const r = await pool.query("SELECT slug, name FROM categories WHERE active ORDER BY position");
    return reply(200, { ok: true, categories: r.rows }, { "Cache-Control": "public, max-age=300" });
  }
  if (req.method === "GET" && parts[2] === "workflows" && parts.length === 3) {
    const wanted = url.searchParams.get("sort");
    const sort = ["trending", "top", "most", "new", "following"].includes(wanted) ? wanted : "trending";
    const category = (url.searchParams.get("category") || "").replace(/[^a-z-]/g, "").slice(0, 40);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
    const page = Math.max(1, Math.min(200, Number(url.searchParams.get("page")) || 1));
    const limit = Math.max(1, Math.min(48, Number(url.searchParams.get("limit")) || PAGE_SIZE));
    const viewer = sort === "following" ? await creatorFromRequest(req) : null;
    if (sort === "following" && !viewer) return reply(401, { ok: false, error: "sign_in_required" });
    const kind = ["workflow", "artifact"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "";
    const { rows, hasMore, total } = await listWorkflows({ sort: sort === "following" ? "new" : sort, category, q, page, limit, followerId: viewer ? viewer.id : null, kind });
    return reply(200, { ok: true, total, page, hasMore, workflows: rows.map(publicWorkflow) }, { "Cache-Control": sort === "following" ? "no-store" : "public, max-age=30" });
  }
  // Title of a Muse share page, so the dashboard can prefill a workflow from
  // the link a creator pastes. Only muse.ai is ever fetched.
  if (req.method === "GET" && parts[2] === "muse-preview" && parts.length === 3) {
    const errors = [];
    const target = validMuseUrl(url.searchParams.get("url") || "", errors);
    if (!target) return reply(400, { ok: false, error: "muse_url_invalid" });
    try {
      const resp = await fetch(target, { headers: { "user-agent": "Mozilla/5.0 (compatible; BuiltWithMuse/1.0)" }, signal: AbortSignal.timeout(6000), redirect: "follow" });
      const html_ = (await resp.text()).slice(0, 200000);
      const pick = (re) => { const m = html_.match(re); return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : ""; };
      const title = pick(/<meta property="og:title" content="([^"]*)"/i) || pick(/<title>([^<]*)<\/title>/i);
      const image = pick(/<meta property="og:image" content="([^"]*)"/i);
      return reply(200, { ok: true, url: target, title: title.slice(0, 70), image: /^https:\/\/muse\.ai\//.test(image) ? image : null }, { "Cache-Control": "public, max-age=600" });
    } catch (_) {
      return reply(200, { ok: true, url: target, title: "", image: null });
    }
  }
  if (req.method === "GET" && parts[2] === "workflows" && parts.length === 4) {
    const row = await workflowBySlug(decodeURIComponent(parts[3]).toLowerCase());
    if (!row || row.status !== "published" || row.hidden_at || row.creator_status === "removed") return reply(404, { ok: false, error: "not_found" });
    const parts_ = await loadParts(row.id);
    return reply(200, { ok: true, workflow: { ...publicWorkflow(row), problem: row.problem, result: row.result, prompt: row.prompt, proofUrl: row.proof_url, ...parts_ } }, { "Cache-Control": "public, max-age=30" });
  }
  if (req.method === "GET" && parts[2] === "creators" && parts.length === 3) {
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 4));
    return reply(200, { ok: true, creators: await creatorsToFollow(limit) }, { "Cache-Control": "public, max-age=60" });
  }
  if (req.method === "GET" && parts[2] === "creators" && parts.length === 4) {
    const row = await creatorByHandle(decodeURIComponent(parts[3]));
    if (!row || row.status === "removed") return reply(404, { ok: false, error: "not_found" });
    const c = publicCreator(row);
    const { rows } = row.status === "active" ? await listWorkflows({ handle: c.handle, page: 1 }) : { rows: [] };
    return reply(200, { ok: true, creator: c, workflows: rows.map(publicWorkflow) }, { "Cache-Control": "public, max-age=30" });
  }

  // ----- auth -----
  if (parts[2] === "auth") {
    if (req.method === "GET" && parts[3] === "config") {
      return reply(200, { ok: true, clientId: deps.GOOGLE_CLIENT_ID, submissionsOpen: (await setting("submissions_open", "true")) === "true" });
    }
    if (req.method === "POST" && parts[3] === "google") {
      if (await overLimit("submissions", "ip_hash", ip, RATE.login.ip)) return reply(429, { ok: false, error: "rate_limited" });
      await pool.query("INSERT INTO submissions (kind, ip_hash) VALUES ('creator_login', $1)", [ip]);
      const body = await readBody();
      let payload;
      try {
        payload = await deps.verifyGoogleIdToken(body.credential);
      } catch (err) {
        return reply(401, { ok: false, error: "bad_token" });
      }
      const email = String(payload.email).toLowerCase();
      const existing = await pool.query("SELECT * FROM creator_profiles WHERE lower(email) = $1", [email]);
      const profile = existing.rows[0];
      if (profile) {
        if (profile.status === "removed") return reply(403, { ok: false, error: "account_removed" });
        if (profile.status === "deactivated") return reply(403, { ok: false, error: "account_deactivated" });
        await pool.query("UPDATE creator_profiles SET google_sub = coalesce(google_sub, $2), last_seen_at = now() WHERE id = $1", [profile.id, String(payload.sub || "")]);
        await rememberDevice(profile.id, deviceId);
        await event("login", { creatorId: profile.id, deviceId });
        return reply(200, { ok: true, signedIn: true, handle: profile.handle, needsHandle: !profile.handle_claimed }, { "Set-Cookie": cookie(req, CREATOR_COOKIE, signBody("creator", { cid: profile.id }, SESSION_SECONDS), SESSION_SECONDS) });
      }
      const open = (await setting("submissions_open", "true")) === "true";
      if (!open) return reply(403, { ok: false, error: "submissions_closed" });
      // First Google sign in: create the minimal profile immediately, with an
      // auto handle the owner can replace later. Code claimers get an account
      // without ever seeing creator onboarding.
      const autoName = String(payload.name || "").slice(0, 60).trim() || "Muse member";
      const autoPicture = typeof payload.picture === "string" && /^https:\/\//.test(payload.picture) ? payload.picture.slice(0, 500) : null;
      let autoHandle = "";
      for (let i = 0; i < 5 && !autoHandle; i++) {
        const candidate = "user_" + crypto.randomBytes(4).toString("hex");
        const taken = await pool.query("SELECT 1 FROM creator_profiles WHERE lower(handle) = lower($1)", [candidate]);
        if (!taken.rows[0]) autoHandle = candidate;
      }
      if (!autoHandle) return reply(500, { ok: false, error: "server_error" });
      const created = await pool.query(
        `INSERT INTO creator_profiles (email, google_sub, handle, display_name, avatar_url, handle_claimed, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, false, now())
         ON CONFLICT (lower(email)) DO NOTHING RETURNING id, handle`,
        [email, String(payload.sub || "") || null, autoHandle, autoName, autoPicture]
      );
      if (!created.rows[0]) {
        // A concurrent sign in won the race; sign in against the winner.
        const again = await pool.query("SELECT * FROM creator_profiles WHERE lower(email) = $1", [email]);
        const winner = again.rows[0];
        if (!winner) return reply(500, { ok: false, error: "server_error" });
        if (winner.status === "removed") return reply(403, { ok: false, error: "account_removed" });
        if (winner.status === "deactivated") return reply(403, { ok: false, error: "account_deactivated" });
        await pool.query("UPDATE creator_profiles SET google_sub = coalesce(google_sub, $2), last_seen_at = now() WHERE id = $1", [winner.id, String(payload.sub || "")]);
        await rememberDevice(winner.id, deviceId);
        await event("login", { creatorId: winner.id, deviceId });
        return reply(200, { ok: true, signedIn: true, handle: winner.handle, needsHandle: !winner.handle_claimed }, { "Set-Cookie": cookie(req, CREATOR_COOKIE, signBody("creator", { cid: winner.id }, SESSION_SECONDS), SESSION_SECONDS) });
      }
      await rememberDevice(created.rows[0].id, deviceId);
      await event("signup", { creatorId: created.rows[0].id, deviceId });
      return reply(200, { ok: true, signedIn: true, handle: created.rows[0].handle, needsHandle: true }, { "Set-Cookie": cookie(req, CREATOR_COOKIE, signBody("creator", { cid: created.rows[0].id }, SESSION_SECONDS), SESSION_SECONDS) });
    }
    if (req.method === "POST" && parts[3] === "logout") {
      return reply(200, { ok: true }, { "Set-Cookie": [clearCookie(req, CREATOR_COOKIE), clearCookie(req, SIGNUP_COOKIE)] });
    }
    return reply(404, { ok: false, error: "not_found" });
  }

  // ----- profile creation from the signup cookie -----
  if (req.method === "POST" && parts[2] === "me" && parts[3] === "profile" && parts.length === 4 && !(await creatorFromRequest(req))) {
    const signup = readSigned("signup", deps.parseCookies(req)[SIGNUP_COOKIE]);
    if (!signup || !signup.email) return reply(401, { ok: false, error: "sign_in_first" });
    const body = await readBody();
    const errors = [];
    const handle = typeof body.handle === "string" ? body.handle.trim() : "";
    if (!HANDLE_RE.test(handle)) errors.push("handle_invalid");
    else if (RESERVED_HANDLES.has(handle.toLowerCase())) errors.push("handle_reserved");
    const displayName = text(body.displayName, LIMITS.displayName, "display_name", errors);
    const bio = text(body.bio, LIMITS.bio, "bio", errors, { required: false });
    const website = validUrl(body.websiteUrl, "website", errors);
    if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
    const taken = await pool.query("SELECT 1 FROM creator_profiles WHERE lower(handle) = lower($1)", [handle]);
    if (taken.rows[0]) return reply(409, { ok: false, error: "handle_taken" });
    const r = await pool.query(
      `INSERT INTO creator_profiles (email, google_sub, handle, display_name, bio, avatar_url, website_url, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (lower(email)) DO NOTHING RETURNING id, handle`,
      [signup.email, signup.sub || null, handle, displayName, bio, body.useGoogleAvatar === false ? null : signup.picture || null, website]
    );
    if (!r.rows[0]) return reply(409, { ok: false, error: "email_taken" });
    await rememberDevice(r.rows[0].id, deviceId);
    await event("signup", { creatorId: r.rows[0].id, deviceId });
    return reply(200, { ok: true, handle: r.rows[0].handle }, { "Set-Cookie": [cookie(req, CREATOR_COOKIE, signBody("creator", { cid: r.rows[0].id }, SESSION_SECONDS), SESSION_SECONDS), clearCookie(req, SIGNUP_COOKIE)] });
  }

  // ----- device writes: ratings and reports -----
  // One tap reactions, per device, no account. Tapping again removes it.
  if (req.method === "POST" && parts[2] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "react" && parts.length === 5) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    if (!deviceId) return reply(403, { ok: false, error: "no_device" });
    const row = await workflowById(parts[3]);
    if (!row || row.status !== "published" || row.creator_status === "removed") return reply(404, { ok: false, error: "not_published" });
    const body = await readBody();
    const kind = REACTION_KINDS.find(([k]) => k === body.kind) ? body.kind : null;
    if (!kind) return reply(400, { ok: false, error: "bad_kind" });
    const creator = await creatorFromRequest(req);
    if (creator) await rememberDevice(creator.id, deviceId);
    if ((creator && creator.id === row.creator_id) || (await isOwnerDevice(row.creator_id, deviceId))) return reply(403, { ok: false, error: "own_work" });
    if (await overLimit("workflow_reactions", "device_id", deviceId, RATE_REACT.device)) return reply(429, { ok: false, error: "rate_limited" });
    const removed = await pool.query("DELETE FROM workflow_reactions WHERE workflow_id = $1 AND device_id = $2 AND kind = $3 RETURNING kind", [row.id, deviceId, kind]);
    if (!removed.rows[0]) await pool.query("INSERT INTO workflow_reactions (workflow_id, device_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [row.id, deviceId, kind]);
    await event(removed.rows[0] ? "react_remove" : "react", { workflowId: row.id, deviceId, creatorId: creator ? creator.id : null, detail: { kind } });
    const rows = (await pool.query("SELECT kind, count(*)::int AS n, bool_or(device_id = $2) AS mine FROM workflow_reactions WHERE workflow_id = $1 GROUP BY kind", [row.id, deviceId])).rows;
    return reply(200, { ok: true, reactions: REACTION_KINDS.map(([k]) => { const f = rows.find((x) => x.kind === k); return { kind: k, n: f ? f.n : 0, mine: f ? Boolean(f.mine) : false }; }) });
  }
  if (parts[2] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && (parts[4] === "rating" || parts[4] === "report")) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    if (!deviceId) return reply(403, { ok: false, error: "no_device" });
    const row = await workflowById(parts[3]);
    if (!row || row.status !== "published" || row.creator_status === "removed") return reply(404, { ok: false, error: "not_published" });
    const creator = await creatorFromRequest(req);
    if (creator) await rememberDevice(creator.id, deviceId);
    const own = (creator && creator.id === row.creator_id) || (await isOwnerDevice(row.creator_id, deviceId));
    if (parts[4] === "rating") {
      if (own) return reply(403, { ok: false, error: "own_work" });
      if (req.method === "PUT") {
        const body = await readBody();
        const score = Number(body.score);
        if (!Number.isInteger(score) || score < 1 || score > 5) return reply(400, { ok: false, error: "bad_score" });
        if (await overLimit("workflow_ratings", "device_id", deviceId, RATE.rating.device)) return reply(429, { ok: false, error: "rate_limited" });
        if (await overLimit("workflow_ratings", "ip_hash", ip, RATE.rating.ip)) return reply(429, { ok: false, error: "rate_limited" });
        const r = await pool.query(
          `INSERT INTO workflow_ratings (workflow_id, device_id, rater_creator_id, score, ip_hash) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workflow_id, device_id) DO UPDATE SET score = EXCLUDED.score, rater_creator_id = coalesce(EXCLUDED.rater_creator_id, workflow_ratings.rater_creator_id), updated_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [row.id, deviceId, creator ? creator.id : null, score, ip]
        );
        await event(r.rows[0].inserted ? "rating_create" : "rating_update", { workflowId: row.id, deviceId, creatorId: creator ? creator.id : null, detail: { score } });
        return reply(200, { ok: true, yourRating: score, ...(await stats(row.id)) });
      }
      if (req.method === "DELETE") {
        const r = await pool.query("DELETE FROM workflow_ratings WHERE workflow_id = $1 AND device_id = $2 RETURNING id", [row.id, deviceId]);
        if (r.rows[0]) await event("rating_delete", { workflowId: row.id, deviceId });
        return reply(200, { ok: true, yourRating: null, ...(await stats(row.id)) });
      }
      if (req.method === "GET") {
        const r = await pool.query("SELECT score FROM workflow_ratings WHERE workflow_id = $1 AND device_id = $2", [row.id, deviceId]);
        return reply(200, { ok: true, yourRating: r.rows[0] ? r.rows[0].score : null, ownWork: own, ...(await stats(row.id)) });
      }
      return reply(405, { ok: false, error: "method" });
    }
    if (req.method === "POST") {
      const body = await readBody();
      const reason = REPORT_REASONS.includes(body.reason) ? body.reason : null;
      if (!reason) return reply(400, { ok: false, error: "bad_reason" });
      const detail = typeof body.detail === "string" ? body.detail.replace(DASH_RE, "-").trim().slice(0, LIMITS.detail[1]) : null;
      if (await overLimit("workflow_reports", "device_id", deviceId, RATE.report.device)) return reply(429, { ok: false, error: "rate_limited" });
      if (await overLimit("workflow_reports", "ip_hash", ip, RATE.report.ip)) return reply(429, { ok: false, error: "rate_limited" });
      const r = await pool.query( 
        "INSERT INTO workflow_reports (workflow_id, device_id, reporter_creator_id, reason, detail, ip_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (workflow_id, device_id) DO NOTHING RETURNING id",
        [row.id, deviceId, creator ? creator.id : null, reason, detail || null, ip]
      );
      if (!r.rows[0]) return reply(200, { ok: true, duplicate: true });
      await event("report", { workflowId: row.id, deviceId, creatorId: creator ? creator.id : null, detail: { reason } });
      // Automatic hide only past a clear burst from distinct devices.
      const threshold = Number(await setting("report_hide_threshold", "3")) || 3;
      const distinct = await pool.query("SELECT count(DISTINCT device_id) AS n FROM workflow_reports WHERE workflow_id = $1 AND status = 'open'", [row.id]);
      if (Number(distinct.rows[0].n) >= threshold && !row.hidden_at) {
        await pool.query("UPDATE workflows SET hidden_at = now() WHERE id = $1", [row.id]);
        await event("auto_hide", { workflowId: row.id, detail: { reports: Number(distinct.rows[0].n) } });
      }
      return reply(200, { ok: true });
    }
    return reply(405, { ok: false, error: "method" });
  }

  // ----- comments: reading and reporting are device level, writing needs a creator below -----
  if (req.method === "GET" && parts[2] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "comments" && parts.length === 5) {
    const row = await workflowById(parts[3]);
    if (!row || row.status !== "published" || row.creator_status === "removed") return reply(404, { ok: false, error: "not_published" });
    if (req.method !== "GET") return reply(405, { ok: false, error: "method" });
    return reply(200, { ok: true, comments: await listComments(row.id, null) });
  }
  if (req.method === "POST" && parts[2] === "comments" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "report" && parts.length === 5) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    if (!deviceId) return reply(403, { ok: false, error: "no_device" });
    const c = await pool.query("SELECT wc.id, w.status AS wstatus FROM workflow_comments wc JOIN workflows w ON w.id = wc.workflow_id WHERE wc.id = $1 AND wc.hidden_at IS NULL", [parts[3]]);
    if (!c.rows[0] || c.rows[0].wstatus !== "published") return reply(404, { ok: false, error: "not_found" });
    const body = await readBody();
    const reason = REPORT_REASONS.includes(body.reason) ? body.reason : null;
    if (!reason) return reply(400, { ok: false, error: "bad_reason" });
    if (await overLimit("comment_reports", "device_id", deviceId, RATE.report.device)) return reply(429, { ok: false, error: "rate_limited" });
    const r = await pool.query("INSERT INTO comment_reports (comment_id, device_id, reason) VALUES ($1, $2, $3) ON CONFLICT (comment_id, device_id) DO NOTHING RETURNING id", [parts[3], deviceId, reason]);
    if (!r.rows[0]) return reply(200, { ok: true, duplicate: true });
    await event("comment_report", { creatorId: null, deviceId, detail: { comment: parts[3], reason } });
    const distinct = await pool.query("SELECT count(DISTINCT device_id) AS n FROM comment_reports WHERE comment_id = $1", [parts[3]]);
    if (Number(distinct.rows[0].n) >= 3) {
      await pool.query("UPDATE workflow_comments SET hidden_at = now() WHERE id = $1 AND hidden_at IS NULL", [parts[3]]);
      await event("comment_auto_hide", { deviceId, detail: { comment: parts[3], reports: Number(distinct.rows[0].n) } });
    }
    return reply(200, { ok: true });
  }

  // ----- everything below needs a creator session -----
  const creator = await creatorFromRequest(req);
  if (!creator) return reply(401, { ok: false, error: "sign_in_required" });

  // ----- saves: one account, every device -----
  if (req.method === "POST" && parts[2] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "save") {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    const row = await workflowById(parts[3]);
    if (!row || row.status !== "published" || row.creator_status === "removed") return reply(404, { ok: false, error: "not_published" });
    const existing = await pool.query("SELECT 1 FROM workflow_saves WHERE workflow_id = $1 AND creator_id = $2", [row.id, creator.id]);
    let saved;
    if (existing.rows[0]) {
      await pool.query("DELETE FROM workflow_saves WHERE workflow_id = $1 AND creator_id = $2", [row.id, creator.id]);
      saved = false;
    } else {
      // Adopt the save from before they signed in so the count stays honest.
      if (deviceId) await pool.query("DELETE FROM workflow_saves WHERE workflow_id = $1 AND device_id = $2 AND creator_id IS NULL", [row.id, deviceId]);
      await pool.query("INSERT INTO workflow_saves (workflow_id, creator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [row.id, creator.id]);
      saved = true;
    }
    const n = await pool.query("SELECT count(*) AS n FROM workflow_saves WHERE workflow_id = $1", [row.id]);
    await event(saved ? "save" : "unsave", { workflowId: row.id, creatorId: creator.id, deviceId });
    return reply(200, { ok: true, saved, saves: Number(n.rows[0].n) });
  }
  // ----- follows: one account follows another creator -----
  if (parts[2] === "creators" && parts[3] && parts[4] === "follow" && parts.length === 5) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    const target = await creatorByHandle(decodeURIComponent(parts[3]).toLowerCase());
    if (!target || target.status !== "active") return reply(404, { ok: false, error: "not_found" });
    if (target.id === creator.id) return reply(400, { ok: false, error: "own_profile" });
    if (target.is_editorial) return reply(400, { ok: false, error: "editorial" });
    if (req.method === "POST") {
      await pool.query("INSERT INTO creator_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [creator.id, target.id]);
    } else if (req.method === "DELETE") {
      await pool.query("DELETE FROM creator_follows WHERE follower_id = $1 AND followed_id = $2", [creator.id, target.id]);
    } else {
      return reply(405, { ok: false, error: "method_not_allowed" });
    }
    const mine = await pool.query("SELECT 1 FROM creator_follows WHERE follower_id = $1 AND followed_id = $2", [creator.id, target.id]);
    const count = await pool.query("SELECT count(*) AS n FROM creator_follows WHERE followed_id = $1", [target.id]);
    return reply(200, { ok: true, following: Boolean(mine.rows[0]), followers: Number(count.rows[0].n) });
  }
  if (req.method === "GET" && parts[2] === "me" && parts[3] === "saves" && parts.length === 4) {
    const r = await pool.query(
      `SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} JOIN workflow_saves sv ON sv.workflow_id = w.id WHERE sv.creator_id = $1 AND ${DISCOVERABLE} ORDER BY sv.created_at DESC LIMIT 100`,
      [creator.id]
    );
    return reply(200, { ok: true, workflows: r.rows.map(publicWorkflow) });
  }

  // ----- my referral codes: everything the owner needs to keep a code alive -----
  if (req.method === "GET" && parts[2] === "me" && parts[3] === "codes" && parts.length === 4) {
    const r = await pool.query(
      `SELECT c.id, c.code, c.invite_link, c.source, c.owner_invites, c.last_verified_at, c.reports, c.redeemed, c.retired_at, c.created_at,
              (SELECT count(*) FROM claims cl WHERE cl.code_id = c.id) AS claimed_by,
              (SELECT count(*) FROM redemptions rd WHERE rd.code_id = c.id) AS confirmed
         FROM codes c
        WHERE c.owner_creator_id = $1
        ORDER BY c.retired_at NULLS FIRST, c.created_at DESC`,
      [creator.id]
    );
    const act = await pool.query(
      `SELECT c.code, rd.created_at AS at FROM redemptions rd JOIN codes c ON c.id = rd.code_id
        WHERE c.owner_creator_id = $1 AND rd.created_at > now() - interval '30 days'
        ORDER BY rd.created_at DESC LIMIT 5`,
      [creator.id]
    );
    return reply(200, {
      ok: true,
      activity: act.rows.map((a) => ({ code: a.code, at: a.at })),
      codes: r.rows.map((x) => ({
        id: x.id,
        code: x.code,
        inviteLink: x.invite_link,
        source: x.source,
        ownerInvites: x.owner_invites,
        verifiedDays: x.last_verified_at ? Math.floor((Date.now() - new Date(x.last_verified_at).getTime()) / 86400000) : null,
        reports: Number(x.reports || 0),
        confirmed: Number(x.confirmed || 0),
        claimedBy: Number(x.claimed_by || 0),
        retired: Boolean(x.retired_at),
      })),
    });
  }
  if (creator.status !== "active") return reply(403, { ok: false, error: "account_" + creator.status }, { "Set-Cookie": clearCookie(req, CREATOR_COOKIE) });
  await rememberDevice(creator.id, deviceId);

  // ----- comments: posting and liking need a creator session -----
  if (parts[2] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "comments" && parts.length === 5 && req.method === "POST") {
    const row = await workflowById(parts[3]);
    if (!row || row.status !== "published" || row.creator_status === "removed") return reply(404, { ok: false, error: "not_published" });
    const body = await readBody();
    const errors = [];
    const commentBody = text(body.body, [1, 500], "comment", errors);
    if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
    if (await overLimit("workflow_comments", "creator_id", creator.id, { hour: 10, day: 50 })) return reply(429, { ok: false, error: "rate_limited" });
    const r = await pool.query("INSERT INTO workflow_comments (workflow_id, creator_id, body) VALUES ($1, $2, $3) RETURNING id, created_at", [row.id, creator.id, commentBody]);
    await event("comment_create", { workflowId: row.id, creatorId: creator.id, deviceId });
    return reply(200, {
      ok: true,
      comment: { id: r.rows[0].id, body: commentBody, createdAt: r.rows[0].created_at, creator: { handle: creator.handle, displayName: creator.display_name, avatarUrl: creator.avatar_url }, likes: 0, liked: false },
    });
  }
  if (req.method === "DELETE" && parts[2] === "comments" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts.length === 4) {
    const c = await pool.query("SELECT wc.id, wc.creator_id, w.creator_id AS owner_id FROM workflow_comments wc JOIN workflows w ON w.id = wc.workflow_id WHERE wc.id = $1", [parts[3]]);
    if (!c.rows[0]) return reply(404, { ok: false, error: "not_found" });
    if (c.rows[0].creator_id !== creator.id && c.rows[0].owner_id !== creator.id) return reply(403, { ok: false, error: "forbidden" });
    await pool.query("DELETE FROM workflow_comments WHERE id = $1", [parts[3]]);
    await event("comment_delete", { creatorId: creator.id, detail: { commentId: parts[3], byOwner: c.rows[0].creator_id !== creator.id } });
    return reply(200, { ok: true });
  }
  if (req.method === "POST" && parts[2] === "comments" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "like" && parts.length === 5) {
    const c = await pool.query("SELECT wc.id, w.status AS wstatus FROM workflow_comments wc JOIN workflows w ON w.id = wc.workflow_id WHERE wc.id = $1 AND wc.hidden_at IS NULL", [parts[3]]);
    if (!c.rows[0] || c.rows[0].wstatus !== "published") return reply(404, { ok: false, error: "not_found" });
    const existing = await pool.query("SELECT 1 FROM comment_likes WHERE comment_id = $1 AND creator_id = $2", [parts[3], creator.id]);
    let liked;
    if (existing.rows[0]) {
      await pool.query("DELETE FROM comment_likes WHERE comment_id = $1 AND creator_id = $2", [parts[3], creator.id]);
      liked = false;
    } else {
      await pool.query("INSERT INTO comment_likes (comment_id, creator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [parts[3], creator.id]);
      liked = true;
    }
    const n = await pool.query("SELECT count(*) AS n FROM comment_likes WHERE comment_id = $1", [parts[3]]);
    await event(liked ? "comment_like" : "comment_unlike", { creatorId: creator.id, deviceId, detail: { comment: parts[3] } });
    return reply(200, { ok: true, liked, likes: Number(n.rows[0].n) });
  }

  // ----- creator feed: posting, liking and deleting need an active creator -----
  if (req.method === "POST" && parts[2] === "feed" && parts.length === 3) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    const body = await readBody();
    const kind = body.kind === "article" ? "article" : body.kind === "quick" ? "quick" : null;
    if (!kind) return reply(400, { ok: false, error: "bad_kind" });
    const errors = [];
    let title = null;
    let postBody;
    if (kind === "article") {
      title = text(body.title, FEED_LIMITS.articleTitle, "title", errors);
      postBody = text(body.body, FEED_LIMITS.articleBody, "body", errors);
    } else {
      postBody = text(body.body, FEED_LIMITS.quickBody, "body", errors);
    }
    if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
    if (await overLimit("feed_posts", "creator_id", creator.id, { hour: 30, day: 300 })) return reply(429, { ok: false, error: "rate_limited" });
    const r = await pool.query("INSERT INTO feed_posts (creator_id, kind, title, body) VALUES ($1, $2, $3, $4) RETURNING id", [creator.id, kind, title, postBody]);
    await event("feed_post", { creatorId: creator.id, deviceId, detail: { postId: r.rows[0].id, kind } });
    return reply(200, { ok: true, id: r.rows[0].id });
  }
  if (req.method === "POST" && parts[2] === "feed" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "like" && parts.length === 5) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    const post = await feedPostById(parts[3]);
    if (!post || post.status !== "published" || post.creator_status === "removed") return reply(404, { ok: false, error: "not_found" });
    const existing = await pool.query("SELECT 1 FROM feed_likes WHERE post_id = $1 AND creator_id = $2", [post.id, creator.id]);
    let liked;
    if (existing.rows[0]) {
      await pool.query("DELETE FROM feed_likes WHERE post_id = $1 AND creator_id = $2", [post.id, creator.id]);
      liked = false;
    } else {
      await pool.query("INSERT INTO feed_likes (post_id, creator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [post.id, creator.id]);
      liked = true;
    }
    const n = await pool.query("SELECT count(*) AS n FROM feed_likes WHERE post_id = $1", [post.id]);
    await event(liked ? "feed_like" : "feed_unlike", { creatorId: creator.id, deviceId, detail: { postId: post.id } });
    return reply(200, { ok: true, liked, likes: Number(n.rows[0].n) });
  }
  if (req.method === "POST" && parts[2] === "feed" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "repost" && parts.length === 5) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    const post = await feedPostById(parts[3]);
    if (!post || post.status !== "published" || post.creator_status === "removed" || (post.kind !== "quick" && post.kind !== "article")) return reply(404, { ok: false, error: "not_found" });
    const existing = await pool.query("SELECT 1 FROM feed_reposts WHERE post_id = $1 AND creator_id = $2", [post.id, creator.id]);
    let reposted;
    if (existing.rows[0]) {
      await pool.query("DELETE FROM feed_reposts WHERE post_id = $1 AND creator_id = $2", [post.id, creator.id]);
      reposted = false;
    } else {
      await pool.query("INSERT INTO feed_reposts (post_id, creator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [post.id, creator.id]);
      reposted = true;
    }
    const n = await pool.query("SELECT count(*) AS n FROM feed_reposts WHERE post_id = $1", [post.id]);
    await event(reposted ? "feed_repost" : "feed_unrepost", { creatorId: creator.id, deviceId, detail: { postId: post.id } });
    return reply(200, { ok: true, reposted, reposts: Number(n.rows[0].n) });
  }
  if (req.method === "POST" && parts[2] === "feed" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts[4] === "comments" && parts.length === 5) {
    if (!ua || deps.BOT_UA.test(ua)) return reply(403, { ok: false, error: "forbidden" });
    const post = await feedPostById(parts[3]);
    if (!post || post.status !== "published" || post.creator_status === "removed" || (post.kind !== "quick" && post.kind !== "article")) return reply(404, { ok: false, error: "not_found" });
    const body = await readBody();
    const errors = [];
    const commentBody = text(body.body, FEED_LIMITS.commentBody, "body", errors);
    if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
    if (await overLimit("feed_comments", "creator_id", creator.id, { hour: 60, day: 600 })) return reply(429, { ok: false, error: "rate_limited" });
    const r = await pool.query("INSERT INTO feed_comments (post_id, creator_id, body) VALUES ($1, $2, $3) RETURNING id", [post.id, creator.id, commentBody]);
    await event("feed_comment", { creatorId: creator.id, deviceId, detail: { postId: post.id, commentId: r.rows[0].id } });
    return reply(200, { ok: true, id: r.rows[0].id });
  }
  if (req.method === "DELETE" && parts[2] === "feed" && parts[3] === "comments" && /^[0-9a-f-]{36}$/.test(parts[4] || "") && parts.length === 5) {
    const c = await pool.query("SELECT fc.id, fc.creator_id, fp.creator_id AS post_creator_id FROM feed_comments fc JOIN feed_posts fp ON fp.id = fc.post_id WHERE fc.id = $1", [parts[4]]);
    if (!c.rows[0]) return reply(404, { ok: false, error: "not_found" });
    if (c.rows[0].creator_id !== creator.id && c.rows[0].post_creator_id !== creator.id) return reply(403, { ok: false, error: "forbidden" });
    await pool.query("DELETE FROM feed_comments WHERE id = $1", [parts[4]]);
    await event("feed_comment_delete", { creatorId: creator.id, deviceId, detail: { commentId: parts[4], byPostAuthor: c.rows[0].creator_id !== creator.id } });
    return reply(200, { ok: true });
  }
  if (req.method === "DELETE" && parts[2] === "feed" && /^[0-9a-f-]{36}$/.test(parts[3] || "") && parts.length === 4) {
    const post = await feedPostById(parts[3]);
    if (!post) return reply(404, { ok: false, error: "not_found" });
    if (post.creator_id !== creator.id) return reply(403, { ok: false, error: "forbidden" });
    await pool.query("DELETE FROM feed_posts WHERE id = $1", [post.id]);
    await event("feed_delete", { creatorId: creator.id, deviceId, detail: { postId: post.id, kind: post.kind } });
    return reply(200, { ok: true });
  }

  if (parts[2] === "me") {
    if (req.method === "GET" && parts.length === 3) {
      const full = await creatorByHandle(creator.handle);
      const social = (await pool.query("SELECT (SELECT count(*) FROM workflow_reactions r JOIN workflows w ON w.id = r.workflow_id WHERE w.creator_id = $1)::int AS useful, (SELECT count(*) FROM creator_follows f WHERE f.followed_id = $1)::int AS followers", [creator.id])).rows[0];
      const mine = (await pool.query(`SELECT ${WORKFLOW_SELECT} ${WORKFLOW_FROM} WHERE w.creator_id = $1 AND w.status <> 'removed' ORDER BY w.updated_at DESC`, [creator.id])).rows;
      const removed = (await pool.query("SELECT id, title, removed_reason FROM workflows WHERE creator_id = $1 AND status = 'removed'", [creator.id])).rows;
      return reply(200, { ok: true, creator: { ...publicCreator(full), useful: social.useful, followers: social.followers, email: creator.email, handleChangedAt: creator.handle_changed_at, needsHandle: !creator.handle_claimed }, workflows: mine.map((r) => ({ ...publicWorkflow(r), hidden: Boolean(r.hidden_at) })), removed, submissionsOpen: (await setting("submissions_open", "true")) === "true" });
    }
    if (req.method === "PATCH" && parts[3] === "profile") {
      const body = await readBody();
      const errors = [];
      const displayName = text(body.displayName, LIMITS.displayName, "display_name", errors);
      const bio = text(body.bio, LIMITS.bio, "bio", errors, { required: false });
      const website = validUrl(body.websiteUrl, "website", errors);
      const avatar = validAvatar(body.avatarUrl, errors);
      const xUrl = validUrl(body.xUrl, "x", errors);
      const youtubeUrl = validUrl(body.youtubeUrl, "youtube", errors);
      const instagramUrl = validUrl(body.instagramUrl, "instagram", errors);
      const tiktokUrl = validUrl(body.tiktokUrl, "tiktok", errors);
      const linkedinUrl = validUrl(body.linkedinUrl, "linkedin", errors);
      const threadsUrl = validUrl(body.threadsUrl, "threads", errors);
      // Up to three custom links, each a short label and an http(s) URL.
      const links = [];
      for (const raw of Array.isArray(body.links) ? body.links.slice(0, 3) : []) {
        const label = typeof raw.label === "string" ? raw.label.replace(DASH_RE, ":").trim().slice(0, 40) : "";
        const url_ = validUrl(raw.url, "link", errors);
        if (label && url_) links.push({ label, url: url_ });
        else if (label || (typeof raw.url === "string" && raw.url.trim())) errors.push("link_invalid");
      }
      let handle = creator.handle;
      let handleChanged = false;
      if (typeof body.handle === "string" && body.handle.trim() && body.handle.trim().toLowerCase() !== creator.handle.toLowerCase()) {
        handle = body.handle.trim();
        handleChanged = true;
        if (!HANDLE_RE.test(handle)) errors.push("handle_invalid");
        else if (RESERVED_HANDLES.has(handle.toLowerCase())) errors.push("handle_reserved");
        if (creator.handle_changed_at && Date.now() - new Date(creator.handle_changed_at).getTime() < HANDLE_COOLDOWN_DAYS * 86400000) errors.push("handle_cooldown");
      }
      if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
      if (handleChanged) {
        const taken = await pool.query("SELECT 1 FROM creator_profiles WHERE lower(handle) = lower($1) AND id <> $2", [handle, creator.id]);
        if (taken.rows[0]) return reply(409, { ok: false, error: "handle_taken" });
      }
      await pool.query(
        `UPDATE creator_profiles SET display_name = $2, bio = $3, website_url = $4, avatar_url = $5, handle = $6, handle_changed_at = CASE WHEN $7 THEN now() ELSE handle_changed_at END, handle_claimed = CASE WHEN $7 THEN true ELSE handle_claimed END, x_url = $8, youtube_url = $9, instagram_url = $10, tiktok_url = $11, linkedin_url = $12, threads_url = $13, links = $14, updated_at = now() WHERE id = $1`,
        [creator.id, displayName, bio, website, avatar === null && body.avatarUrl === "" ? null : avatar || creator.avatar_url, handle, handleChanged, xUrl, youtubeUrl, instagramUrl, tiktokUrl, linkedinUrl, threadsUrl, JSON.stringify(links)]
      );
      await event("profile_update", { creatorId: creator.id, detail: { handleChanged } });
      return reply(200, { ok: true, handle });
    }
    if (req.method === "POST" && parts[3] === "deactivate") {
      await pool.query("UPDATE creator_profiles SET status = 'deactivated', updated_at = now() WHERE id = $1", [creator.id]);
      await event("deactivate", { creatorId: creator.id });
      return reply(200, { ok: true }, { "Set-Cookie": clearCookie(req, CREATOR_COOKIE) });
    }
    if (req.method === "GET" && parts[3] === "workflows" && /^[0-9a-f-]{36}$/.test(parts[4] || "")) {
      const row = await workflowById(parts[4]);
      if (!row || row.creator_id !== creator.id) return reply(404, { ok: false, error: "not_found" });
      const value = await fullWorkflowValue(row);
      return reply(200, { ok: true, workflow: { id: row.id, slug: row.slug, status: row.status, hidden: Boolean(row.hidden_at), publishedAt: row.published_at, updatedAt: row.updated_at, ...value } });
    }
    return reply(404, { ok: false, error: "not_found" });
  }

  if (parts[2] === "workflows") {
    if (req.method === "POST" && parts.length === 3) {
      const body = await readBody();
      const count = await pool.query("SELECT count(*) AS n FROM workflows WHERE creator_id = $1 AND status <> 'removed'", [creator.id]);
      if (Number(count.rows[0].n) >= PUBLISH_CAP.drafts) return reply(429, { ok: false, error: "too_many_workflows" });
      const publish = body.publish === true;
      const { value, errors } = parseWorkflow(body, { complete: publish });
      if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
      if (publish) {
        if ((await setting("submissions_open", "true")) !== "true") return reply(403, { ok: false, error: "submissions_closed" });
        if (!(await publishAllowed(creator))) return reply(429, { ok: false, error: "publish_limit" });
      }
      const created = await createWorkflow(creator, value, { status: publish ? "published" : "draft" });
      await event(publish ? "publish" : "draft_create", { creatorId: creator.id, workflowId: created.id });
      return reply(200, { ok: true, id: created.id, slug: created.slug, status: publish ? "published" : "draft" });
    }
    if (/^[0-9a-f-]{36}$/.test(parts[3] || "")) {
      const row = await workflowById(parts[3]);
      if (!row || row.creator_id !== creator.id) return reply(404, { ok: false, error: "not_found" });
      if (row.status === "removed") return reply(403, { ok: false, error: "removed" });
      if (req.method === "PATCH" && parts.length === 4) {
        const body = await readBody();
        const { value, errors } = parseWorkflow({ ...body, kind: row.kind || "workflow" }, { complete: row.status === "published" });
        if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
        const slug = await updateWorkflow(row, value, creator.id);
        await event("edit", { creatorId: creator.id, workflowId: row.id });
        return reply(200, { ok: true, slug });
      }
      if (req.method === "POST" && parts[4] === "publish") {
        if ((await setting("submissions_open", "true")) !== "true") return reply(403, { ok: false, error: "submissions_closed" });
        const { errors } = parseWorkflow(await fullWorkflowValue(row), { complete: true });
        if (errors.length) return reply(400, { ok: false, error: "invalid", errors });
        if (row.status !== "published" && !(await publishAllowed(creator))) return reply(429, { ok: false, error: "publish_limit" });
        await pool.query("UPDATE workflows SET status = 'published', published_at = coalesce(published_at, now()), updated_at = now() WHERE id = $1", [row.id]);
        await event("publish", { creatorId: creator.id, workflowId: row.id });
        return reply(200, { ok: true, slug: row.slug });
      }
      if (req.method === "POST" && parts[4] === "unpublish") {
        await pool.query("UPDATE workflows SET status = 'unpublished', updated_at = now() WHERE id = $1 AND status = 'published'", [row.id]);
        await event("unpublish", { creatorId: creator.id, workflowId: row.id });
        return reply(200, { ok: true });
      }
      // Permanent. Comments, reactions, saves and reports go with it (cascade).
      // A live workflow has to be unpublished first, so a mis-tap cannot take a
      // page other people link to.
      if (req.method === "DELETE" && parts.length === 4) {
        if (row.status === "published") return reply(409, { ok: false, error: "published" });
        await pool.query("DELETE FROM workflows WHERE id = $1", [row.id]);
        await event("delete", { creatorId: creator.id, detail: { workflowId: row.id, slug: row.slug, title: row.title } });
        return reply(200, { ok: true });
      }
    }
  }
  return reply(404, { ok: false, error: "not_found" });
}

module.exports = { init, handle, parseWorkflow, createWorkflow, uniqueSlug, slugify, creatorFromRequest, parseXStatusUrl, communityToWildItem, fetchPublicTweet, FEATURED_SLUGS };
