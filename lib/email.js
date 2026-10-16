"use strict";

// Step 7 email layer: sends the platform's three emails through Resend.
//
//   sendFeaturedNotification(creator, workflow)  a creator's workflow was picked
//   sendWeeklyDigest(recipients, content)         the weekly digest to opt ins
//   sendLaunchBlast(country, recipients)          a country's waitlist, launch day
//
// Configuration is two environment variables: RESEND_API_KEY and EMAIL_FROM
// (default below). When RESEND_API_KEY is not set, every function logs the
// skip and returns { skipped: true } without sending anything, so the site
// behaves exactly as it does today until the key lands in Vercel.
//
// Recipients may be plain email strings or objects with an email field, so
// callers can pass database rows straight in.
//
// Unsubscribe: every email carries a per recipient link built by
// unsubscribeUrl(). The token is the recipient email encoded in base64url;
// it identifies the account to the /unsubscribe endpoint. That endpoint is
// not part of this batch (see BUILD-NOTES.md) and must exist before the
// first real send.

const templates = require("./email-templates");

const RESEND_URL = "https://api.resend.com/emails";
const SITE_URL = "https://builtwithmuse.com";
const DEFAULT_FROM = "Built with Muse <hello@builtwithmuse.com>";

function sender() {
  return process.env.EMAIL_FROM || DEFAULT_FROM;
}

function unsubscribeUrl(email) {
  const token = Buffer.from(String(email || ""), "utf8").toString("base64url");
  return `${SITE_URL}/unsubscribe?e=${token}`;
}

function emailOf(recipient) {
  if (!recipient) return "";
  return typeof recipient === "string" ? recipient : String(recipient.email || "");
}

async function deliver(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[email] skipped (RESEND_API_KEY not set): ${subject} -> ${to}`);
    return { skipped: true };
  }
  let res;
  try {
    res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: sender(), to, subject, text }),
    });
  } catch (err) {
    console.error(`[email] send failed (${subject} -> ${to}): ${err.message}`);
    return { skipped: false, ok: false, error: err.message };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[email] Resend ${res.status} (${subject} -> ${to}): ${detail.slice(0, 200)}`);
    return { skipped: false, ok: false, status: res.status };
  }
  const data = await res.json().catch(() => ({}));
  return { skipped: false, ok: true, id: data.id || null };
}

function firstNameOf(creator) {
  const name = String((creator && (creator.displayName || creator.display_name || creator.name)) || "").trim();
  return name.split(/\s+/)[0] || "there";
}

function workflowUrlOf(workflow) {
  if (workflow && workflow.url) return workflow.url;
  return `${SITE_URL}/workflows/${(workflow && workflow.slug) || ""}`;
}

// creator: { email, displayName } (database rows with display_name also
// work). workflow: { title, slug } or { title, url }; workflow.endDate is
// the spelled out date the featured week ends.
async function sendFeaturedNotification(creator, workflow) {
  const to = emailOf(creator);
  if (!to) return { skipped: true, reason: "no_recipient" };
  const { subject, text } = templates.featuredNotification({
    firstName: firstNameOf(creator),
    workflowTitle: (workflow && workflow.title) || "",
    workflowUrl: workflowUrlOf(workflow),
    endDate: (workflow && workflow.endDate) || "",
    unsubscribeUrl: unsubscribeUrl(to),
  });
  return deliver(to, subject, text);
}

async function sendToMany(recipients, render) {
  const list = (recipients || []).map(emailOf).filter(Boolean);
  if (!process.env.RESEND_API_KEY) {
    console.log(`[email] skipped (RESEND_API_KEY not set): ${list.length} recipient(s)`);
    return { skipped: true };
  }
  let sent = 0;
  const failed = [];
  for (const to of list) {
    const { subject, text } = render(to);
    const result = await deliver(to, subject, text);
    if (result.ok) sent += 1;
    else failed.push(to);
  }
  return { skipped: false, ok: failed.length === 0, sent, failed };
}

// content: { featured: { title, creatorName, summary, url },
// newWorkflows: [{ title, creatorName, summary, url }],
// task: { title, line, url } }
async function sendWeeklyDigest(recipients, content) {
  const c = content || {};
  return sendToMany(recipients, (to) => templates.weeklyDigest({
    featured: c.featured || {},
    newWorkflows: c.newWorkflows || [],
    task: c.task || {},
    unsubscribeUrl: unsubscribeUrl(to),
  }));
}

async function sendLaunchBlast(country, recipients) {
  return sendToMany(recipients, (to) => templates.launchBlast({
    country,
    unsubscribeUrl: unsubscribeUrl(to),
  }));
}

module.exports = { sendFeaturedNotification, sendWeeklyDigest, sendLaunchBlast, unsubscribeUrl };
