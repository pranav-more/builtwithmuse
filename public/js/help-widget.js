// Floating help bubble, bottom right on every page: Help center, Feedback,
// Feature request. Everything it collects lands in the admin Inbox.
(() => {
  if (window.__bwmHelp) return; window.__bwmHelp = true;
  const CSS = `
.hw-fab{position:fixed;right:18px;bottom:18px;z-index:9000;width:54px;height:54px;border-radius:50%;border:0;background:#1a56ff;color:#fff;box-shadow:0 12px 30px rgba(26,86,255,.35);display:grid;place-items:center;cursor:pointer;transition:transform .15s}
.hw-fab:hover{transform:translateY(-2px)}
.hw-fab svg{width:26px;height:26px}
.hw-fab .hw-x{display:none}
.hw-open .hw-fab .hw-chat{display:none}.hw-open .hw-fab .hw-x{display:block}
.hw-panel{position:fixed;right:18px;bottom:84px;z-index:9000;width:min(380px,calc(100vw - 24px));max-height:min(620px,calc(100vh - 110px));display:none;flex-direction:column;background:#fff;color:#0b1220;border:1px solid #dfe5f3;border-radius:18px;box-shadow:0 24px 60px rgba(11,18,32,.22);overflow:hidden;font-family:"IBM Plex Sans",system-ui,sans-serif}
.hw-open .hw-panel{display:flex}
.hw-head{padding:16px 18px 12px;background:#0b1220;color:#fff}
.hw-head b{display:block;font:800 17px/1.2 "Archivo",sans-serif;letter-spacing:-.02em}
.hw-head span{display:block;font-size:13px;color:#aab3c8;margin-top:3px}
.hw-tabs{display:flex;gap:4px;padding:10px 12px 0;border-bottom:1px solid #eef1f7}
.hw-tabs button{flex:1;padding:9px 6px;border:0;border-bottom:2px solid transparent;background:none;font:600 13px "IBM Plex Sans",system-ui,sans-serif;color:#4b5675;cursor:pointer;white-space:nowrap}
.hw-tabs button[aria-selected="true"]{color:#0f3fc4;border-bottom-color:#1a56ff}
.hw-body{padding:14px 16px 16px;overflow:auto;display:grid;gap:10px}
.hw-faq details{border:1px solid #e6e9f2;border-radius:10px;padding:0 12px;background:#f8f9fd}
.hw-faq summary{list-style:none;cursor:pointer;padding:10px 0;font-size:14px;font-weight:600;display:flex;justify-content:space-between;gap:10px}
.hw-faq summary::-webkit-details-marker{display:none}
.hw-faq summary::after{content:"+";color:#1a56ff;font-weight:700}
.hw-faq details[open] summary::after{content:"\\2212"}
.hw-faq p{margin:0 0 12px;font-size:13px;line-height:1.5;color:#4b5675}
.hw-faq a{color:#0f3fc4}
.hw-sub{font-size:13px;color:#4b5675;line-height:1.5;margin:0}
.hw-sub b{color:#0b1220}
.hw-form{display:grid;gap:10px}
.hw-form label{display:grid;gap:5px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7699}
.hw-form input,.hw-form textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dfe5f3;border-radius:10px;font:500 14px/1.4 "IBM Plex Sans",system-ui,sans-serif;color:#0b1220;background:#fff}
.hw-form input:focus,.hw-form textarea:focus{outline:none;border-color:#1a56ff;box-shadow:0 0 0 3px rgba(26,86,255,.16)}
.hw-form textarea{min-height:96px;resize:vertical}
.hw-form .hw-opt{text-transform:none;letter-spacing:0;font-weight:600;color:#8e98b3}
.hw-send{padding:11px 16px;border:0;border-radius:10px;background:#1a56ff;color:#fff;font:700 14px "IBM Plex Sans",system-ui,sans-serif;cursor:pointer}
.hw-send:disabled{opacity:.6;cursor:default}
.hw-status{font-size:13px;font-weight:600;min-height:18px;color:#4b5675}
.hw-status.err{color:#b3261e}.hw-status.ok{color:#0f3fc4}
.hw-done{display:grid;gap:8px;padding:10px 0}
.hw-done b{font:800 18px "Archivo",sans-serif;letter-spacing:-.02em}
.hw-done p{margin:0;font-size:14px;color:#4b5675;line-height:1.5}
.hw-done button{justify-self:start;padding:9px 14px;border:1px solid #dfe5f3;border-radius:10px;background:#fff;font:700 13px "IBM Plex Sans",system-ui,sans-serif;cursor:pointer}
@media (max-width:640px){.hw-fab{right:14px;bottom:14px}.hw-panel{right:12px;left:12px;width:auto;bottom:78px}}
@media print{.hw-fab,.hw-panel{display:none!important}}
`;
  const FAQ = [
    ["How do I get a Muse invite code?", 'Open the <a href="/">homepage</a>, press Get a code, sign in with Google, and copy the code. Redeem it in the Muse app under Settings within 48 hours.'],
    ["My code says it is invalid or used up", 'Press "Not working? Try another" under your code. That flags the code for the moderators and hands you a fresh one right away.'],
    ["How do I share my own invite?", 'Press Share a code on the homepage and paste the invite message from your Muse app. Muse credits tokens to both of you when someone redeems it.'],
    ["How do I publish a workflow?", 'Go to <a href="/submit">Publish a workflow</a>. Three answers and it is live under your name. You can add steps and a screenshot afterwards from your <a href="/creator">dashboard</a>.'],
    ["Muse is not available in my country", 'Join the waitlist from the homepage and we will send you a fresh code on launch day. See <a href="/blog/how-to-use-meta-muse-outside-us">Muse outside the US</a> for what works today.'],
  ];
  const KINDS = {
    help: { title: "Help center", sub: "Quick answers first. Still stuck? Write to us below.", email: true, placeholder: "What are you trying to do, and what happened?", btn: "Send to support" },
    feedback: { title: "Feedback", sub: "What is working, what is confusing, what you would change. Email is optional.", email: false, placeholder: "Tell us what you think.", btn: "Send feedback" },
    feature: { title: "Feature request", sub: "What should Built with Muse do next? We reply when it ships.", email: true, placeholder: "Describe the feature and what it would help you do.", btn: "Request it" },
  };
  const style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
  const root = document.createElement("div"); root.className = "hw";
  root.innerHTML = `
<button class="hw-fab" type="button" aria-label="Help, feedback and feature requests" aria-expanded="false">
  <svg class="hw-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.2-4.2A8 8 0 1 1 21 12z"/><path d="M8 11h8M8 14h5"/></svg>
  <svg class="hw-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
</button>
<div class="hw-panel" role="dialog" aria-label="Help">
  <div class="hw-head"><b id="hw-title">Help center</b><span id="hw-sub"></span></div>
  <div class="hw-tabs" role="tablist">
    <button type="button" role="tab" data-kind="help" aria-selected="true">Help center</button>
    <button type="button" role="tab" data-kind="feedback" aria-selected="false">Feedback</button>
    <button type="button" role="tab" data-kind="feature" aria-selected="false">Feature request</button>
  </div>
  <div class="hw-body" id="hw-body"></div>
</div>`;
  document.body.appendChild(root);
  const fab = root.querySelector(".hw-fab"), body = root.querySelector("#hw-body");
  let kind = "help", me = null, meLoaded = false;
  const esc = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const draftKey = () => "bwm.help." + kind;
  function loadMe() {
    if (meLoaded) return Promise.resolve(me); meLoaded = true;
    return fetch("/api/v1/me", { credentials: "same-origin" }).then((r) => r.json()).then((d) => { me = d && d.ok && d.creator ? d.creator : null; return me; }).catch(() => null);
  }
  function render() {
    const k = KINDS[kind];
    root.querySelector("#hw-title").textContent = k.title;
    root.querySelector("#hw-sub").textContent = k.sub;
    root.querySelectorAll("[data-kind]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.kind === kind)));
    let draft = ""; try { draft = localStorage.getItem(draftKey()) || ""; } catch (_) {}
    const email = me && me.email ? me.email : "";
    body.innerHTML = (kind === "help" ? `<div class="hw-faq">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${a}</p></details>`).join("")}</div><p class="hw-sub"><b>Still stuck?</b> Tell us what happened and we will get back to you by email.</p>` : "") +
      `<form class="hw-form" id="hw-form" novalidate>
        <label>Email${k.email ? "" : ' <span class="hw-opt">optional</span>'}<input type="email" name="email" value="${esc(email)}" placeholder="you@example.com" autocomplete="email" ${k.email ? "required" : ""}></label>
        <label>Message<textarea name="message" placeholder="${esc(k.placeholder)}" maxlength="2000" required>${esc(draft)}</textarea></label>
        <input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
        <button class="hw-send" type="submit">${esc(k.btn)}</button>
        <div class="hw-status" id="hw-status" aria-live="polite"></div>
      </form>`;
    const form = body.querySelector("#hw-form");
    form.message.addEventListener("input", () => { try { localStorage.setItem(draftKey(), form.message.value); } catch (_) {} });
    form.addEventListener("submit", submit);
  }
  async function submit(e) {
    e.preventDefault();
    const form = e.target, st = form.querySelector("#hw-status"), btn = form.querySelector(".hw-send");
    const email = form.email.value.trim(), message = form.message.value.trim();
    const k = KINDS[kind];
    if (k.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { st.textContent = "Add an email so we can reply."; st.className = "hw-status err"; form.email.focus(); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { st.textContent = "That email does not look right."; st.className = "hw-status err"; form.email.focus(); return; }
    if (message.length < 5) { st.textContent = "Write a few words first."; st.className = "hw-status err"; form.message.focus(); return; }
    btn.disabled = true; st.textContent = "Sending."; st.className = "hw-status";
    try {
      const r = await fetch("/api/inbox", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify({ kind, email, message, page: location.pathname + location.search, website: form.website.value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || "failed");
      try { localStorage.removeItem(draftKey()); } catch (_) {}
      body.innerHTML = `<div class="hw-done"><b>Got it.</b><p>${kind === "feedback" ? "Thanks for telling us." : "We read every message and reply by email, usually within a day."}</p><button type="button" id="hw-again">Send another</button></div>`;
      body.querySelector("#hw-again").addEventListener("click", render);
    } catch (err) {
      st.textContent = err.message === "rate_limited" ? "Too many messages for now. Try again in an hour." : "Could not send. Try again in a moment.";
      st.className = "hw-status err"; btn.disabled = false;
    }
  }
  function open() { root.classList.add("hw-open"); fab.setAttribute("aria-expanded", "true"); loadMe().then(render); }
  function close() { root.classList.remove("hw-open"); fab.setAttribute("aria-expanded", "false"); }
  fab.addEventListener("click", () => (root.classList.contains("hw-open") ? close() : open()));
  root.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => { kind = b.dataset.kind; render(); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && root.classList.contains("hw-open")) close(); });
  document.querySelectorAll("[data-help-open]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); kind = el.dataset.helpOpen in KINDS ? el.dataset.helpOpen : "help"; open(); }));
})();
