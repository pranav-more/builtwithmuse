// Counts this page load for the retention numbers in /admin. The server
// keeps one row per anonymous device per day, so repeat loads cost nothing.
fetch("/api/session", { method: "POST", credentials: "same-origin" }).catch(function () {});
