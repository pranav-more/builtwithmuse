/* Blog post thumbs up / thumbs down rating. Auto-injects after the article. */
(function () {
  var m = location.pathname.match(/^\/blog\/([a-z0-9-]+)\/?$/);
  if (!m) return;
  var slug = m[1];
  var article = document.querySelector("article");
  if (!article) return;

  var box = document.createElement("div");
  box.id = "blog-rating";
  box.setAttribute("style", "margin:28px 0 0;padding:22px;border:1px solid rgba(255,255,255,.22);border-radius:10px;background:rgba(6,16,48,.6);text-align:center;");
  box.innerHTML =
    '<div style="font-weight:700;color:#fff;font-size:17px;margin-bottom:4px;">Was this guide helpful?</div>' +
    '<div style="color:#9fb6ff;font-size:14px;margin-bottom:14px;">Your vote helps other readers find the good stuff.</div>' +
    '<div style="display:flex;gap:12px;justify-content:center;">' +
    '<button type="button" data-vote="1" aria-label="Thumbs up" style="cursor:pointer;border:1px solid rgba(255,255,255,.22);border-radius:8px;background:rgba(255,255,255,.08);color:#fff;font-size:15px;font-weight:700;padding:10px 18px;">&#128077; <span data-count="up">0</span></button>' +
    '<button type="button" data-vote="-1" aria-label="Thumbs down" style="cursor:pointer;border:1px solid rgba(255,255,255,.22);border-radius:8px;background:rgba(255,255,255,.08);color:#fff;font-size:15px;font-weight:700;padding:10px 18px;">&#128078; <span data-count="down">0</span></button>' +
    "</div>" +
    '<div data-msg style="color:#7dffc6;font-size:13px;margin-top:10px;min-height:18px;"></div>';
  article.insertAdjacentElement("afterend", box);

  var upBtn = box.querySelector('[data-vote="1"]');
  var downBtn = box.querySelector('[data-vote="-1"]');
  var msg = box.querySelector("[data-msg]");
  var baseBtn = "cursor:pointer;border:1px solid rgba(255,255,255,.22);border-radius:8px;background:rgba(255,255,255,.08);color:#fff;font-size:15px;font-weight:700;padding:10px 18px;";
  var votedBtn = baseBtn + "border-color:#7dffc6;background:rgba(125,255,198,.15);";

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
