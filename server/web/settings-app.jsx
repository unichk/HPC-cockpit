// Settings page — HPC Cockpit. Layout follows the Claude Design bundle;
// sections are wired to the project's existing settings shape (theme,
// density, layout, gantt window, visible metrics, alert thresholds).
// Persistence goes through window.loadSettings/saveSettings (server-backed
// JSON file with a localStorage cache).

const { useState, useEffect, useRef, useCallback } = React;

const POWER_GROUPS = [
  { id: "idle",  label: "Idle"  },
  { id: "login", label: "Login" },
  { id: "cpu",   label: "CPU"   },
  { id: "gpu",   label: "GPU"   },
];

const DEFAULT_SETTINGS = {
  theme: "light",
  ganttStartH: 0,
  ganttEndH: 24,
  visibleMetrics: { cpu: true, mem: true, swap: true, load: true, temp: true, fan: true },
  alerts: { ...(window.DEFAULT_THRESHOLDS || {}) },
  groupAlerts: {
    idle:  { nodePowerWarn:  300, nodePowerHot:  500 },
    login: { nodePowerWarn:  500, nodePowerHot:  800 },
    cpu:   { nodePowerWarn: 1700, nodePowerHot: 1900 },
    gpu:   { nodePowerWarn: 2200, nodePowerHot: 2500 },
  },
  nodeGroups: {},
  alarms: {
    enabled: true,
    volume: 0.7,
    warnSound: "sounds/warn.mp3",
    critSound: "sounds/crit.mp3",
  },
};

const NAV_ITEMS = [
  { id: "appearance", label: "Appearance", icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
    </svg>
  )},
  { id: "alarms", label: "Alarms", icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )},
  { id: "thresholds", label: "Thresholds", icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )},
  { id: "power", label: "Power", icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>
    </svg>
  )},
  { id: "schedule", label: "Schedule", icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  )},
];

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function ThresholdSlider({ value, min, max, step = 1, tone = "", onChange }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="threshold-slider-wrap">
      <input
        type="range"
        className={`threshold-slider ${tone}`}
        style={{ "--fill": `${pct}%` }}
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
      <input
        type="number"
        className="threshold-number"
        min={min} max={max} step={step}
        value={value}
        onChange={e => {
          const v = Number(e.target.value);
          if (!isNaN(v) && v >= min && v <= max) onChange(v);
        }}
      />
    </div>
  );
}

function DualThreshold({ label, desc, warnKey, critKey, min, max, step, unit, alerts, setAlert }) {
  const wv = alerts[warnKey];
  const cv = alerts[critKey];
  const wPct = ((wv - min) / (max - min)) * 100;
  const cPct = ((cv - min) / (max - min)) * 100;

  const handleWarn = (v) => setAlert(warnKey, Math.min(v, cv - step));
  const handleCrit = (v) => setAlert(critKey, Math.max(v, wv + step));

  return (
    <div className="dual-row">
      <div className="setting-label">
        <span className="setting-name">{label}</span>
        {desc && <span className="setting-desc">{desc}</span>}
      </div>
      <div className="dual-sliders">
        <div className="threshold-pair-track">
          <div className="threshold-pair-ok"   style={{ width: `${wPct}%` }} />
          <div className="threshold-pair-warn" style={{ left: `${wPct}%`, width: `${cPct - wPct}%` }} />
          <div className="threshold-pair-crit" style={{ left: `${cPct}%` }} />
          <div className="threshold-marker"    style={{ left: `${wPct}%` }} />
          <div className="threshold-marker"    style={{ left: `${cPct}%` }} />
        </div>
        <div className="dual-slider-row">
          <span className="dual-slider-tone warn">Warn</span>
          <ThresholdSlider value={wv} min={min} max={max - step} step={step} tone="warn" onChange={handleWarn} />
          {unit && <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginLeft: -6 }}>{unit}</span>}
        </div>
        <div className="dual-slider-row">
          <span className="dual-slider-tone crit">Crit</span>
          <ThresholdSlider value={cv} min={min + step} max={max} step={step} tone="crit" onChange={handleCrit} />
          {unit && <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginLeft: -6 }}>{unit}</span>}
        </div>
      </div>
    </div>
  );
}

function SettingRow({ name, desc, children }) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <span className="setting-name">{name}</span>
        {desc && <span className="setting-desc">{desc}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Section({ id, icon, title, sub, children }) {
  return (
    <div className="settings-section section-anchor" id={id}>
      <div className="settings-section-head">
        {icon}
        <h2 className="settings-section-title">{title}</h2>
        {sub && <span className="settings-section-sub">{sub}</span>}
      </div>
      <div className="settings-rows">{children}</div>
    </div>
  );
}

function mergeWithDefaults(parsed) {
  if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
  const ga = { ...DEFAULT_SETTINGS.groupAlerts };
  for (const g of Object.keys(ga)) {
    ga[g] = { ...ga[g], ...((parsed.groupAlerts || {})[g] || {}) };
  }
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    alerts: { ...DEFAULT_SETTINGS.alerts, ...(parsed.alerts || {}) },
    visibleMetrics: { ...DEFAULT_SETTINGS.visibleMetrics, ...(parsed.visibleMetrics || {}) },
    groupAlerts: ga,
    nodeGroups: { ...(parsed.nodeGroups || {}) },
    alarms: { ...DEFAULT_SETTINGS.alarms, ...(parsed.alarms || {}) },
  };
}

function SettingsApp() {
  const [settings, setSettings] = useState(() => mergeWithDefaults(window.readCachedSettings ? window.readCachedSettings() : null));
  const [activeSection, setActiveSection] = useState("appearance");
  const [savedVisible, setSavedVisible] = useState(false);
  const savedTimer = useRef(null);
  const now = useClock();

  // Hydrate from server.
  useEffect(() => {
    let cancelled = false;
    if (!window.loadSettings) return;
    window.loadSettings().then(s => {
      if (!cancelled && s) setSettings(mergeWithDefaults(s));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  const set = useCallback((k, v) => setSettings(s => ({ ...s, [k]: v })), []);
  const setAlert = useCallback((k, v) => setSettings(s => ({ ...s, alerts: { ...s.alerts, [k]: Number(v) } })), []);
  const setAlarm = useCallback((k, v) => setSettings(s => ({ ...s, alarms: { ...(s.alarms || {}), [k]: v } })), []);
  const toggleMetric = useCallback((m) => setSettings(s => ({ ...s, visibleMetrics: { ...s.visibleMetrics, [m]: !s.visibleMetrics[m] } })), []);

  // Pull the available-sounds list once on mount so the dropdowns can show
  // any extra files the operator dropped into server/web/sounds/.
  const [soundFiles, setSoundFiles] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sounds", { cache: "no-store" })
      .then(r => r.ok ? r.json() : { sounds: [] })
      .then(d => { if (!cancelled && Array.isArray(d.sounds)) setSoundFiles(d.sounds); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const save = () => {
    if (window.saveSettings) window.saveSettings(settings);
    setSavedVisible(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedVisible(false), 2400);
  };

  const reset = () => {
    if (!confirm("Reset all settings to defaults?")) return;
    setSettings(DEFAULT_SETTINGS);
    if (window.saveSettings) window.saveSettings(DEFAULT_SETTINGS);
  };

  const scrollTo = (id) => {
    setActiveSection(id);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const a = settings.alerts;

  return (
    <div className="settings-app">
      <header className="topbar" style={{ gridColumn: "1 / -1" }}>
        <div className="brand">
          <div className="brand-icon">
            <img src="assets/hpc-cockpit-icon.png" alt="HPC Cockpit" />
          </div>
          <div>
            <h1 className="brand-title">HPC Cockpit</h1>
            <div className="brand-sub">
              <span className="status-dot" />
              <span className="cluster-msg">Settings</span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <a href="index.html" style={{
            display: "flex", alignItems: "center", gap: 6,
            fontSize: 12, fontWeight: 600, color: "var(--muted)",
            textDecoration: "none", padding: "5px 10px",
            border: "1px solid var(--line)", borderRadius: "var(--radius-md)",
            background: "var(--surface-2)"
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
            Cockpit
          </a>
        </div>

        <div className="topbar-right">
          <div className="clock">
            <span className="time">{now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className="date">{now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
          </div>
          <button
            className={`icon-btn ${settings.theme === "dark" ? "active" : ""}`}
            onClick={() => set("theme", settings.theme === "dark" ? "light" : "dark")}
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
        </div>
      </header>

      <div className="settings-body">
        <nav className="settings-nav">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`settings-nav-item ${activeSection === item.id ? "active" : ""}`}
              onClick={() => scrollTo(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          <Section id="appearance" title="Appearance" sub="Visual & layout"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>}
          >
            <SettingRow name="Theme" desc="Light or dark background">
              <div className="settings-seg">
                {["light","dark"].map(t => (
                  <button key={t} className={settings.theme === t ? "active" : ""} onClick={() => set("theme", t)}>
                    {t === "light" ? "☀ Light" : "☾ Dark"}
                  </button>
                ))}
              </div>
            </SettingRow>

            <SettingRow name="Visible columns" desc="Toggle which metric columns appear on each node row">
              <div className="metric-chips">
                {[
                  { id: "cpu", label: "CPU" }, { id: "mem", label: "Memory" },
                  { id: "swap", label: "Swap" }, { id: "load", label: "Load" },
                  { id: "temp", label: "Temp" }, { id: "fan", label: "Fan" },
                ].map(m => (
                  <button
                    key={m.id}
                    className={`metric-chip ${settings.visibleMetrics[m.id] ? "on" : ""}`}
                    onClick={() => toggleMetric(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </SettingRow>
          </Section>

          <Section id="alarms" title="Alarms" sub="Audio cues on warn / crit"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>}
          >
            {(() => {
              const alarms = settings.alarms || {};
              const soundOpts = [{ value: "", label: "(silent)" }, ...soundFiles.map(f => ({ value: `sounds/${f}`, label: f }))];
              return (
                <>
                  <SettingRow name="Audio alarms" desc="Play a sound when a node escalates to warn or crit">
                    <div className="settings-seg">
                      {[["off", false], ["on", true]].map(([lbl, v]) => (
                        <button key={lbl} className={alarms.enabled === v ? "active" : ""} onClick={() => setAlarm("enabled", v)}>
                          {lbl === "off" ? "Off" : "On"}
                        </button>
                      ))}
                    </div>
                  </SettingRow>

                  <SettingRow name="Volume" desc="Playback volume for both warn and crit cues">
                    <ThresholdSlider value={Math.round((alarms.volume ?? 0.7) * 100)} min={0} max={100} step={5}
                      onChange={v => setAlarm("volume", v / 100)} />
                    <span className="setting-value-badge">{Math.round((alarms.volume ?? 0.7) * 100)}%</span>
                  </SettingRow>

                  <SettingRow name="Warn sound" desc="Played when a node escalates to warn">
                    <select value={alarms.warnSound ?? ""} onChange={e => setAlarm("warnSound", e.target.value)}
                      style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--surface-2)", color: "var(--ink)", fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600, minWidth: 180 }}>
                      {soundOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </SettingRow>

                  <SettingRow name="Crit sound" desc="Played when a node escalates to crit">
                    <select value={alarms.critSound ?? ""} onChange={e => setAlarm("critSound", e.target.value)}
                      style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--surface-2)", color: "var(--ink)", fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600, minWidth: 180 }}>
                      {soundOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </SettingRow>

                  <SettingRow name="Test sound" desc="Plays the configured cue immediately (also primes browser autoplay)">
                    <button className="btn-ghost" onClick={() => window.cockpitAlarms?.fireAlarm("warn", { ...alarms, enabled: true })}>⚠ Warn</button>
                    <button className="btn-ghost" onClick={() => window.cockpitAlarms?.fireAlarm("crit", { ...alarms, enabled: true })}>⛔ Crit</button>
                  </SettingRow>
                </>
              );
            })()}
          </Section>

          <Section id="thresholds" title="Alert Thresholds" sub="Warn / Critical levels"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}
          >
            <DualThreshold label="CPU usage" desc="Node-level CPU utilisation alert bands"
              warnKey="cpuWarn" critKey="cpuHot" min={30} max={100} step={5} unit="%" alerts={a} setAlert={setAlert} />

            <DualThreshold label="Temperature" desc="Node CPU package temperature alert bands"
              warnKey="tempWarn" critKey="tempCrit" min={40} max={110} step={5} unit="°C" alerts={a} setAlert={setAlert} />

            <div className="dual-row">
              <div className="setting-label">
                <span className="setting-name">Stale heartbeat</span>
                <span className="setting-desc">Seconds since last update before a node is flagged</span>
              </div>
              <div className="dual-sliders">
                <div className="dual-slider-row">
                  <span className="dual-slider-tone warn">Warn</span>
                  <ThresholdSlider value={a.ageWarn} min={5} max={120} step={5} tone="warn" onChange={v => setAlert("ageWarn", Math.min(v, a.ageStale - 5))} />
                  <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginLeft: -6 }}>s</span>
                </div>
                <div className="dual-slider-row">
                  <span className="dual-slider-tone crit">Stale</span>
                  <ThresholdSlider value={a.ageStale} min={10} max={300} step={5} tone="crit" onChange={v => setAlert("ageStale", Math.max(v, a.ageWarn + 5))} />
                  <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginLeft: -6 }}>s</span>
                </div>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-label">
                <span className="setting-name">Fan OK ratio</span>
                <span className="setting-desc">Minimum fraction of fans running (1.0 = all fans required)</span>
              </div>
              <div className="setting-control">
                <ThresholdSlider
                  value={Math.round(a.fanOkRatio * 100)}
                  min={50} max={100} step={5}
                  tone={a.fanOkRatio < 1.0 ? "warn" : ""}
                  onChange={v => setAlert("fanOkRatio", v / 100)}
                />
                <span className="setting-value-badge">{Math.round(a.fanOkRatio * 100)}%</span>
              </div>
            </div>
          </Section>

          <Section id="power" title="Power Thresholds" sub="Per-node and cluster-wide"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>}
          >
            <DualThreshold label="Node power draw" desc="Per-node wattage alert bands"
              warnKey="nodePowerWarn" critKey="nodePowerHot" min={300} max={2400} step={50} unit="W" alerts={a} setAlert={setAlert} />

            <DualThreshold label="Cluster total power" desc="Sum-of-live-node wattage alert bands"
              warnKey="totalPowerWarn" critKey="totalPowerHot" min={1000} max={10000} step={100} unit="W" alerts={a} setAlert={setAlert} />

            <div className="setting-row" style={{ background: "var(--surface-2)", display:"block" }}>
              <div className="setting-label" style={{ marginBottom: 4 }}>
                <span className="setting-name">Per-group power bands</span>
                <span className="setting-desc">Override the per-node bands when a node is assigned to a group on its detail page. Unassigned nodes use the global Node power draw above.</span>
              </div>
            </div>

            {POWER_GROUPS.map(g => {
              const ga = settings.groupAlerts?.[g.id] || { nodePowerWarn: 0, nodePowerHot: 0 };
              const setGroupAlert = (k, v) => setSettings(s => ({
                ...s,
                groupAlerts: { ...s.groupAlerts, [g.id]: { ...(s.groupAlerts?.[g.id] || {}), [k]: Number(v) } },
              }));
              const handleWarn = v => setGroupAlert("nodePowerWarn", Math.min(v, ga.nodePowerHot - 50));
              const handleCrit = v => setGroupAlert("nodePowerHot",  Math.max(v, ga.nodePowerWarn + 50));
              const min = 100, max = 3000, step = 50;
              const wPct = ((ga.nodePowerWarn - min) / (max - min)) * 100;
              const cPct = ((ga.nodePowerHot  - min) / (max - min)) * 100;
              return (
                <div className="dual-row" key={g.id}>
                  <div className="setting-label">
                    <span className="setting-name">{g.label} group</span>
                    <span className="setting-desc">Power bands for nodes assigned to <code>{g.id}</code></span>
                  </div>
                  <div className="dual-sliders">
                    <div className="threshold-pair-track">
                      <div className="threshold-pair-ok"   style={{ width: `${wPct}%` }} />
                      <div className="threshold-pair-warn" style={{ left: `${wPct}%`, width: `${cPct - wPct}%` }} />
                      <div className="threshold-pair-crit" style={{ left: `${cPct}%` }} />
                      <div className="threshold-marker"    style={{ left: `${wPct}%` }} />
                      <div className="threshold-marker"    style={{ left: `${cPct}%` }} />
                    </div>
                    <div className="dual-slider-row">
                      <span className="dual-slider-tone warn">Warn</span>
                      <ThresholdSlider value={ga.nodePowerWarn} min={min} max={max - step} step={step} tone="warn" onChange={handleWarn} />
                      <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginLeft: -6 }}>W</span>
                    </div>
                    <div className="dual-slider-row">
                      <span className="dual-slider-tone crit">Crit</span>
                      <ThresholdSlider value={ga.nodePowerHot} min={min + step} max={max} step={step} tone="crit" onChange={handleCrit} />
                      <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginLeft: -6 }}>W</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </Section>

          <Section id="schedule" title="Schedule / Gantt" sub="Sidebar chart window"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>}
          >
            <SettingRow name="Gantt start hour" desc="Earliest hour shown in the sidebar Gantt chart">
              <ThresholdSlider
                value={settings.ganttStartH}
                min={0} max={23} step={1}
                onChange={v => { set("ganttStartH", v); if (settings.ganttEndH <= v) set("ganttEndH", v + 1); }}
              />
              <span className="setting-value-badge">{String(settings.ganttStartH).padStart(2,"0")}:00</span>
            </SettingRow>

            <SettingRow name="Gantt end hour" desc="Latest hour shown in the sidebar Gantt chart">
              <ThresholdSlider
                value={settings.ganttEndH}
                min={1} max={24} step={1}
                onChange={v => { set("ganttEndH", v); if (settings.ganttStartH >= v) set("ganttStartH", v - 1); }}
              />
              <span className="setting-value-badge">{String(settings.ganttEndH).padStart(2,"0")}:00</span>
            </SettingRow>

            <div className="setting-row" style={{ background: "var(--surface-2)" }}>
              <div className="setting-label">
                <span className="setting-name">Window span</span>
                <span className="setting-desc">Hours currently visible in the Gantt chart</span>
              </div>
              <div className="setting-control">
                <span className="info-tag muted">{settings.ganttEndH - settings.ganttStartH} h window</span>
              </div>
            </div>
          </Section>

        </div>
      </div>

      <footer className="settings-action-bar">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className={`settings-saved-msg ${savedVisible ? "visible" : ""}`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Settings saved
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-ghost" onClick={reset}>Reset defaults</button>
          <button className="btn-primary" onClick={save}>Save settings</button>
        </div>
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<SettingsApp />);
