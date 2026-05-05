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
  };
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

  useEffect(() => window.startLiveNodeFeed(setNodes), []);

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
  const totalPower = liveNodes.reduce((a, n) => a + n.power, 0);
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
    const hotTemp = nodes.filter((n) => n.temp >= thresholds.tempCrit).length;
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
            <div className={`stat has-bar ${powerTone}`}>
              <span className="stat-label">Total Power</span>
              <span className="stat-value">{Math.round(totalPower).toLocaleString()}<span className="unit">W</span></span>
              <div className="stat-bar"><span style={{ width: `${powerPct}%` }} /></div>
            </div>
          </div>

          <div className="clock">
            <span className="time">{now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className="date">{now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
          </div>

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

          <a className="icon-btn" href="settings.html" title="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </a>
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
