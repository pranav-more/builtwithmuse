/* Blog post thumbs up / thumbs down rating. Auto-injects after the article. */
(function () {
  var m = location.pathname.match(/^\/blog\/([a-z0-9-]+)\/?$/);
  if (!m) return;
  var slug = m[1];
  var article = document.querySelector("article");
  if (!article) return;

  // Theme (batch 29): inline styles cannot read CSS variables, so the poll
  // picks its colors from the data-theme attribute the head script set.
  // A toggle after load re-themes the poll on the next page view.
  var dark = document.documentElement.getAttribute("data-theme") === "dark";
  var cLine = dark ? "rgba(255,255,255,.22)" : "#dfe5f3";
  var cBox = dark ? "#12234d" : "#ffffff";
  var cShadow = dark ? "0 30px 60px rgba(0,0,0,.35)" : "0 8px 24px rgba(11,18,32,.06)";
  var cInk = dark ? "#ffffff" : "#0b1220";
  var cMuted = dark ? "#c7d6ff" : "#4b5675";
  var cMuted2 = dark ? "#9fb6ff" : "#6b7699";
  var cBtn = dark ? "#16295a" : "#f8fafe";
  var cVotedBg = dark ? "#1d3469" : "#eef3ff";
  var cVotedInk = dark ? "#9db8ff" : "#0f3fc4";
  var box = document.createElement("div");
  box.id = "blog-rating";
  box.setAttribute("style", "margin:28px 0 0;padding:26px 22px;border:1px solid " + cLine + ";border-radius:10px;background:" + cBox + ";text-align:center;box-shadow:" + cShadow + ";");
  box.innerHTML =
    '<div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:' + cMuted2 + ';margin-bottom:8px;">Quick poll</div>' +
    '<div style="font-family:Archivo,sans-serif;font-weight:800;color:' + cInk + ';font-size:20px;letter-spacing:-.02em;margin-bottom:6px;">Was this guide helpful?</div>' +
    '<div style="color:' + cMuted + ';font-size:14px;margin-bottom:16px;">Your vote helps other readers find the good stuff.</div>' +
    '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">' +
    '<button type="button" data-vote="1" aria-label="Yes, this was helpful" style="cursor:pointer;border:1px solid ' + cLine + ';border-radius:999px;background:' + cBtn + ';color:' + cInk + ';font-size:15px;font-weight:700;padding:10px 22px;">&#128077; <span data-count="up">0</span></button>' +
    '<button type="button" data-vote="-1" aria-label="No, this was not helpful" style="cursor:pointer;border:1px solid ' + cLine + ';border-radius:999px;background:' + cBtn + ';color:' + cInk + ';font-size:15px;font-weight:700;padding:10px 22px;">&#128078; <span data-count="down">0</span></button>' +
    "</div>" +
    '<div data-msg style="color:#1a56ff;font-size:13px;margin-top:12px;min-height:18px;"></div>';
  article.insertAdjacentElement("beforeend", box);

  var upBtn = box.querySelector('[data-vote="1"]');
  var downBtn = box.querySelector('[data-vote="-1"]');
  var msg = box.querySelector("[data-msg]");
  var baseBtn = "cursor:pointer;border:1px solid " + cLine + ";border-radius:999px;background:" + cBtn + ";color:" + cInk + ";font-size:15px;font-weight:700;padding:10px 22px;";
  var votedBtn = "cursor:pointer;border:1px solid #1a56ff;border-radius:999px;background:" + cVotedBg + ";color:" + cVotedInk + ";font-size:15px;font-weight:700;padding:10px 22px;";

  function paint(up, down, userVote) {
    box.querySelector('[data-count="up"]').textContent = up;
    box.querySelector('[data-count="down"]').textContent = down;
    upBtn.setAttribute("style", userVote === 1 ? votedBtn : baseBtn);
    downBtn.setAttribute("style", userVote === -1 ? votedBtn : baseBtn);
  }

  function load() {
    fetch("/api/blog/ratings?slug=" + encodeURIComponent(slug), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) paint(d.up, d.down, d.userVote); })
      .catch(function () {});
  }

  function vote(v) {
    upBtn.disabled = true;
    downBtn.disabled = true;
    fetch("/api/blog/rate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: slug, vote: v })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          paint(d.up, d.down, d.userVote);
          msg.textContent = "Thanks for voting.";
        } else {
          msg.textContent = "Could not save your vote. Try again.";
        }
      })
      .catch(function () { msg.textContent = "Could not save your vote. Try again."; })
      .finally(function () { upBtn.disabled = false; downBtn.disabled = false; });
  }

  upBtn.addEventListener("click", function () { vote(1); });
  downBtn.addEventListener("click", function () { vote(-1); });
  load();
})();
