// Main dashboard app.

const { useState, useEffect, useRef } = React;

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function DEFAULT_SETTINGS() {
  return {
    theme: "light",
    ganttStartH: 0,
    ganttEndH: 24,
    visibleMetrics: { cpu: true, mem: true, swap: true, load: true, temp: true, fan: true },
    alerts: { ...window.DEFAULT_THRESHOLDS },
    groupAlerts: {
      idle:  { nodePowerWarn:  300, nodePowerHot:  500 },
      login: { nodePowerWarn:  500, nodePowerHot:  800 },
      cpu:   { nodePowerWarn: 1700, nodePowerHot: 1900 },
      gpu:   { nodePowerWarn: 2200, nodePowerHot: 2500 },
    },
    nodeGroups: {},
    modes: [],
    alarms: {
      enabled: true,
      volume: 0.7,
      repeat: false,
      warnSound: "sounds/warn.mp3",
      critSound: "sounds/crit.mp3",
    },
  };
}

function mergeSettings(parsed) {
  const d = DEFAULT_SETTINGS();
  if (!parsed || typeof parsed !== "object") return d;
  const ga = { ...d.groupAlerts };
  for (const g of Object.keys(ga)) {
    ga[g] = { ...ga[g], ...((parsed.groupAlerts || {})[g] || {}) };
  }
  return {
    ...d,
    ...parsed,
    alerts: { ...d.alerts, ...(parsed.alerts || {}) },
    visibleMetrics: { ...d.visibleMetrics, ...(parsed.visibleMetrics || {}) },
    groupAlerts: ga,
    nodeGroups: { ...(parsed.nodeGroups || {}) },
    modes: Array.isArray(parsed.modes) ? parsed.modes.map(m => ({
      id: String(m?.id ?? `mode-${Math.random().toString(36).slice(2, 8)}`),
      name: String(m?.name ?? "Untitled mode"),
      groups: (m && typeof m.groups === "object" && m.groups) ? { ...m.groups } : {},
    })) : [],
    alarms: { ...d.alarms, ...(parsed.alarms || {}) },
  };
}

// Shallow-equal two {nodeId: groupName} maps. Used to decide which saved mode
// (if any) matches the live nodeGroups so the dashboard picker can highlight
// it. Empty-string and missing keys are treated as "unset".
function modesEqual(a, b) {
  const A = a || {}, B = b || {};
  const ak = Object.keys(A).filter(k => A[k]);
  const bk = Object.keys(B).filter(k => B[k]);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (A[k] !== B[k]) return false;
  return true;
}

// True only when status `b` is strictly worse than `a`. De-escalations and
// same-state ticks are silent.
function alarmEscalated(a, b) {
  const rank = { ok: 0, warn: 1, crit: 2, "crit-offline": 2 };
  return (rank[b] ?? 0) > (rank[a] ?? 0);
}

function App() {
  // Seed from cache so the first paint isn't unstyled, then refresh from
  // the server in an effect.
  const [settings, setSettings] = useState(() => mergeSettings(window.readCachedSettings()));
  const [hydrated, setHydrated] = useState(false);
  const [nodes, setNodes] = useState(() => window.initNodes());
  const [events, setEvents] = useState([]);
  const [dayOffset, setDayOffset] = useState(0);
  const thresholds = { ...window.DEFAULT_THRESHOLDS, ...(settings.alerts || {}) };
  const now = useClock();

  // Audio-alarm bookkeeping. priorStatus tracks per-node classification across
  // ticks so we can detect ok→warn / warn→crit transitions; settingsRef gives
  // the live-feed callback (which captures the initial settings closure) access
  // to current values without re-binding. clusterLevel + snoozedLevel drive the
  // warn 30s cadence and the crit-while-active loop, plus the topbar Snooze.
  const priorStatusRef = useRef(new Map());
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const [clusterLevel, setClusterLevel] = useState("ok");  // "ok"|"warn"|"crit"
  const [snoozedLevel, setSnoozedLevel] = useState(null);  // null|"warn"|"crit"
  const clusterLevelRef = useRef("ok");
  const snoozedLevelRef = useRef(null);
  useEffect(() => { clusterLevelRef.current = clusterLevel; }, [clusterLevel]);
  useEffect(() => { snoozedLevelRef.current = snoozedLevel; }, [snoozedLevel]);

  // Helpers used by both the live-feed callback and the warn-repeat interval.
  const levelRank = { ok: 0, warn: 1, crit: 2 };
  const isSnoozed = (level) => {
    const sn = snoozedLevelRef.current;
    return sn != null && (levelRank[level] ?? 0) <= (levelRank[sn] ?? 0);
  };

  // First-load hydrate from server (which also primes localStorage).
  useEffect(() => {
    let cancelled = false;
    window.loadSettings().then(s => {
      if (!cancelled && s) setSettings(mergeSettings(s));
      if (!cancelled) setHydrated(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    // Skip writing back the server-hydrated value verbatim — only persist
    // edits made in this session.
    if (hydrated) window.saveSettings(settings);
  }, [settings, hydrated]);

  useEffect(() => {
    function consumeNodes(next) {
      setNodes(next);
      const s = settingsRef.current;
      const baseThr = { ...window.DEFAULT_THRESHOLDS, ...(s.alerts || {}) };
      const classify = (n) => window.classifyNode(n, window.nodeThresholds(n.id, s, baseThr));
      const alarms = s.alarms || {};
      const A = window.cockpitAlarms;

      // First tick after mount: seed baseline only, never fire — opening the
      // dashboard during an ongoing crit shouldn't blast on page load.
      const firstTick = priorStatusRef.current.size === 0;

      // Compute per-node statuses + the cluster max (worst across all nodes).
      let escalatedTo = null;  // any escalation this tick: "warn"|"crit"
      let clusterMax = "ok";   // worst current state across all nodes
      next.forEach(n => {
        const cur = classify(n);
        const norm = (cur === "crit-offline") ? "crit" : cur;
        const before = priorStatusRef.current.get(n.id) || "ok";
        if (!firstTick && alarmEscalated(before, cur)) {
          if (norm === "crit") escalatedTo = "crit";
          else if (norm === "warn" && escalatedTo !== "crit") escalatedTo = "warn";
        }
        priorStatusRef.current.set(n.id, cur);
        if ((levelRank[norm] ?? 0) > (levelRank[clusterMax] ?? 0)) clusterMax = norm;
      });

      // Surface the cluster level to React state (drives Snooze button visibility
      // and labels) — only set if changed, to avoid render thrash.
      if (clusterMax !== clusterLevelRef.current) setClusterLevel(clusterMax);

      // De-escalation auto-clears Snooze: if everything's now <= a lower tier,
      // the snooze for the higher tier is no longer relevant.
      const sn = snoozedLevelRef.current;
      if (sn && (levelRank[clusterMax] ?? 0) < (levelRank[sn] ?? 0)) setSnoozedLevel(null);

      if (firstTick || !A) return;

      // Crit handling: while any node is crit and not snoozed at crit, the
      // crit clip loops continuously. Stop the loop the moment crit clears.
      if (clusterMax === "crit" && !isSnoozed("crit")) {
        // Fire a one-shot too if this tick is the actual escalation moment
        // — gives an immediate cue even if loop start is gated by autoplay.
        if (escalatedTo === "crit") A.fireAlarm("crit", alarms);
        A.startCritLoop(alarms);
      } else {
        A.stopCritLoop();
      }

      // Warn one-shot fires only on the transition; the 30s repeat is handled
      // by a separate setInterval below.
      if (escalatedTo === "warn" && clusterMax !== "crit" && !isSnoozed("warn")) {
        A.fireAlarm("warn", alarms);
      }
    }
    return window.startLiveNodeFeed(consumeNodes);
  }, []);

  // Warn repeat: every 30 s, while the cluster is warn-only and not snoozed,
  // re-fire the warn cue. (Crit handles its own continuous loop.)
  useEffect(() => {
    if (!settings.alarms?.enabled) return;
    const handle = setInterval(() => {
      const lvl = clusterLevelRef.current;
      if (lvl === "warn" && !isSnoozed("warn")) {
        window.cockpitAlarms?.fireAlarm("warn", settingsRef.current.alarms || {});
      }
    }, 30000);
    return () => clearInterval(handle);
  }, [settings.alarms?.enabled]);

  // When alarms get disabled (mute toggle, or whole feature off) make sure the
  // crit loop isn't still droning on.
  useEffect(() => {
    if (!settings.alarms?.enabled) window.cockpitAlarms?.stopCritLoop();
  }, [settings.alarms?.enabled]);

  // Prime the audio cache on every user gesture (Chrome/Safari autoplay).
  // primeAudio is idempotent once each element is unlocked, so re-running on
  // every click is cheap and far more forgiving than a once-only first-click
  // listener that competes with React's synthetic event system.
  useEffect(() => {
    function onClick() {
      window.cockpitAlarms?.primeAudio(settingsRef.current.alarms || {});
    }
    window.addEventListener("click", onClick, true);  // capture phase, before stopPropagation
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/schedule", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && Array.isArray(data.events)) setEvents(data.events);
      } catch (err) {
        console.warn("schedule load failed", err);
      }
    };
    load();
    const handle = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  // Row sizing: N<=4 fills the screen; N>4 fixes 4-row height and allows scroll.
  const rootStyleRef = useRef(null);
  useEffect(() => {
    const n = Math.max(1, nodes.length);
    // Subtract the chrome (topbar + footer + .app vertical padding + row-gaps)
    // first, then divide the remaining height among the visible rows.
    //   topbar ≈ 60   footer ≈ 22   app padding (8 top + 4 bot) = 12
    //   row-gap × 2 (between topbar/body and body/footer) = 28
    // Total ≈ 122; round up to 138 for breathing room and font-size variance.
    const CHROME_PX = 138;
    const denom = Math.min(4, n);
    const bodyH = `(100vh - ${CHROME_PX}px)`;
    const rowH = `calc((${bodyH} - ${Math.max(0, denom - 1)} * var(--gap)) / ${denom})`;
    document.documentElement.style.setProperty("--row-h", rowH);
  }, [nodes.length]);

  const liveNodes = nodes.filter((n) => !n.offline && n.age < thresholds.ageStale);
  const nodePower = liveNodes.reduce((a, n) => a + n.power, 0);
  const auxPower = window.cockpitAuxPower || [];
  const totalPower = nodePower + auxPower.reduce((a, x) => a + x.watts, 0);
  const fmtW = (w) => `${Math.round(w).toLocaleString()} W`;
  const powerRows = [
    ...liveNodes.map((n) => ({ name: n.id, watts: n.power })),
    ...auxPower.map((x) => ({ name: x.source, watts: x.watts, aux: true })),
  ];
  const offlineCount = nodes.length - liveNodes.length;

  const thrFor = (n) => window.nodeThresholds(n.id, settings, thresholds);
  const critNodes = nodes.filter((n) => window.classifyNode(n, thrFor(n)) === "crit" || (n.offline || n.age >= thresholds.ageStale));
  const warnNodes = nodes.filter((n) => window.classifyNode(n, thrFor(n)) === "warn");

  const critCount = critNodes.length;
  const warnCount = warnNodes.length;

  let healthMsg = nodes.length === 0 ? "Waiting for nodes…" : "All systems normal";
  let healthTone = "";
  if (nodes.length > 0 && critCount > 0) {
    const issues = [];
    if (offlineCount) issues.push(`${offlineCount} offline`);
    const hotCpu = nodes.filter((n) => n.cpu >= thresholds.cpuHot).length;
    if (hotCpu) issues.push(`${hotCpu} CPU hot`);
    const hotTemp = nodes.filter((n) => n.temp >= window.nodeTempBands(n, thresholds).crit).length;
    if (hotTemp) issues.push(`${hotTemp} thermal crit`);
    const fanBad = nodes.filter((n) => !n.offline && n.fanTotal > 0 && n.fanOk / n.fanTotal < thresholds.fanOkRatio).length;
    if (fanBad) issues.push(`${fanBad} fan degraded`);
    healthMsg = issues.join(" · ") || `${critCount} critical`;
    healthTone = "crit";
  } else if (warnCount > 0) {
    healthMsg = `${warnCount} node${warnCount > 1 ? "s" : ""} elevated`;
    healthTone = "warn";
  }

  const totalPowerWarn = settings.alerts?.totalPowerWarn ?? 4500;
  const totalPowerHot = settings.alerts?.totalPowerHot ?? 4800;
  const powerTone = totalPower >= totalPowerHot ? "crit" : totalPower >= totalPowerWarn ? "warn" : "";
  const powerPct = Math.min(100, totalPowerHot > 0 ? (totalPower / totalPowerHot) * 100 : 0);

  const needsScroll = nodes.length > 4;

  return (
    <div className="app">
      <header className="topbar" style={{gridColumn:"1 / -1"}}>
        <div className="brand">
          <div className="brand-icon">
            <img src="assets/hpc-cockpit-icon.png" alt="HPC Cockpit" />
          </div>
          <div>
            <h1 className="brand-title">HPC Cockpit</h1>
            <div className="brand-sub">
              <span className={`status-dot ${healthTone}`} />
              <span className={`cluster-msg ${healthTone}`}>{healthMsg}</span>
            </div>
          </div>
        </div>

        <div />

        <div className="topbar-right">
          <div className="stat-group">
            <div className="stat">
              <span className="stat-label">Live</span>
              <span className="stat-value">{liveNodes.length}<span className="unit">/{nodes.length}</span></span>
            </div>
            <div className={`stat ${critCount ? "crit" : warnCount ? "warn" : ""}`}>
              <span className="stat-label">Alerts</span>
              <span className="stat-value">{critCount}<span className="unit">c</span> · {warnCount}<span className="unit">w</span></span>
            </div>
            <div className={`stat has-bar power-stat ${powerTone}`}>
              <span className="stat-label">Total Power</span>
              <span className="stat-value">{Math.round(totalPower).toLocaleString()}<span className="unit">W</span></span>
              <div className="stat-bar"><span style={{ width: `${powerPct}%` }} /></div>
              {powerRows.length > 0 && (
                <div className="power-pop" role="tooltip">
                  {powerRows.map((r) => (
                    <div key={r.name} className={`power-pop-row${r.aux ? " aux" : ""}`}>
                      <span>{r.name}</span>
                      <span>{fmtW(r.watts)}</span>
                    </div>
                  ))}
                  <div className="power-pop-row total">
                    <span>Total</span>
                    <span>{fmtW(totalPower)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="clock">
            <span className="time">{now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className="date">{now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
          </div>

          {(settings.modes || []).length > 0 && (() => {
            const activeMode = (settings.modes || []).find(m => modesEqual(m.groups || {}, settings.nodeGroups || {}));
            const activeId = activeMode ? activeMode.id : "__custom__";
            return (
              <select
                value={activeId}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id === "__custom__") return;
                  const m = (settings.modes || []).find(x => x.id === id);
                  if (m) setSettings(s => ({ ...s, nodeGroups: { ...(m.groups || {}) } }));
                }}
                title="Apply a saved node mode"
                style={{
                  padding: "5px 10px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--line)",
                  background: "var(--surface-2)",
                  color: "var(--ink)",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  maxWidth: 160,
                }}
              >
                <option value="__custom__">Custom</option>
                {(settings.modes || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            );
          })()}

          <button
            className={`icon-btn ${settings.theme === "dark" ? "active" : ""}`}
            onClick={() => setSettings({ ...settings, theme: settings.theme === "dark" ? "light" : "dark" })}
            title="Toggle theme"
          >
            {settings.theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>

          {/* Snooze: visible only when the cluster is actively alerting and
              we're not already snoozed at the current level. Click silences
              warn/crit until the cluster de-escalates or escalates further. */}
          {clusterLevel !== "ok" && !(snoozedLevel && (levelRank[clusterLevel] ?? 0) <= (levelRank[snoozedLevel] ?? 0)) && (
            <button
              className="icon-btn"
              onClick={() => {
                setSnoozedLevel(clusterLevel);
                window.cockpitAlarms?.stopCritLoop();
              }}
              title={`Ignore current ${clusterLevel} alarm`}
              style={{ color: clusterLevel === "crit" ? "var(--crit)" : "var(--warn)" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 19V5l12 7-12 7z" transform="rotate(90 12 12)"/>
                <path d="M9 9l6 6M15 9l-6 6"/>
              </svg>
            </button>
          )}
          {snoozedLevel && (
            <button
              className="icon-btn active"
              onClick={() => setSnoozedLevel(null)}
              title={`Snoozed at ${snoozedLevel} — click to resume`}
              style={{ color: "var(--muted)" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4h6l-6 8h6"/><path d="M14 4h8l-8 16h8"/>
              </svg>
            </button>
          )}

          <button
            className={`icon-btn ${settings.alarms?.enabled ? "" : "active"}`}
            onClick={() => setSettings({ ...settings, alarms: { ...(settings.alarms || {}), enabled: !settings.alarms?.enabled } })}
            title={settings.alarms?.enabled ? "Mute alarms" : "Unmute alarms"}
          >
            {settings.alarms?.enabled ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                <path d="M18.63 13A17.89 17.89 0 0 1 18 8"/>
                <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/>
                <path d="M18 8a6 6 0 0 0-9.33-5"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            )}
          </button>

          <a className="icon-btn" href="status.html" title="System status">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2.5"/>
              <circle cx="18" cy="6" r="2.5"/>
              <circle cx="6" cy="18" r="2.5"/>
              <circle cx="18" cy="18" r="2.5"/>
            </svg>
          </a>

          <a className="icon-btn" href="directory.html" title="Users & groups">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </a>

          <a className="icon-btn" href="settings.html" title="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </a>

          <cockpitWatchdog.Button />
          <cockpitAuth.LogoutButton />
        </div>
      </header>

      <main className={`grid ${needsScroll ? "overflow" : ""}`} style={{gridColumn:1,gridRow:2}}>
        {nodes.length === 0 ? (
          <div className="grid-empty">
            Waiting for node snapshots over UDP…
            <div style={{ marginTop: 8, fontSize: 11, opacity: 0.75 }}>
              Start a worker, or inject fake data via <code>POST /api/test/fake-nodes</code> when <code>--test-panel</code> is enabled.
            </div>
          </div>
        ) : nodes.map((n) => (
          <window.NodeRow
            key={n.id}
            node={n}
            thresholds={thrFor(n)}
            visible={settings.visibleMetrics}
            onSelect={() => { window.location.href = `node.html?node=${encodeURIComponent(n.id)}`; }}
          />
        ))}
      </main>

      <footer className="footer" style={{gridColumn:"1 / -1"}}>
        <span>
          Nodes live: <strong>{liveNodes.length}/{nodes.length}</strong>
          <span className="dot-sep">·</span>
          Avg CPU: <strong>{(liveNodes.reduce((a, n) => a + n.cpu, 0) / Math.max(1, liveNodes.length)).toFixed(0)}%</strong>
          <span className="dot-sep">·</span>
          Avg temp: <strong>{(liveNodes.reduce((a, n) => a + n.temp, 0) / Math.max(1, liveNodes.length)).toFixed(0)}°C</strong>
        </span>
        <span>
          Data refresh: <strong>1.5s</strong>
          <span className="dot-sep">·</span>
          HPC Cockpit <span className="dot-sep">·</span> NTU
        </span>
      </footer>

      <aside className="schedule-sidebar" style={{gridColumn:2,gridRow:2}}>
        <div className="schedule-sidebar-head">
          <div style={{display:"flex",alignItems:"center",gap:4,flex:1,minWidth:0}}>
            <button className="sch-day-nav" onClick={() => setDayOffset(d => d - 1)} title="Previous day">‹</button>
            <h3 style={{margin:0,flex:1,textAlign:"center",fontSize:10,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
              {(() => {
                const d = new Date(); d.setDate(d.getDate() + dayOffset);
                const label = dayOffset === 0
                  ? "Today"
                  : dayOffset === -1 ? "Yesterday"
                  : dayOffset === 1 ? "Tomorrow"
                  : d.toLocaleDateString("en-US", { weekday: "short" });
                return `${label} · ${d.toLocaleDateString("en-US",{month:"short",day:"numeric"})}`;
              })()}
            </h3>
            <button className="sch-day-nav" onClick={() => setDayOffset(d => d + 1)} title="Next day">›</button>
            {dayOffset !== 0 && (
              <button className="sch-day-nav today" onClick={() => setDayOffset(0)} title="Jump to today">●</button>
            )}
          </div>
          <a href="schedule.html" className="schedule-sidebar-edit">Full →</a>
        </div>
        <window.ScheduleGantt nodes={nodes} events={events} startH={settings.ganttStartH ?? 0} endH={settings.ganttEndH ?? 24} dayOffset={dayOffset} />
      </aside>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
