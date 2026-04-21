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
    density: "cozy",
    layout: "row",
    tempFanGap: 5,
    metricGap: 12,
    ganttStartH: 0,
    ganttEndH: 24,
    visibleMetrics: { cpu: true, mem: true, swap: true, load: true, temp: true, fan: true },
    alerts: { ...window.DEFAULT_THRESHOLDS },
  };
}

function App() {
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem("cockpit_settings_v1");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return { ...DEFAULT_SETTINGS(), ...parsed, alerts: { ...DEFAULT_SETTINGS().alerts, ...(parsed.alerts || {}) }, visibleMetrics: { ...DEFAULT_SETTINGS().visibleMetrics, ...(parsed.visibleMetrics || {}) } };
      } catch {}
    }
    return DEFAULT_SETTINGS();
  });
  const [nodes, setNodes] = useState(() => window.initNodes());
  const [events, setEvents] = useState([]);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const thresholds = { ...window.DEFAULT_THRESHOLDS, ...(settings.alerts || {}) };
  const now = useClock();

  useEffect(() => {
    localStorage.setItem("cockpit_settings_v1", JSON.stringify(settings));
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.density = settings.density;
    document.documentElement.dataset.layout = settings.layout;
    document.documentElement.style.setProperty("--tempfan-gap", `${settings.tempFanGap ?? 5}px`);
    document.documentElement.style.setProperty("--metric-gap", `${settings.metricGap ?? 12}px`);
  }, [settings]);

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
    const denom = Math.min(4, n);
    const rowH = `calc((100vh - 102px - ${Math.max(0, denom - 1)} * var(--gap)) / ${denom})`;
    document.documentElement.style.setProperty("--row-h", rowH);
  }, [nodes.length]);

  const liveNodes = nodes.filter((n) => !n.offline && n.age < thresholds.ageStale);
  const totalPower = liveNodes.reduce((a, n) => a + n.power, 0);
  const offlineCount = nodes.length - liveNodes.length;

  const critNodes = nodes.filter((n) => window.classifyNode(n, thresholds) === "crit" || (n.offline || n.age >= thresholds.ageStale));
  const warnNodes = nodes.filter((n) => window.classifyNode(n, thresholds) === "warn");

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

          <button
            className={`icon-btn ${tweaksOpen ? "active" : ""}`}
            onClick={() => setTweaksOpen(!tweaksOpen)}
            title="Tweaks"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
              <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
              <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
              <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>
            </svg>
          </button>
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
            thresholds={thresholds}
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
          <h3>Today · {new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})}</h3>
          <a href="schedule.html" className="schedule-sidebar-edit">Full →</a>
        </div>
        <window.ScheduleGantt nodes={nodes} events={events} startH={settings.ganttStartH ?? 0} endH={settings.ganttEndH ?? 24} />
      </aside>

      {tweaksOpen && (
        <window.TweaksPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setTweaksOpen(false)}
        />
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
