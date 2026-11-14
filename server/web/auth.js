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

  // The one log-out button every page puts in its top bar: <cockpitAuth.LogoutButton />.
  // Renders nothing with --no-auth (no user). React is looked up at render
  // time, so this file can load before React does.
  let mePromise = null;
  window.cockpitAuth.LogoutButton = function LogoutButton() {
    const h = React.createElement;
    const [user, setUser] = React.useState(null);
    React.useEffect(() => {
      mePromise = mePromise || window.cockpitAuth.me();
      let alive = true;
      mePromise.then((m) => { if (alive) setUser(m && m.user); });
      return () => { alive = false; };
    }, []);
    if (!user) return null;
    return h("button", {
      className: "icon-btn", title: "Log out " + user,
      onClick: () => window.cockpitAuth.logout(),
    }, h("svg", {
      width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
    },
      h("path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }),
      h("polyline", { points: "16 17 21 12 16 7" }),
      h("line", { x1: 21, y1: 12, x2: 9, y2: 12 })));
  };
})();
