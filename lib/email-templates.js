"use strict";

// Email templates for Built with Muse (Step 7). Plain text only. Each
// function takes the data its email needs and returns { subject, text }.
//
// Copy is the approved draft set from the goal folder (email-templates.md):
// plain, confident, no fabricated numbers. House rule: no hyphen or dash
// characters anywhere in the copy. The unsubscribe line is appended by
// these functions from the per recipient URL the sending module builds.

const FOOTER = [
  "Built with Muse",
  "Independent community project. Not affiliated with or endorsed by Meta.",
].join("\n");

// To a creator whose workflow was picked for the weekly Featured slot.
// Data: firstName, workflowTitle, workflowUrl, endDate (a spelled out date
// label, e.g. "October 23, 2026"), unsubscribeUrl.
function featuredNotification({ firstName, workflowTitle, workflowUrl, endDate, unsubscribeUrl }) {
  const subject = "Your workflow is featured on Built with Muse this week";
  const text = [
    `Hi ${firstName},`,
    "",
    `Your workflow, ${workflowTitle}, is this week’s Featured pick on Built with Muse. It leads the homepage until ${endDate}, carries a Featured badge on its page, and sits in the featured archive for good.`,
    "",
    `Your page: ${workflowUrl}`,
    "",
    "If you want to share it, the page has one tap posting for X and Threads ready to go, with the platform account tagged so we can amplify it.",
    "",
    "Thanks for publishing it where people can copy it.",
    "",
    FOOTER,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");
  return { subject, text };
}

// The weekly digest to opted in readers and creators.
// Data: featured { title, creatorName, summary, url },
// newWorkflows [{ title, creatorName, summary, url }], task { title,
// line, url }, unsubscribeUrl.
function weeklyDigest({ featured, newWorkflows, task, unsubscribeUrl }) {
  const subject = `This week on Built with Muse: ${featured.title}`;
  const text = [
    "One pick, a few new workflows, one job worth handing to Muse.",
    "",
    "FEATURED THIS WEEK",
    `${featured.title}, by ${featured.creatorName}`,
    featured.summary,
    `Read it: ${featured.url}`,
    "",
    "NEW WORKFLOWS",
    ...(newWorkflows || []).map((w) => `${w.title}, by ${w.creatorName}: ${w.summary} ${w.url}`),
    "",
    "ONE JOB TO TRY",
    `${task.title}: ${task.line}`,
    `Read the guide: ${task.url}`,
    "",
    "Publish what you run. The workflows people copy next week are written by someone who ran them this week: builtwithmuse.com/submit",
    "",
    FOOTER,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");
  return { subject, text };
}

// To one country's waitlist on the day Muse launches there.
// Data: country, unsubscribeUrl.
function launchBlast({ country, unsubscribeUrl }) {
  const subject = `Muse just launched in ${country}. Your code is waiting.`;
  const text = [
    `You joined the waitlist for Muse in ${country}, and Muse has now launched there.`,
    "",
    "Claim a free invite code from the community pool and set Muse up today:",
    "builtwithmuse.com",
    "",
    "Codes move fast on launch days. If the pool is empty when you arrive, add yours back once you are in and someone else gets their start the same way.",
    "",
    "Welcome in.",
    "",
    FOOTER,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");
  return { subject, text };
}

module.exports = { featuredNotification, weeklyDigest, launchBlast };
