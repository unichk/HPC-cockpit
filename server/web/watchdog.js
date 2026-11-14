// Power watchdog mode, shared by every cockpit page.
//
// - Polls /api/watchdog and, while the watchdog is armed, frames the whole
//   window and shows a status bar at the bottom, so nobody can miss that it
//   is on. Over the limit, both turn red.
// - <cockpitWatchdog.Button /> goes in a page's top bar (next to the log-out
//   button) and opens the panel to arm/disarm it and set the power limit.
//
// The server does the actual checking; what it does when the limit is
// exceeded is still a placeholder (see Watchdog.on_limit_exceeded).
(function () {
  const POLL_MS = 3000;
  let state = null;
  let unavailable = false;  // server has no /api/watchdog (older build, needs a restart)
  const listeners = new Set();

  const css = `
    :root { --wd: #1d9bb8; --wd-soft: rgba(29, 155, 184, 0.14); }
    [data-theme="dark"] { --wd: #3cc3e0; --wd-soft: rgba(60, 195, 224, 0.16); }
    .wd-frame { position: fixed; inset: 0; pointer-events: none; z-index: 9998; border: 4px solid var(--wd);
      box-shadow: inset 0 0 24px var(--wd-soft); animation: wd-breathe 2.4s ease-in-out infinite; display: none; }
    .wd-frame.tripped { border-color: var(--crit); box-shadow: inset 0 0 40px color-mix(in srgb, var(--crit) 35%, transparent);
      animation: wd-alarm 0.9s ease-in-out infinite; }
    @keyframes wd-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
    @keyframes wd-alarm { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    @media (prefers-reduced-motion: reduce) { .wd-frame { animation: none !important; } }

    .wd-bar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 9999; display: none;
      align-items: center; gap: 12px; padding: 8px 10px 8px 14px; border-radius: 999px; background: var(--wd); color: #fff;
      font-family: var(--font); font-size: 12.5px; font-weight: 700; box-shadow: 0 6px 24px rgba(0,0,0,0.22); white-space: nowrap; max-width: calc(100vw - 24px); }
    .wd-bar.tripped { background: var(--crit); }
    .wd-bar-title { letter-spacing: 0.08em; text-transform: uppercase; font-weight: 800; display: inline-flex; align-items: center; gap: 7px; }
    .wd-bar-meter { width: 120px; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.3); overflow: hidden; flex-shrink: 0; }
    .wd-bar-fill { height: 100%; background: #fff; border-radius: 3px; transition: width 400ms; }
    .wd-bar-num { font-variant-numeric: tabular-nums; }
    .wd-bar-btn { font: inherit; font-size: 11px; font-weight: 800; color: inherit; background: rgba(255,255,255,0.2);
      border: 1px solid rgba(255,255,255,0.45); border-radius: 999px; padding: 3px 10px; cursor: pointer; }
    .wd-bar-btn:hover { background: rgba(255,255,255,0.32); }
    html.wd-on .wd-frame, html.wd-on .wd-bar { display: flex; }
    html.wd-on .wd-frame { display: block; }
    html.wd-on body { padding-bottom: 56px; }

    .icon-btn.wd-armed { background: var(--wd); color: #fff; border-color: var(--wd); }
    .icon-btn.wd-armed.wd-tripped { background: var(--crit); border-color: var(--crit); }

    .wd-panel-backdrop { position: fixed; inset: 0; z-index: 10000; background: rgba(20, 10, 30, 0.35); display: grid; place-items: center; padding: 16px; }
    .wd-panel { width: min(400px, 100%); background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3); font-family: var(--font); overflow: hidden; }
    .wd-panel-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid var(--line-2); }
    .wd-panel-icon { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: var(--wd-soft); color: var(--wd); }
    .wd-panel-title { font-size: 15px; font-weight: 800; }
    .wd-panel-sub { font-size: 11.5px; color: var(--muted); font-weight: 600; }
    .wd-panel-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
    .wd-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .wd-label { font-size: 12.5px; font-weight: 700; }
    .wd-hint { font-size: 11px; color: var(--muted); font-weight: 600; margin-top: 2px; }
    .wd-switch { position: relative; width: 46px; height: 26px; border-radius: 999px; border: none; background: var(--line); cursor: pointer; flex-shrink: 0; transition: background 150ms; }
    .wd-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.25); transition: left 150ms; }
    .wd-switch[aria-checked="true"] { background: var(--wd); }
    .wd-switch[aria-checked="true"]::after { left: 23px; }
    .wd-input { display: flex; align-items: center; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-2); overflow: hidden; }
    .wd-input input { width: 100px; font: inherit; font-size: 14px; font-weight: 700; color: var(--ink); background: transparent; border: none; padding: 7px 10px; text-align: right; font-variant-numeric: tabular-nums; }
    .wd-input input:focus { outline: none; }
    .wd-input:focus-within { border-color: var(--wd); box-shadow: 0 0 0 3px var(--wd-soft); }
    .wd-input span { padding: 0 10px 0 2px; font-size: 12px; font-weight: 700; color: var(--muted); }
    .wd-now { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); font-variant-numeric: tabular-nums; }
    .wd-placeholder { font-size: 11px; color: var(--muted); font-weight: 600; padding: 8px 10px; border-radius: 8px; border: 1px dashed var(--line); }
    .wd-error { font-size: 12px; color: var(--crit); font-weight: 700; }
    .wd-panel-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--line-2); background: var(--surface-2); }
    .wd-btn { font: inherit; font-size: 12.5px; font-weight: 700; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
    .wd-btn.primary { background: var(--wd); border-color: var(--wd); color: #fff; }
    .wd-btn:disabled { opacity: 0.6; cursor: wait; }
  `;

  const SHIELD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M13 7l-3 5h4l-3 5"/></svg>';

  const kw = (w) => w == null ? "–" : (w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`);

  let frame, bar;
  function mount() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    frame = document.createElement("div");
    frame.className = "wd-frame";
    bar = document.createElement("div");
    bar.className = "wd-bar";
    bar.setAttribute("role", "status");
    document.body.appendChild(frame);
    document.body.appendChild(bar);
    render();
  }

  function render() {
    const on = !!(state && state.enabled);
    const tripped = on && state.exceeded;
    document.documentElement.classList.toggle("wd-on", on);
    if (!frame) return;
    frame.classList.toggle("tripped", tripped);
    bar.classList.toggle("tripped", tripped);
    if (!on) { bar.innerHTML = ""; return; }
    const pct = state.total_w == null ? 0 : Math.min(100, (100 * state.total_w) / state.limit_w);
    bar.innerHTML =
      `<span class="wd-bar-title">${SHIELD}${tripped ? "Power limit exceeded" : "Watchdog armed"}</span>` +
      `<span class="wd-bar-meter"><span class="wd-bar-fill" style="width:${pct.toFixed(1)}%;display:block"></span></span>` +
      `<span class="wd-bar-num">${kw(state.total_w)} / ${kw(state.limit_w)}</span>` +
      `<button class="wd-bar-btn" type="button">Settings</button>`;
    bar.querySelector("button").onclick = openPanel;
  }

  async function poll() {
    try {
      const r = await fetch("/api/watchdog", { cache: "no-store" });
      const isJson = (r.headers.get("content-type") || "").includes("json");
      unavailable = r.status === 404 || (r.ok && !isJson);
      if (r.ok && isJson) {
        state = await r.json();
        render();
        listeners.forEach((fn) => fn(state));
      }
    } catch {}
  }

  async function save(patch) {
    const r = await fetch("/api/watchdog", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    state = body;
    render();
    listeners.forEach((fn) => fn(state));
  }

  function openPanel() {
    if (document.querySelector(".wd-panel-backdrop")) return;
    const s = state || { enabled: false, limit_w: 10000 };
    let enabled = !!s.enabled;
    const back = document.createElement("div");
    back.className = "wd-panel-backdrop";
    back.innerHTML = `
      <div class="wd-panel" role="dialog" aria-modal="true" aria-label="Power watchdog">
        <div class="wd-panel-head">
          <div class="wd-panel-icon">${SHIELD}</div>
          <div><div class="wd-panel-title">Power watchdog</div>
          <div class="wd-panel-sub">Checks total cluster power every 5 s</div></div>
        </div>
        <div class="wd-panel-body">
          <div class="wd-row">
            <div><div class="wd-label">Watchdog mode</div><div class="wd-hint">Armed for everyone using the cockpit</div></div>
            <button class="wd-switch" type="button" role="switch" aria-checked="${enabled}" aria-label="Watchdog mode"></button>
          </div>
          <div class="wd-row">
            <div><div class="wd-label">Power limit</div><div class="wd-hint">Nodes + IB switch, combined</div></div>
            <label class="wd-input"><input type="number" min="100" max="100000" step="50" value="${Math.round(s.limit_w)}" /><span>W</span></label>
          </div>
          <div class="wd-now"><span>Current cluster power</span><span>${
            unavailable ? "unavailable"
            : !state ? "loading…"
            : s.total_w == null ? "no node power readings"
            : `${kw(s.total_w)} · ${s.nodes_counted} node${s.nodes_counted === 1 ? "" : "s"}`}</span></div>
          ${unavailable ? '<div class="wd-error">The cockpit server does not have the watchdog yet. Restart server.py to enable it.</div>' : ""}
          <div class="wd-placeholder">When the limit is exceeded: <b>no action yet</b> (placeholder). The server only logs it for now.</div>
          <div class="wd-error" hidden></div>
        </div>
        <div class="wd-panel-foot">
          <button class="wd-btn" type="button" data-act="cancel">Cancel</button>
          <button class="wd-btn primary" type="button" data-act="save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const sw = back.querySelector(".wd-switch");
    const input = back.querySelector("input");
    const err = back.querySelector(".wd-error");
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
    sw.onclick = () => { enabled = !enabled; sw.setAttribute("aria-checked", String(enabled)); };
    back.querySelector('[data-act="cancel"]').onclick = close;
    const saveBtn = back.querySelector('[data-act="save"]');
    saveBtn.onclick = async () => {
      const limit = Number(input.value);
      if (!Number.isFinite(limit) || limit < 100 || limit > 100000) {
        err.textContent = "Power limit must be between 100 and 100000 W.";
        err.hidden = false;
        return;
      }
      saveBtn.disabled = true;
      try {
        await save({ enabled, limit_w: limit });
        close();
      } catch (e) {
        err.textContent = String(e.message || e);
        err.hidden = false;
        saveBtn.disabled = false;
      }
    };
    input.focus();
  }

  // Top-bar button. React is looked up at render time, so this file can load first.
  function WatchdogButton() {
    const h = React.createElement;
    const [s, setS] = React.useState(state);
    React.useEffect(() => { listeners.add(setS); return () => listeners.delete(setS); }, []);
    const on = !!(s && s.enabled);
    const tripped = on && s.exceeded;
    return h("button", {
      className: `icon-btn ${on ? "wd-armed" : ""} ${tripped ? "wd-tripped" : ""}`,
      title: on ? `Watchdog armed · limit ${kw(s.limit_w)}` : "Power watchdog (off)",
      onClick: openPanel,
      dangerouslySetInnerHTML: { __html: SHIELD },
    });
  }

  window.cockpitWatchdog = { Button: WatchdogButton, open: openPanel, get: () => state };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
  poll();
  setInterval(poll, POLL_MS);
})();
