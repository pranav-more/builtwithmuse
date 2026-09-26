"use strict";

// The creator dashboard at /creator: sign in with Google, claim a handle,
// edit the profile, and write, publish, edit or unpublish workflows. Rendered
// through the shared layout so it looks like the rest of the site; all state
// comes from /api/v1 calls made by the inline script.

const { layout } = require("./pages");

const CSS = `
.dash { display: grid; gap: 22px; }
.panel { background: var(--navy); border: 1px solid var(--line); border-radius: var(--radius); padding: 26px; box-shadow: var(--shadow); }
.panel h2 { margin: 0 0 6px; font-size: 22px; }
.panel .sub { margin: 0 0 18px; color: var(--muted); line-height: 1.5; }
.hidden { display: none !important; }
.form-stack { display: grid; gap: 16px; }
.field { display: grid; gap: 7px; }
.field label { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted-2); display: flex; justify-content: space-between; }
.field label span { font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--muted-2); }
.field input, .field textarea, .field select { width: 100%; padding: 12px 14px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.06); color: var(--ink); }
.field textarea { min-height: 96px; resize: vertical; line-height: 1.5; }
.field input::placeholder, .field textarea::placeholder { color: rgba(199,214,255,.55); }
.field select option { color: #0b1b4d; background: #fff; }
.field small { color: var(--muted-2); font-size: 13px; line-height: 1.45; }
.field.bad input, .field.bad textarea, .field.bad select { border-color: var(--coral); }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.status { min-height: 20px; color: var(--muted); font-size: 14px; font-weight: 600; }
.status.err { color: var(--coral); }
.status.ok { color: var(--mint); }
.list { display: grid; gap: 10px; }
.item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 14px 16px; border: 1px solid var(--line-soft); border-radius: 8px; background: rgba(255,255,255,.04); }
.item h3 { margin: 0 0 4px; font-size: 17px; }
.item .m { color: var(--muted-2); font-size: 13px; font-weight: 600; display: flex; gap: 12px; flex-wrap: wrap; }
.item .btns { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.btn { padding: 9px 14px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.08); color: var(--ink); font-size: 13px; font-weight: 700; text-decoration: none; }
.btn:hover { background: rgba(255,255,255,.16); }
.btn.primary { background: var(--paper); color: var(--blue-deep); border-color: var(--paper); }
.btn.primary:hover { background: #eaf0ff; }
.btn.danger { border-color: rgba(255,143,143,.6); color: var(--coral); }
.btn:disabled { opacity: .55; cursor: default; }
.pill { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; background: rgba(255,255,255,.14); }
.pill.published { background: var(--mint); color: var(--mint-ink); }
.pill.draft { background: rgba(255,255,255,.14); }
.pill.hidden { background: var(--coral); color: var(--coral-ink); }
.steps-edit { display: grid; gap: 8px; }
.step-row { display: grid; grid-template-columns: 28px 1fr auto; gap: 8px; align-items: start; }
.step-row .n { padding-top: 12px; color: var(--muted-2); font-weight: 700; font-size: 13px; text-align: right; }
.step-row textarea { min-height: 58px; }
.step-row button { height: 42px; }
.signin { max-width: 520px; }
.signin p { color: var(--muted); line-height: 1.55; }
.g-wrap { margin: 14px 0; min-height: 44px; }
.me { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; }
.me .who { flex: 1; }
.me .who b { font-size: 18px; }
.me .who span { color: var(--muted-2); font-size: 14px; display: block; }
.stat-row { margin-bottom: 14px; }
@media (max-width: 720px) { .row2 { grid-template-columns: 1fr; } .item { grid-template-columns: 1fr; } .item .btns { justify-content: flex-start; } }
`;

const BODY = `
        <section class="hero">
          <div>
            <div class="eyebrow">Creator dashboard</div>
            <h1>Publish what works.</h1>
            <p class="lead">Write a workflow as problem, steps and result. It goes live the moment you publish. Ratings from other people build your reputation.</p>
          </div>
          <aside class="hero-aside" id="side-tip">
            <div class="k">What makes a good entry</div>
            <p>A title that names the outcome. Steps someone can follow without you. An honest result, including where it fails.</p>
            <a class="cta ghost full" href="/workflows">See the pool</a>
          </aside>
        </section>

        <div class="dash">
          <section class="panel signin" id="signin">
            <h2>Sign in to publish</h2>
            <p>Browsing and rating need no account. Publishing does, so every workflow has a durable owner. Sign in with Google; we keep your email private and show only the handle you choose.</p>
            <div class="g-wrap" id="google-button"></div>
            <div class="status" id="signin-status" aria-live="polite"></div>
          </section>

          <section class="panel hidden" id="claim">
            <h2>Choose your creator identity</h2>
            <p class="sub">This is what visitors see on every workflow you publish. The handle can be changed once every thirty days.</p>
            <form id="claim-form" class="form-stack" novalidate>
              <div class="row2">
                <div class="field" data-field="handle"><label for="c-handle">Handle <span>3 to 30 letters, numbers, underscore</span></label><input id="c-handle" name="handle" maxlength="30" autocomplete="off" placeholder="yourname" /><small>Your profile lives at builtwithmuse.com/creators/handle</small></div>
                <div class="field" data-field="display_name"><label for="c-name">Display name</label><input id="c-name" name="displayName" maxlength="60" placeholder="Your name" /></div>
              </div>
              <div class="field" data-field="bio"><label for="c-bio">Bio <span>optional, 400 characters</span></label><textarea id="c-bio" name="bio" maxlength="400" placeholder="What you use Muse for, in a sentence or two."></textarea></div>
              <div class="field" data-field="website"><label for="c-web">Website <span>optional</span></label><input id="c-web" name="websiteUrl" type="url" placeholder="https://" /></div>
              <div class="field"><label><input type="checkbox" id="c-avatar" checked style="width:auto;margin-right:8px" />Use my Google profile photo</label></div>
              <div class="actions"><button class="btn primary" type="submit">Create my profile</button><span class="status" id="claim-status" aria-live="polite"></span></div>
            </form>
          </section>

          <section class="panel hidden" id="home">
            <div class="me"><div class="avatar" id="me-avatar" style="width:56px;height:56px"></div><div class="who"><b id="me-name"></b><span id="me-handle"></span></div><div class="btns"><a class="btn" id="me-link" href="/creators/" target="_blank" rel="noopener">View profile</a><button class="btn" type="button" id="edit-profile">Edit profile</button><button class="btn" type="button" id="logout">Sign out</button></div></div>
            <div class="stat-row"><div class="stat"><b id="s-score">New</b><span>Score</span></div><div class="stat"><b id="s-ratings">0</b><span>Ratings</span></div><div class="stat"><b id="s-workflows">0</b><span>Published</span></div></div>
            <div class="actions" style="margin-bottom:18px"><button class="btn primary" type="button" id="new-workflow">New workflow</button><span class="status" id="home-status"></span></div>
            <h2 style="font-size:18px">Your workflows</h2>
            <div class="list" id="mine"></div>
          </section>

          <section class="panel hidden" id="profile">
            <h2>Edit profile</h2>
            <form id="profile-form" class="form-stack" novalidate>
              <div class="row2">
                <div class="field" data-field="handle"><label for="p-handle">Handle</label><input id="p-handle" name="handle" maxlength="30" autocomplete="off" /><small id="p-handle-note"></small></div>
                <div class="field" data-field="display_name"><label for="p-name">Display name</label><input id="p-name" name="displayName" maxlength="60" /></div>
              </div>
              <div class="field" data-field="bio"><label for="p-bio">Bio <span>400 characters</span></label><textarea id="p-bio" name="bio" maxlength="400"></textarea></div>
              <div class="row2">
                <div class="field" data-field="website"><label for="p-web">Website</label><input id="p-web" name="websiteUrl" type="url" placeholder="https://" /></div>
                <div class="field" data-field="avatar"><label for="p-avatar">Avatar image URL <span>https only</span></label><input id="p-avatar" name="avatarUrl" type="url" placeholder="https://" /></div>
              </div>
              <div class="row2">
                <div class="field" data-field="x"><label for="p-x">X profile <span>optional</span></label><input id="p-x" name="xUrl" type="url" placeholder="https://" /></div>
                <div class="field" data-field="youtube"><label for="p-yt">YouTube <span>optional</span></label><input id="p-yt" name="youtubeUrl" type="url" placeholder="https://" /></div>
              </div>
              <div class="row2">
                <div class="field" data-field="instagram"><label for="p-ig">Instagram <span>optional</span></label><input id="p-ig" name="instagramUrl" type="url" placeholder="https://" /></div>
                <div class="field" data-field="tiktok"><label for="p-tt">TikTok <span>optional</span></label><input id="p-tt" name="tiktokUrl" type="url" placeholder="https://" /></div>
              </div>
              <div class="actions"><button class="btn primary" type="submit">Save profile</button><button class="btn" type="button" data-back>Back</button><span class="status" id="profile-status" aria-live="polite"></span></div>
            </form>
            <details style="margin-top:22px"><summary style="cursor:pointer;color:var(--muted-2);font-weight:600">Deactivate account</summary>
              <p class="sub" style="margin-top:10px">Deactivating hides your profile and workflows from discovery and signs you out. Records and ratings are kept. A moderator can restore access.</p>
              <div class="actions"><input id="deactivate-confirm" placeholder="Type DEACTIVATE to confirm" style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.06);color:var(--ink)" /><button class="btn danger" type="button" id="deactivate">Deactivate</button></div>
            </details>
          </section>

          <section class="panel hidden" id="editor">
            <h2 id="editor-title">New workflow</h2>
            <p class="sub">Publishing is immediate. Drafts are only visible to you. Everything here can be edited later.</p>
            <form id="wf-form" class="form-stack" novalidate>
              <input type="hidden" name="id" />
              <div class="field" data-field="title"><label for="w-title">Title <span id="w-title-n">10 to 70 characters</span></label><input id="w-title" name="title" maxlength="70" placeholder="Turn a messy inbox into a daily action list" /></div>
              <div class="field" data-field="summary"><label for="w-summary">Summary <span id="w-summary-n">one sentence, 160 characters</span></label><input id="w-summary" name="summary" maxlength="160" placeholder="What the visitor will accomplish." /></div>
              <div class="row2">
                <div class="field" data-field="category"><label for="w-category">Category</label><select id="w-category" name="category"></select></div>
                <div class="field" data-field="proof_url"><label for="w-proof">Proof or source link <span>optional</span></label><input id="w-proof" name="proof_url" type="url" placeholder="https://" /></div>
              </div>
              <div class="field" data-field="tags"><label for="w-tags">Tags <span>optional, up to 5, comma separated</span></label><input id="w-tags" name="tags" maxlength="140" placeholder="productivity, email, planning" /></div>
              <div class="field" data-field="problem"><label for="w-problem">The problem <span>1000 characters</span></label><textarea id="w-problem" name="problem" maxlength="1000" placeholder="What is the person trying to do, and when is this useful?"></textarea></div>
              <div class="field" data-field="prerequisites"><label for="w-prereq">Before you start <span>optional, one per line</span></label><textarea id="w-prereq" name="prerequisites" placeholder="Muse connected to Instagram&#10;A saved recipe reel"></textarea></div>
              <div class="field" data-field="steps"><label>Steps <span>2 to 15, in order</span></label><div class="steps-edit" id="steps"></div><div><button class="btn" type="button" id="add-step">Add a step</button></div></div>
              <div class="field" data-field="prompt"><label for="w-prompt">Say this to Muse <span>optional, the exact prompt</span></label><textarea id="w-prompt" name="prompt" maxlength="1000"></textarea></div>
              <div class="field" data-field="result"><label for="w-result">The result <span>honest outcome, including limits</span></label><textarea id="w-result" name="result" maxlength="1000" placeholder="What to expect at the end, and where it falls short."></textarea></div>
              <div class="actions">
                <button class="btn primary" type="button" id="publish">Publish</button>
                <button class="btn" type="button" id="save-draft">Save draft</button>
                <button class="btn" type="button" id="unpublish">Unpublish</button>
                <button class="btn" type="button" data-back>Back</button>
                <span class="status" id="editor-status" aria-live="polite"></span>
              </div>
            </form>
          </section>
        </div>`;

const SCRIPT = `
      (() => {
        const $ = (id) => document.getElementById(id);
        const panels = ["signin", "claim", "home", "profile", "editor"];
        const show = (id) => panels.forEach((p) => $(p).classList.toggle("hidden", p !== id));
        const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
        let me = null, categories = [];
        const MESSAGES = {
          handle_invalid: "Handle: 3 to 30 letters, numbers or underscores.", handle_reserved: "That handle is reserved.", handle_taken: "That handle is taken.", handle_cooldown: "Handles can change once every thirty days.",
          display_name_short: "Display name is too short.", display_name_long: "Display name is too long.", bio_long: "Bio is too long.", website_invalid: "Website must start with http.", avatar_invalid: "Avatar must be an https image link.",
          x_invalid: "X link must start with http.", youtube_invalid: "YouTube link must start with http.", instagram_invalid: "Instagram link must start with http.", tiktok_invalid: "TikTok link must start with http.",
          title_short: "Title needs at least 10 characters.", title_long: "Title is over 70 characters.", summary_short: "Add a one sentence summary.", summary_long: "Summary is over 160 characters.",
          problem_short: "Describe the problem.", problem_long: "Problem is over 1000 characters.", result_short: "Describe the result.", result_long: "Result is over 1000 characters.",
          steps_few: "Add at least two steps.", steps_many: "At most fifteen steps.", steps_item_long: "A step is over 1000 characters.", prerequisites_many: "At most ten prerequisites.", prerequisites_item_long: "A prerequisite is over 200 characters.",
          prompt_long: "Prompt is over 1000 characters.", proof_url_invalid: "Proof link must start with http.", category_required: "Pick a category.", tag_invalid: "Tags must be 2 to 24 characters of letters, numbers and hyphens.",
          publish_limit: "You have hit today's publishing limit. Save it as a draft and publish tomorrow.", submissions_closed: "Publishing is closed right now.", too_many_workflows: "You have too many workflows. Remove some drafts first.",
          sign_in_required: "Please sign in again.", rate_limited: "Too many attempts. Wait a bit.", bad_token: "Google sign in failed. Try again.", account_deactivated: "This account is deactivated. Contact a moderator to restore it.", account_removed: "This account has been removed.",
        };
        const msg = (code) => MESSAGES[code] || "Something went wrong. Try again.";
        async function api(path, options = {}) {
          const r = await fetch(path, { method: options.method || "GET", credentials: "same-origin", headers: { "X-Requested-With": "fetch", ...(options.body ? { "Content-Type": "application/json" } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
          let d = null; try { d = await r.json(); } catch (_) { d = null; }
          if (!r.ok || !d || !d.ok) { const e = new Error((d && d.error) || String(r.status)); e.errors = (d && d.errors) || []; throw e; }
          return d;
        }
        const setStatus = (id, text, kind) => { const el = $(id); el.textContent = text; el.className = "status" + (kind ? " " + kind : ""); };
        const markFields = (form, errors) => { form.querySelectorAll(".field").forEach((f) => f.classList.remove("bad")); (errors || []).forEach((e) => { const f = form.querySelector('[data-field="' + e.split("_").slice(0, -1).join("_") + '"]') || form.querySelector('[data-field="' + e.replace(/_(short|long|few|many|invalid|required|item_long|reserved|taken|cooldown)$/, "") + '"]'); if (f) f.classList.add("bad"); }); };

        // ----- sign in -----
        fetch("/api/session", { method: "POST", credentials: "same-origin" }).catch(() => {});
        async function onCredential(response) {
          setStatus("signin-status", "Checking with Google");
          try {
            const r = await api("/api/v1/auth/google", { method: "POST", body: { credential: response.credential } });
            if (r.signedIn) return load();
            $("c-name").value = (r.suggested && r.suggested.name) || "";
            $("c-handle").value = (($("c-name").value || r.email.split("@")[0]).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")).slice(0, 30);
            setStatus("signin-status", "");
            show("claim");
          } catch (e) { setStatus("signin-status", msg(e.message), "err"); }
        }
        async function boot() {
          try {
            const config = await api("/api/v1/auth/config");
            categories = (await api("/api/v1/categories")).categories;
            $("w-category").innerHTML = '<option value="">Choose one</option>' + categories.map((c) => '<option value="' + esc(c.slug) + '">' + esc(c.name) + "</option>").join("");
            const ready = () => { if (!window.google || !google.accounts) return setTimeout(ready, 150); google.accounts.id.initialize({ client_id: config.clientId, callback: onCredential, ux_mode: "popup", auto_select: false }); google.accounts.id.renderButton($("google-button"), { theme: "outline", size: "large", text: "signin_with", shape: "pill" }); };
            ready();
            await load();
          } catch (e) { setStatus("signin-status", "Could not load. Reload the page.", "err"); }
        }
        async function load() {
          try {
            const d = await api("/api/v1/me");
            me = d;
            render();
            show("home");
          } catch (e) {
            if (e.message === "sign_in_required") { show("signin"); return; }
            setStatus("signin-status", msg(e.message), "err"); show("signin");
          }
        }
        function render() {
          const c = me.creator;
          $("me-name").textContent = c.displayName; $("me-handle").textContent = "@" + c.handle;
          $("me-avatar").innerHTML = c.avatarUrl ? '<img src="' + esc(c.avatarUrl) + '" alt="" referrerpolicy="no-referrer" />' : esc(c.displayName.split(/\\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase());
          $("me-link").href = "/creators/" + encodeURIComponent(c.handle);
          $("s-score").textContent = c.ratingCount ? c.weightedScore.toFixed(1) : "New"; $("s-ratings").textContent = c.ratingCount; $("s-workflows").textContent = c.workflowCount;
          if (c.needsHandle) setStatus("home-status", "You are signed in with an auto handle. Open your profile to pick your public handle.", "err");
          if (!me.submissionsOpen) setStatus("home-status", "Publishing is closed for now. Drafts still save.", "err");
          const list = $("mine");
          if (!me.workflows.length) { list.innerHTML = '<div class="empty">Nothing yet. Start with the workflow you run most.</div>'; return; }
          list.innerHTML = me.workflows.map((w) => {
            const state = w.hidden ? '<span class="pill hidden">Hidden</span>' : '<span class="pill ' + esc(w.status) + '">' + esc(w.status) + "</span>";
            const rating = w.ratingCount >= 3 ? w.average.toFixed(1) + " from " + w.ratingCount + " ratings" : w.ratingCount ? w.ratingCount + " rating" + (w.ratingCount === 1 ? "" : "s") : "No ratings yet";
            return '<div class="item"><div><h3>' + esc(w.title) + '</h3><div class="m">' + state + "<span>" + esc(rating) + "</span><span>Updated " + esc(new Date(w.updatedAt).toLocaleDateString()) + '</span></div></div><div class="btns">' + (w.status === "published" ? '<a class="btn" href="/workflows/' + esc(w.slug) + '" target="_blank" rel="noopener">View</a>' : "") + '<button class="btn" type="button" data-edit="' + esc(w.id) + '">Edit</button></div></div>';
          }).join("");
        }

        // ----- claim -----
        $("claim-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target; setStatus("claim-status", "Creating");
          try {
            await api("/api/v1/me/profile", { method: "POST", body: { handle: f.handle.value, displayName: f.displayName.value, bio: f.bio.value, websiteUrl: f.websiteUrl.value, useGoogleAvatar: $("c-avatar").checked } });
            await load();
          } catch (err) { markFields(f, err.errors.length ? err.errors : [err.message]); setStatus("claim-status", err.errors.length ? err.errors.map(msg).join(" ") : msg(err.message), "err"); }
        });

        // ----- profile -----
        $("edit-profile").addEventListener("click", () => {
          const c = me.creator;
          $("p-handle").value = c.handle; $("p-name").value = c.displayName; $("p-bio").value = c.bio || ""; $("p-web").value = c.websiteUrl || ""; $("p-avatar").value = c.avatarUrl || "";
          $("p-x").value = c.xUrl || ""; $("p-yt").value = c.youtubeUrl || ""; $("p-ig").value = c.instagramUrl || ""; $("p-tt").value = c.tiktokUrl || "";
          const changed = c.handleChangedAt ? new Date(c.handleChangedAt) : null;
          const wait = changed ? Math.ceil((changed.getTime() + 30 * 86400000 - Date.now()) / 86400000) : 0;
          $("p-handle-note").textContent = wait > 0 ? "Handle can change again in " + wait + " day" + (wait === 1 ? "" : "s") + "." : "Changing the handle changes your profile link.";
          setStatus("profile-status", ""); show("profile");
        });
        $("profile-form").addEventListener("submit", async (e) => {
          e.preventDefault(); const f = e.target; setStatus("profile-status", "Saving");
          try {
            await api("/api/v1/me/profile", { method: "PATCH", body: { handle: f.handle.value, displayName: f.displayName.value, bio: f.bio.value, websiteUrl: f.websiteUrl.value, avatarUrl: f.avatarUrl.value, xUrl: f.xUrl.value, youtubeUrl: f.youtubeUrl.value, instagramUrl: f.instagramUrl.value, tiktokUrl: f.tiktokUrl.value } });
            await load(); setStatus("home-status", "Profile saved.", "ok");
          } catch (err) { markFields(f, err.errors.length ? err.errors : [err.message]); setStatus("profile-status", err.errors.length ? err.errors.map(msg).join(" ") : msg(err.message), "err"); }
        });
        $("deactivate").addEventListener("click", async () => {
          if ($("deactivate-confirm").value.trim() !== "DEACTIVATE") { setStatus("profile-status", "Type DEACTIVATE to confirm.", "err"); return; }
          try { await api("/api/v1/me/deactivate", { method: "POST" }); me = null; show("signin"); setStatus("signin-status", "Your account is deactivated.", "ok"); } catch (err) { setStatus("profile-status", msg(err.message), "err"); }
        });
        $("logout").addEventListener("click", async () => { await api("/api/v1/auth/logout", { method: "POST" }).catch(() => {}); me = null; show("signin"); setStatus("signin-status", ""); });
        document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => { render(); show("home"); }));

        // ----- editor -----
        const stepsEl = $("steps");
        function addStep(value = "") {
          const row = document.createElement("div"); row.className = "step-row";
          row.innerHTML = '<span class="n"></span><textarea maxlength="1000" placeholder="One action, with enough detail to repeat it"></textarea><button class="btn" type="button" aria-label="Remove step">Remove</button>';
          row.querySelector("textarea").value = value;
          row.querySelector("button").addEventListener("click", () => { row.remove(); renumber(); });
          stepsEl.appendChild(row); renumber();
        }
        function renumber() { [...stepsEl.querySelectorAll(".n")].forEach((n, i) => { n.textContent = String(i + 1); }); }
        $("add-step").addEventListener("click", () => { if (stepsEl.children.length < 15) addStep(); });
        function fillEditor(w) {
          const f = $("wf-form");
          f.id.value = w ? w.id : ""; f.title.value = w ? w.title : ""; f.summary.value = w ? w.summary || "" : ""; f.category.value = w ? w.category || "" : ""; f.problem.value = w ? w.problem || "" : "";
          f.prerequisites.value = w ? (w.prerequisites || []).join("\\n") : ""; f.prompt.value = w ? w.prompt || "" : ""; f.result.value = w ? w.result || "" : ""; f.proof_url.value = w ? w.proof_url || "" : ""; f.tags.value = w ? (w.tags || []).join(", ") : "";
          stepsEl.innerHTML = ""; (w && w.steps && w.steps.length ? w.steps : ["", ""]).forEach((s) => addStep(typeof s === "string" ? s : s.body));
          $("editor-title").textContent = w ? "Edit workflow" : "New workflow";
          $("publish").textContent = w && w.status === "published" ? "Save and keep published" : "Publish";
          $("save-draft").classList.toggle("hidden", Boolean(w && w.status === "published"));
          $("unpublish").classList.toggle("hidden", !(w && w.status === "published"));
          f.querySelectorAll(".field").forEach((x) => x.classList.remove("bad")); setStatus("editor-status", "");
          counters();
        }
        function counters() { $("w-title-n").textContent = $("w-title").value.length + " of 70"; $("w-summary-n").textContent = $("w-summary").value.length + " of 160"; }
        $("w-title").addEventListener("input", counters); $("w-summary").addEventListener("input", counters);
        function readEditor() {
          const f = $("wf-form");
          return { title: f.title.value, summary: f.summary.value, category: f.category.value, problem: f.problem.value, prerequisites: f.prerequisites.value.split("\\n").map((s) => s.trim()).filter(Boolean), steps: [...stepsEl.querySelectorAll("textarea")].map((t) => t.value.trim()).filter(Boolean), prompt: f.prompt.value, result: f.result.value, proof_url: f.proof_url.value, tags: f.tags.value };
        }
        $("new-workflow").addEventListener("click", () => { fillEditor(null); show("editor"); window.scrollTo({ top: 0 }); });
        $("mine").addEventListener("click", async (e) => {
          const b = e.target.closest("[data-edit]"); if (!b) return;
          try { const d = await api("/api/v1/me/workflows/" + b.dataset.edit); fillEditor(d.workflow); show("editor"); window.scrollTo({ top: 0 }); } catch (err) { setStatus("home-status", msg(err.message), "err"); }
        });
        async function save(publish) {
          const f = $("wf-form"); const body = readEditor(); const id = f.id.value;
          setStatus("editor-status", publish ? "Publishing" : "Saving");
          [$("publish"), $("save-draft")].forEach((b) => { b.disabled = true; });
          try {
            let d;
            if (!id) { d = await api("/api/v1/workflows", { method: "POST", body: { ...body, publish } }); f.id.value = d.id; if (publish) { await load(); setStatus("home-status", "Published. It is live at /workflows/" + d.slug, "ok"); return; } }
            else { d = await api("/api/v1/workflows/" + id, { method: "PATCH", body }); if (publish) { await api("/api/v1/workflows/" + id + "/publish", { method: "POST" }); await load(); setStatus("home-status", "Published.", "ok"); return; } }
            setStatus("editor-status", "Draft saved.", "ok"); $("editor-title").textContent = "Edit workflow";
          } catch (err) { markFields(f, err.errors.length ? err.errors : []); setStatus("editor-status", err.errors.length ? err.errors.map(msg).join(" ") : msg(err.message), "err"); }
          finally { [$("publish"), $("save-draft")].forEach((b) => { b.disabled = false; }); }
        }
        $("publish").addEventListener("click", () => save(true));
        $("save-draft").addEventListener("click", () => save(false));
        $("unpublish").addEventListener("click", async () => {
          const id = $("wf-form").id.value; if (!id) return;
          try { await api("/api/v1/workflows/" + id + "/unpublish", { method: "POST" }); await load(); setStatus("home-status", "Unpublished. Ratings are kept.", "ok"); } catch (err) { setStatus("editor-status", msg(err.message), "err"); }
        });

        boot();
      })();`;

function dashboardPage() {
  return layout({
    title: "Creator dashboard | Built with Muse",
    description: "Publish Muse workflows under your own name and build a reputation from community ratings.",
    path: "/creator", current: "/creator", noindex: true, body: BODY, extraCss: CSS, script: SCRIPT,
  }).replace("</head>", '    <script src="https://accounts.google.com/gsi/client" async defer></script>\n  </head>');
}

module.exports = { dashboardPage };
