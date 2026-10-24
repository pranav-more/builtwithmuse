// Counts this page load for the retention numbers in /admin. The server
// keeps one row per anonymous device per day, so repeat loads cost nothing.
fetch("/api/session", { method: "POST", credentials: "same-origin" }).catch(function () {});

// Clicks toward /sponsor from this page, for the sponsor funnel in /admin.
document.addEventListener("click", function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a[href="/sponsor"]') : null;
  if (!a || location.pathname === "/sponsor") {
    return;
  }
  try {
    fetch("/api/sponsors/event", { method: "POST", keepalive: true, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "cta", cta: "link", page: location.pathname }) });
  } catch (_) {}
});
