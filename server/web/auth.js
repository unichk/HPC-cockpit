// Session handling shared by every cockpit page.
//
// The server redirects a page load without a session to login.html, but a
// page that is already open keeps polling the API after its session expires
// (12 h, or a server restart). Any 401 from our own API therefore sends the
// browser back to the login page, returning here afterwards.
(function () {
  const realFetch = window.fetch.bind(window);
  let redirecting = false;

  function toLogin() {
    if (redirecting) return;
    redirecting = true;
    const next = window.location.pathname + window.location.search;
    window.location.href = "login.html?next=" + encodeURIComponent(next);
  }

  window.fetch = async function (input, init) {
    const resp = await realFetch(input, init);
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const sameOrigin = !/^https?:\/\//i.test(url) || url.startsWith(window.location.origin);
    if (resp.status === 401 && sameOrigin && url.includes("/api/") && !url.includes("/api/login")) {
      toLogin();
    }
    return resp;
  };

  window.cockpitAuth = {
    // {user, auth}; user is null when the server runs with --no-auth.
    me: async function () {
      try {
        const r = await realFetch("/api/me", { cache: "no-store" });
        return r.ok ? await r.json() : { user: null, auth: true };
      } catch {
        return { user: null, auth: true };
      }
    },
    logout: async function () {
      try {
        await realFetch("/api/logout", { method: "POST" });
      } catch {}
      window.location.href = "login.html";
    },
  };
})();
