// NodeRow — one compact row per node. Ported from the Claude Design bundle.

function classForValue(pct, warn, crit) {
  if (pct >= crit) return "crit";
  if (pct >= warn) return "warn";
  return "";
}

function NodeRow({ node, thresholds, visible, onSelect }) {
  const status = window.classifyNode(node, thresholds);
  const isOffline = node.offline || node.age >= thresholds.ageStale;
  const rowClass = isOffline ? "offline crit" : status;

  const cpuTone = classForValue(node.cpu, thresholds.cpuWarn, thresholds.cpuHot);
  const memTone = classForValue(node.memPct, 75, 90);
  const swapTone = classForValue(node.swapPct, 20, 50);
  // Hardware limits first, matching the detail page and the alerting.
  const tempBands = window.nodeTempBands(node, thresholds);
  const tempTone = classForValue(node.temp, tempBands.warn, tempBands.crit);
  const powerTone = classForValue(node.power, thresholds.nodePowerWarn, thresholds.nodePowerHot);
  const fanRatio = node.fanTotal > 0 ? node.fanOk / node.fanTotal : 1;
  const fanTone = fanRatio < 1 ? (fanRatio < 0.75 ? "crit" : "warn") : "";
  const loadTone = node.load[0] > 20 ? "crit" : node.load[0] > 10 ? "warn" : "";
  // GPUs are scored against the BMC's GPU slot limits (92/96 here), not the
  // CPU's, falling back to the settings bands when the BMC publishes none.
  const gpuBands = window.nodeTempBands(node, thresholds, "gpu");
  const gpuTempTone = classForValue(node.gpuTempMax || 0, gpuBands.warn, gpuBands.crit);

  const ageTone =
    node.age >= thresholds.ageStale ? "crit" :
    node.age >= thresholds.ageWarn ? "warn" : "";

  const ageText = isOffline
    ? `${Math.floor(node.age)}s ago`
    : `live · ${node.age.toFixed(1)}s`;

  return (
    <article className={`node ${rowClass}`} onClick={onSelect}>
      <div className="node-id">
        <div className="node-id-top">
          <span className={`status-dot ${status === "crit" ? "crit" : status === "warn" ? "warn" : ""}`} />
          <span className="node-name">{node.id}</span>
        </div>
        <span className="node-ip">{node.ip}</span>
        <span className={`node-age ${ageTone}`}>
          <span className="node-age-dot" />
          {ageText}
        </span>
      </div>

      {/* Distribute the visible cells evenly across the row. */}
      <div className="metrics" style={{
        columnGap: 24,
        paddingLeft: 28,
        gridTemplateColumns: `repeat(${
          (visible.cpu  ? 1 : 0) +
          (visible.mem  ? 1 : 0) +
          (visible.swap ? 1 : 0) +
          (visible.load ? 1 : 0) +
          (visible.temp ? 1 : 0) +
          (visible.fan  ? 1 : 0) +
          (node.gpuCount > 0 ? 1 : 0)
        }, minmax(0, 1fr))`,
      }}>
        {visible.cpu && (
          <div className={`metric ${cpuTone}`}>
            <span className="metric-label">CPU</span>
            <window.Ring pct={node.cpu} text={`${Math.round(node.cpu)}%`} tone={cpuTone} size={54} />
          </div>
        )}
        {visible.mem && (
          <div className={`metric ${memTone}`}>
            <span className="metric-label">Memory</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "fit-content" }}>
              <div className="metric-value">{node.memG.toFixed(0)}<span className="unit">/{node.memTotal}G · {node.memPct.toFixed(0)}%</span></div>
              <div className="bar-track"><div className="bar-fill mem" style={{ width: `${Math.min(100, node.memPct)}%` }} /></div>
            </div>
          </div>
        )}
        {visible.swap && (
          <div className={`metric ${swapTone}`}>
            <span className="metric-label">Swap</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "fit-content" }}>
              <div className="metric-value">{node.swapG.toFixed(1)}<span className="unit">/{node.swapTotal}G · {node.swapPct.toFixed(0)}%</span></div>
              <div className="bar-track"><div className="bar-fill swap" style={{ width: `${Math.min(100, node.swapPct)}%` }} /></div>
            </div>
          </div>
        )}
        {visible.load && (
          <div className={`metric ${loadTone}`}>
            <span className="metric-label">Load avg</span>
            <div className="load-chips" style={{ gap: 2 }}>
              {["1m", "5m", "15m"].map((lbl, i) => (
                <div
                  className="load-chip"
                  key={lbl}
                  style={{ fontSize: 11, padding: "6px 2px", minWidth: 0, lineHeight: 1.1 }}
                >
                  <span style={{ fontSize: 7 }}>{lbl}</span>
                  {node.load[i].toFixed(1)}
                </div>
              ))}
            </div>
          </div>
        )}
        {visible.temp && (
          <div className={`metric ${tempTone}`}>
            <span className="metric-label">Temp</span>
            <div className="metric-value">{Math.round(node.temp)}<span className="unit">°C</span></div>
          </div>
        )}
        {visible.fan && (
          <div className={`metric ${fanTone}`}>
            <span className="metric-label">Fan</span>
            <div className="metric-value fan-state">
              <window.FanIcon />
              {node.fanPct != null
                ? <>{Math.round(node.fanPct)}<span className="unit">% · {node.fanOk}/{node.fanTotal}</span></>
                : <>{(node.fanRpm / 1000).toFixed(1)}<span className="unit">k · {node.fanOk}/{node.fanTotal}</span></>}
            </div>
          </div>
        )}
        {node.gpuCount > 0 && (
          <div className={`metric ${gpuTempTone}`}>
            <span className="metric-label">GPU</span>
            <div className="metric-value" style={node.gpuPlaceholder ? { fontSize: 12, color: "var(--muted)", fontWeight: 600 } : undefined}>
              {node.gpuPlaceholder
                ? <span>NO GPU</span>
                : <>{node.gpuCount}×<span className="unit">{" · "}{Math.round(node.gpuTempMax)}°C</span></>}
            </div>
          </div>
        )}
      </div>

      <div className={`power-cell ${powerTone}`}>
        <span className="power-label">Power</span>
        <div className="power-value">{Math.round(node.power)}<span className="unit">W</span></div>
        <div className="power-spark"><window.Sparkline values={node.powerHistory} /></div>
      </div>
    </article>
  );
}

Object.assign(window, { NodeRow });
