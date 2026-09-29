"use strict";

// /submit: the one-screen way to publish a workflow. Three questions, one
// button. Nobody signs in until they press Publish, the draft survives the
// Google popup in localStorage, and the optional detail (summary, category,
// steps, screenshot) is offered after the workflow is live, never before.

const { layout } = require("./pages");

const CSS = `
.submit-wrap { max-width: 720px; margin: 0 auto; }
.submit-head { margin: 8px 0 22px; }
.submit-head h1 { margin: 6px 0 10px; font-size: clamp(30px, 4.6vw, 44px); letter-spacing: -0.03em; line-height: 1.02; }
.submit-head p { margin: 0; color: var(--muted); font-size: 16px; line-height: 1.55; max-width: 56ch; }
.submit-card { background: #fff; border: 1px solid var(--line); border-radius: 18px; padding: clamp(20px, 3vw, 30px); box-shadow: var(--shadow); }
.submit-card .form-stack { display: grid; gap: 18px; }
.q { display: grid; gap: 8px; }
.q label { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; font-size: 15px; font-weight: 700; color: var(--ink); }
.q label small { font-size: 12px; font-weight: 600; color: var(--muted-2); letter-spacing: 0; text-transform: none; }
.q .hint { font-size: 13px; color: var(--muted-2); line-height: 1.45; }
.q textarea { min-height: 96px; }
.q.bad input, .q.bad textarea { border-color: #d64545; box-shadow: 0 0 0 3px rgba(214,69,69,.12); }
.q .err { font-size: 13px; color: #b3261e; font-weight: 600; }
.link-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.link-toggle { background: none; border: 0; padding: 0; color: var(--blue-deep); font-weight: 700; font-size: 14px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.submit-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding-top: 4px; }
.submit-actions .cta { min-height: 48px; padding: 0 26px; font-size: 16px; }
.submit-status { font-size: 14px; font-weight: 600; color: var(--muted); min-height: 20px; }
.submit-status.err { color: #b3261e; }
.submit-status.ok { color: var(--blue-deep); }
.signin-inline { display: none; gap: 10px; align-items: center; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--tint); }
.signin-inline.show { display: flex; flex-wrap: wrap; }
.signin-inline p { margin: 0; font-size: 14px; color: var(--ink); flex: 1 1 260px; }
.done { display: none; }
.done.show { display: block; }
.done .live { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: var(--tint); color: var(--blue-deep); font-weight: 700; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; }
.done h2 { margin: 14px 0 6px; font-size: 28px; letter-spacing: -0.02em; }
.done .url { display: flex; gap: 8px; margin: 14px 0; }
.done .url input { flex: 1; min-width: 0; }
.done .url button { flex: 0 0 auto; }
.done .next { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line-soft); }
.done .as { font-size: 14px; color: var(--muted); }
.done .as b { color: var(--ink); }
.handle-row { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
.handle-row input { max-width: 240px; }
.submit-card .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 16px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--ink); font-weight: 700; font-size: 14px; text-decoration: none; cursor: pointer; font-family: inherit; }
.submit-card .btn:hover { border-color: var(--blue); color: var(--blue-deep); }
.submit-card .btn.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
.submit-card .btn.primary:hover { background: var(--blue-deep); border-color: var(--blue-deep); color: #fff; }
.done input { width: 100%; box-sizing: border-box; padding: 11px 14px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--ink); font: 500 15px/1.4 "IBM Plex Sans", system-ui, sans-serif; }
.done input:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(26,86,255,.16); }
.done .next { display: flex; flex-wrap: wrap; gap: 10px; }
.mini-note { font-size: 13px; color: var(--muted-2); margin: 16px 0 0; line-height: 1.5; }
.mini-note a { color: var(--blue-deep); }
.promptpack { margin: 0 0 22px; border: 1px dashed var(--line); border-radius: 14px; padding: 16px 18px; background: var(--tint); }
.promptpack h2 { margin: 0 0 6px; font-size: 16px; letter-spacing: -0.01em; }
.promptpack p { margin: 0 0 12px; font-size: 14px; color: var(--muted); line-height: 1.55; max-width: 62ch; }
.promptpack details { margin-top: 12px; }
.promptpack summary { font-size: 13px; font-weight: 700; color: var(--blue-deep); cursor: pointer; }
.promptpack pre { white-space: pre-wrap; font-size: 13px; line-height: 1.55; background: #fff; border: 1px solid var(--line-soft); border-radius: 10px; padding: 12px 14px; margin: 10px 0 0; color: var(--ink); font-family: inherit; }
@media (max-width: 640px) { .submit-card { padding: 18px; border-radius: 14px; } .submit-actions .cta { width: 100%; } }
`;

const BODY = `
        <div class="submit-wrap">
          <div class="submit-head">
            <div class="eyebrow">Publish a workflow</div>
            <h1>What did Muse do for you?</h1>
            <p>Three answers and it is live under your name. No account needed until you press Publish.</p>
          </div>
          <div class="submit-card">
            <div class="promptpack">
              <h2>Shortcut: let Muse write this for you</h2>
              <p>Copy the prompt, paste it into the Muse chat where you did the work. Muse lists the workflows it finds, you pick one, and it drafts the post. Then paste each answer back into the matching field below.</p>
              <button class="btn primary" type="button" id="s-pp-copy">Copy the prompt</button>
              <details><summary>Read the prompt first</summary><pre id="s-pp-text">There is a community platform called Built with Muse where people post workflows they made with Muse. I want to post the workflows I have created with you there. Other users will read the post and may copy the prompt I used, so write everything to be reproducible.

First, look at this conversation and list the distinct workflows we completed, numbered. Ask me which one to write up.

Then, for the one I choose, draft the post around the platform's three questions. Answer each briefly, in plain words, no hype:

1. What were you trying to do?
2. What did you tell Muse? Write this as a complete, standalone prompt. Anyone who copies it into a fresh chat should get the same result I got. Do not reference this conversation.
3. What happened? Include anything that did not work.

Also suggest a short title for the post, under 70 characters.</pre></details>
            </div>
            <form id="submit-form" class="form-stack" novalidate>
              <div class="q" data-q="title">
                <label for="s-title">What were you trying to do? <small id="s-title-n">10 to 70 characters</small></label>
                <input id="s-title" name="title" maxlength="70" placeholder="Turn a messy inbox into a daily action list" autocomplete="off" />
                <div class="link-row"><button class="link-toggle" type="button" id="s-link-toggle">Have a Muse share link? Paste it and we fill this in</button></div>
                <input id="s-muse" name="muse_url" type="url" inputmode="url" placeholder="https://muse.ai/s/..." hidden />
              </div>
              <div class="q" data-q="prompt">
                <label for="s-prompt">What did you tell Muse? <small>the exact prompt</small></label>
                <textarea id="s-prompt" name="prompt" maxlength="1000" rows="4" placeholder="Look at my last 200 Gmail messages and turn every actionable item into a checklist grouped by today, this week and later."></textarea>
                <div class="hint">Readers copy this, so paste what you actually typed.</div>
              </div>
              <div class="q" data-q="result">
                <label for="s-result">What happened? <small>the honest outcome</small></label>
                <textarea id="s-result" name="result" maxlength="1000" rows="4" placeholder="It found 34 actionable items and grouped them well. It missed two calendar invites, so I still check those by hand."></textarea>
              </div>
              <div class="signin-inline" id="s-signin"><p>One step: sign in with Google so the workflow has an owner. We show only your handle, never your email.</p><div id="s-google-btn"></div></div>
              <div class="submit-actions">
                <button class="cta" type="submit" id="s-publish">Publish</button>
                <span class="submit-status" id="s-status" aria-live="polite"></span>
              </div>
            </form>
            <div class="done" id="s-done">
              <span class="live">Live</span>
              <h2 id="s-done-title"></h2>
              <p class="as">Published as <b id="s-done-handle"></b>. <span id="s-handle-nudge"></span></p>
              <div class="handle-row" id="s-handle-row" hidden><input id="s-handle" maxlength="30" placeholder="pick a handle" aria-label="Your handle" /><button class="btn" type="button" id="s-handle-save">Save</button><span class="submit-status" id="s-handle-status"></span></div>
              <div class="url"><input id="s-done-url" readonly aria-label="Link to your workflow" /><button class="btn" type="button" id="s-copy">Copy link</button><button class="btn primary" type="button" id="s-share">Share</button></div>
              <div class="next">
                <a class="btn" id="s-done-open" href="#">Open the workflow</a>
                <a class="btn" id="s-done-edit" href="#">Add steps, a screenshot or a category</a>
                <button class="btn" type="button" id="s-another">Publish another one</button>
              </div>
            </div>
          </div>
          <p class="mini-note">Drafts stay on this device until you publish. Publishing is three a day on your first day, ten after that. <a href="/creator">Your dashboard</a> has everything you have published.</p>
        </div>`;

const SCRIPT = `
      (() => {
        const $ = (id) => document.getElementById(id);
        const KEY = "bwm.submit.draft";
        const form = $("submit-form"), status = $("s-status"), publishBtn = $("s-publish");
        const MSG = {
          title_short: "Give it a title of at least 10 characters.", title_long: "Keep the title under 70 characters.",
          prompt_short: "Add what you told Muse.", prompt_long: "The prompt is over 1000 characters.",
          result_short: "Say what happened.", result_long: "The result is over 1000 characters.",
          muse_url_invalid: "That is not a Muse share link (https://muse.ai/s/...).",
          publish_limit: "You have hit today's publishing limit. It was saved as a draft in your dashboard.",
          submissions_closed: "Publishing is closed right now.", too_many_workflows: "You have too many drafts. Remove some in your dashboard.",
          sign_in_required: "Please sign in and press Publish again.", signin_required: "Please sign in and press Publish again.",
          rate_limited: "Too many attempts. Wait a minute.", bad_token: "Google sign in failed. Try again.",
          account_deactivated: "This account is deactivated.", account_removed: "This account has been removed.",
          handle_invalid: "3 to 30 letters, numbers or underscores.", handle_reserved: "That handle is reserved.", handle_taken: "That handle is taken.", handle_cooldown: "Handles change once every thirty days."
        };
        const msg = (c) => MSG[c] || "Something went wrong. Try again.";
        const FIELD = { title: "title", prompt: "prompt", result: "result", muse_url: "title" };
        let me = null, clientId = "", googleReady = false, pendingPublish = false;

        async function api(path, opts) {
          const r = await fetch(path, { method: opts && opts.method || "GET", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: opts && opts.body ? JSON.stringify(opts.body) : undefined });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) { const e = new Error(d.error || "request_failed"); e.errors = Array.isArray(d.errors) ? d.errors : []; throw e; }
          return d;
        }
        const setStatus = (t, kind) => { status.textContent = t || ""; status.className = "submit-status" + (kind ? " " + kind : ""); };
        const read = () => ({ title: $("s-title").value.trim(), prompt: $("s-prompt").value.trim(), result: $("s-result").value.trim(), muse_url: $("s-muse").value.trim() });
        const mark = (errors) => {
          form.querySelectorAll(".q").forEach((q) => { q.classList.remove("bad"); const e = q.querySelector(".err"); if (e) e.remove(); });
          const seen = new Set();
          errors.forEach((code) => {
            if (seen.has(code)) return; seen.add(code);
            const name = FIELD[code.replace(/_(short|long|invalid)$/, "")]; if (!name) return;
            const q = form.querySelector('.q[data-q="' + name + '"]'); if (!q) return;
            q.classList.add("bad");
            const e = document.createElement("div"); e.className = "err"; e.textContent = msg(code); q.appendChild(e);
          });
          const first = form.querySelector(".q.bad"); if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
        };
        const localErrors = (b) => {
          const errs = [];
          if (b.title.length < 10) errs.push("title_short"); if (b.title.length > 70) errs.push("title_long");
          if (!b.prompt) errs.push("prompt_short"); if (!b.result) errs.push("result_short");
          const mu = b.muse_url.toLowerCase();
          if (mu && mu.indexOf("https://muse.ai/s/") !== 0 && mu.indexOf("https://www.muse.ai/s/") !== 0) errs.push("muse_url_invalid");
          return errs;
        };

        // Draft on this device, so the Google popup never costs anyone their answers.
        const save = () => { try { localStorage.setItem(KEY, JSON.stringify(read())); } catch (_) {} };
        const restore = () => { try { const d = JSON.parse(localStorage.getItem(KEY) || "null"); if (!d) return; $("s-title").value = d.title || ""; $("s-prompt").value = d.prompt || ""; $("s-result").value = d.result || ""; $("s-muse").value = d.muse_url || ""; if (d.muse_url) $("s-muse").hidden = false; } catch (_) {} };
        ["s-title", "s-prompt", "s-result", "s-muse"].forEach((id) => $(id).addEventListener("input", save));
        $("s-title").addEventListener("input", () => { const n = $("s-title").value.length; $("s-title-n").textContent = n ? n + " of 70" : "10 to 70 characters"; });
        $("s-link-toggle").addEventListener("click", () => { $("s-muse").hidden = false; $("s-link-toggle").parentElement.hidden = true; $("s-muse").focus(); });
        let museTimer = null;
        $("s-muse").addEventListener("input", () => {
          clearTimeout(museTimer);
          const v = $("s-muse").value.trim();
          if (v.indexOf("muse.ai/s/") === -1) return;
          museTimer = setTimeout(async () => {
            try { const d = await api("/api/v1/muse-preview?url=" + encodeURIComponent(v)); if (d.url) $("s-muse").value = d.url; if (d.title && !$("s-title").value.trim()) { $("s-title").value = d.title.slice(0, 70); $("s-title").dispatchEvent(new Event("input")); } } catch (_) {}
          }, 400);
        });

        // Google, only when it is needed.
        function loadGoogle() {
          return new Promise((resolve) => {
            const tick = () => { if (window.google && google.accounts && google.accounts.id) { if (!googleReady) { google.accounts.id.initialize({ client_id: clientId, callback: onCredential, ux_mode: "popup", auto_select: false, use_fedcm_for_prompt: true }); googleReady = true; } resolve(true); } else setTimeout(tick, 120); };
            if (!document.querySelector('script[src^="https://accounts.google.com/gsi/client"]')) { const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; document.head.appendChild(s); }
            tick();
            setTimeout(() => resolve(Boolean(window.google && google.accounts)), 6000);
          });
        }
        function showInlineSignin() {
          $("s-signin").classList.add("show");
          try { google.accounts.id.renderButton($("s-google-btn"), { theme: "outline", size: "large", text: "continue_with", shape: "pill" }); } catch (_) {}
          $("s-signin").scrollIntoView({ block: "center", behavior: "smooth" });
        }
        async function signin() {
          if (!clientId) { try { const c = await api("/api/v1/config"); clientId = c.clientId || ""; } catch (_) {} }
          if (!clientId || !(await loadGoogle())) { setStatus("Google sign in is unavailable right now.", "err"); return; }
          setStatus("Sign in with Google to publish.");
          try {
            google.accounts.id.prompt((n) => { let blocked = false; try { blocked = n.isNotDisplayed() || n.isSkippedMoment(); } catch (_) { blocked = true; } if (blocked) showInlineSignin(); });
          } catch (_) { showInlineSignin(); }
        }
        async function onCredential(response) {
          setStatus("Signing you in.");
          try {
            const d = await api("/api/v1/auth/google", { method: "POST", body: { credential: response.credential } });
            if (!d.signedIn) throw new Error("bad_token");
            me = { handle: d.handle, needsHandle: Boolean(d.needsHandle) };
            await loadMe();
            $("s-signin").classList.remove("show");
            if (pendingPublish) { pendingPublish = false; await publish(); }
          } catch (e) { setStatus(msg(e.message), "err"); }
        }

        async function publish() {
          const body = read();
          const local = localErrors(body);
          mark(local);
          if (local.length) { setStatus(local.map(msg)[0], "err"); return; }
          if (!me) { pendingPublish = true; await signin(); return; }
          publishBtn.disabled = true; setStatus("Publishing.");
          try {
            const d = await api("/api/v1/workflows", { method: "POST", body: { ...body, publish: true } });
            try { localStorage.removeItem(KEY); } catch (_) {}
            showDone(d, body.title);
          } catch (e) {
            const list = [...new Set(e.errors || [])];
            mark(list);
            if (e.message === "sign_in_required" || e.message === "signin_required") { me = null; pendingPublish = true; await signin(); return; }
            setStatus(list.length ? list.map(msg).join(" ") : msg(e.message), "err");
          } finally { publishBtn.disabled = false; }
        }
        form.addEventListener("submit", (e) => { e.preventDefault(); publish(); });

        function showDone(d, title) {
          const url = location.origin + "/workflows/" + d.slug;
          $("s-done-title").textContent = title;
          $("s-done-handle").textContent = "@" + (me && me.handle || "you");
          $("s-done-url").value = url;
          $("s-done-open").href = url;
          $("s-done-edit").href = "/creator#edit-" + d.id;
          if (me && me.needsHandle) { $("s-handle-nudge").textContent = "Want a better handle than that?"; $("s-handle-row").hidden = false; }
          form.style.display = "none"; setStatus("");
          $("s-done").classList.add("show");
          window.scrollTo({ top: 0, behavior: "smooth" });
          try { if (typeof window.clarity === "function") window.clarity("event", "workflow_published_simple"); } catch (_) {}
        }
        const PP = "There is a community platform called Built with Muse where people post workflows they made with Muse. I want to post the workflows I have created with you there. Other users will read the post and may copy the prompt I used, so write everything to be reproducible.\\n\\nFirst, look at this conversation and list the distinct workflows we completed, numbered. Ask me which one to write up.\\n\\nThen, for the one I choose, draft the post around the platform's three questions. Answer each briefly, in plain words, no hype:\\n\\n1. What were you trying to do?\\n2. What did you tell Muse? Write this as a complete, standalone prompt. Anyone who copies it into a fresh chat should get the same result I got. Do not reference this conversation.\\n3. What happened? Include anything that did not work.\\n\\nAlso suggest a short title for the post, under 70 characters.";
        const ppCopy = async (text) => {
          const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
          try { if (navigator.clipboard && navigator.clipboard.writeText) { await timed(navigator.clipboard.writeText(text), 1500); return true; } } catch (_) {}
          try {
            const ta = document.createElement("textarea");
            ta.value = text; ta.setAttribute("readonly", "");
            ta.style.position = "fixed"; ta.style.top = "0"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.focus(); ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            return ok;
          } catch (_) { return false; }
        };
        const ppBtn = $("s-pp-copy");
        if (ppBtn) ppBtn.addEventListener("click", async () => {
          const ok = await ppCopy(PP);
          if (ok) { ppBtn.textContent = "Copied"; setTimeout(() => { ppBtn.textContent = "Copy the prompt"; }, 1800); }
          else {
            ppBtn.textContent = "Copy it manually";
            const det = ppBtn.parentElement.querySelector("details"); if (det) det.open = true;
            const pre = $("s-pp-text");
            if (pre) { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
            setTimeout(() => { ppBtn.textContent = "Copy the prompt"; }, 2600);
          }
        });
        $("s-copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("s-done-url").value); $("s-copy").textContent = "Copied"; setTimeout(() => { $("s-copy").textContent = "Copy link"; }, 1800); } catch (_) { $("s-done-url").select(); } });
        $("s-share").addEventListener("click", async () => { const url = $("s-done-url").value, t = $("s-done-title").textContent; try { if (navigator.share) await navigator.share({ title: t, text: "I made Muse do this: " + t, url }); else { await navigator.clipboard.writeText(url); $("s-share").textContent = "Link copied"; } } catch (_) {} });
        $("s-another").addEventListener("click", () => { form.reset(); $("s-muse").hidden = true; $("s-link-toggle").parentElement.hidden = false; $("s-title-n").textContent = "10 to 70 characters"; $("s-done").classList.remove("show"); form.style.display = ""; window.scrollTo({ top: 0 }); });
        $("s-handle-save").addEventListener("click", async () => {
          const h = $("s-handle").value.trim(); const st = $("s-handle-status");
          const pr = (me && me.profile) || {};
          try { const d = await api("/api/v1/me/profile", { method: "PATCH", body: { handle: h, displayName: pr.displayName || pr.name || h, bio: pr.bio || "", websiteUrl: pr.websiteUrl || "", xUrl: pr.xUrl || "", youtubeUrl: pr.youtubeUrl || "", instagramUrl: pr.instagramUrl || "", tiktokUrl: pr.tiktokUrl || "", linkedinUrl: pr.linkedinUrl || "", threadsUrl: pr.threadsUrl || "", links: pr.links || [] } }); st.textContent = "Saved."; st.className = "submit-status ok"; $("s-done-handle").textContent = "@" + (d.handle || h); $("s-handle-nudge").textContent = ""; $("s-handle-row").hidden = true; }
          catch (e) { const list = e.errors && e.errors.length ? e.errors : [e.message]; st.textContent = list.map(msg).join(" "); st.className = "submit-status err"; }
        });

        restore();
        $("s-title").dispatchEvent(new Event("input"));
        async function loadMe() {
          try { const d = await api("/api/v1/me"); if (d && d.creator) me = { handle: d.creator.handle, needsHandle: Boolean(d.creator.needsHandle), profile: d.creator }; } catch (_) {}
        }
        loadMe();
      })();`;

function submitPage() {
  return layout({
    title: "Publish a workflow | Built with Muse",
    description: "Three answers and your Muse workflow is live under your name.",
    path: "/submit", current: "/creator", noindex: true, body: BODY, extraCss: CSS, script: SCRIPT,
  });
}

module.exports = { submitPage };
