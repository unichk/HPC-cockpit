// Tweaks panel — theme, gantt hours, metric visibility, alert thresholds.

function TweaksPanel({ settings, onChange, onClose }) {
  const set = (k, v) => onChange({ ...settings, [k]: v });
  const toggleMetric = (m) => {
    const next = { ...settings.visibleMetrics, [m]: !settings.visibleMetrics[m] };
    set("visibleMetrics", next);
  };
  const setAlert = (k, v) => set("alerts", { ...settings.alerts, [k]: Number(v) });

  const a = settings.alerts || {};

  return (
    <aside className="tweaks">
      <h3>
        Tweaks
        <button className="close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </h3>

      <div className="tweak-row">
        <label className="tweak-label">Theme</label>
        <div className="seg">
          {["light", "dark"].map((t) => (
            <button key={t} className={settings.theme === t ? "active" : ""} onClick={() => set("theme", t)}>
              {t === "light" ? "☀ Light" : "☾ Dark"}
            </button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label className="tweak-label">Gantt start — {String(settings.ganttStartH ?? 0).padStart(2,"0")}:00</label>
        <input type="range" min={0} max={23} step={1} value={settings.ganttStartH ?? 0}
          onChange={e => { const v=+e.target.value; set("ganttStartH", v); if((settings.ganttEndH??24)<=v) set("ganttEndH", v+1); }}
          style={{width:"100%",accentColor:"var(--accent)"}} />
      </div>
      <div className="tweak-row">
        <label className="tweak-label">Gantt end — {String(settings.ganttEndH ?? 24).padStart(2,"0")}:00</label>
        <input type="range" min={1} max={24} step={1} value={settings.ganttEndH ?? 24}
          onChange={e => { const v=+e.target.value; set("ganttEndH", v); if((settings.ganttStartH??0)>=v) set("ganttStartH", v-1); }}
          style={{width:"100%",accentColor:"var(--accent)"}} />
      </div>

      <div className="tweak-row">
        <label className="tweak-label">Metrics shown</label>
        <div className="metric-toggle">
          {[
            { id: "cpu", label: "CPU" },
            { id: "mem", label: "Mem" },
            { id: "swap", label: "Swap" },
            { id: "load", label: "Load" },
            { id: "temp", label: "Temp" },
            { id: "fan", label: "Fan" },
          ].map((m) => (
            <button
              key={m.id}
              className={settings.visibleMetrics[m.id] ? "active" : ""}
              onClick={() => toggleMetric(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label className="tweak-label">Alert thresholds</label>
        <div className="alert-grid">
          {[
            { key: "cpuWarn",         label: "CPU warn %",    min: 50, max: 100, step: 5,  def: 80  },
            { key: "cpuHot",          label: "CPU crit %",    min: 50, max: 100, step: 5,  def: 95  },
            { key: "tempWarn",        label: "Temp warn °C",  min: 50, max: 100, step: 5,  def: 80  },
            { key: "tempCrit",        label: "Temp crit °C",  min: 60, max: 110, step: 5,  def: 90  },
            { key: "nodePowerWarn",   label: "Node power warn W",  min: 300, max: 2200, step: 50, def: 1700 },
            { key: "nodePowerHot",    label: "Node power crit W",  min: 400, max: 2400, step: 50, def: 1900 },
            { key: "totalPowerWarn",  label: "Total power warn W", min: 1000, max: 8000, step: 100, def: 4500 },
            { key: "totalPowerHot",   label: "Total power crit W", min: 1000, max: 9000, step: 100, def: 4800 },
          ].map(({ key, label, min, max, step, def }) => {
            const val = a[key] ?? def;
            return (
              <div className="alert-row" key={key}>
                <div className="alert-label-row">
                  <span className="alert-name">{label}</span>
                  <span className="alert-val">{val}</span>
                </div>
                <input
                  type="range" min={min} max={max} step={step}
                  value={val}
                  onChange={(e) => setAlert(key, e.target.value)}
                  style={{ width: "100%", accentColor: "var(--accent)" }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

Object.assign(window, { TweaksPanel });
