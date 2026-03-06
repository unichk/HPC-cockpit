function clampPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function fmtNumber(value, digits = 1) {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  return value.toFixed(digits);
}

function ageClass(ageMs) {
  if (ageMs < 15000) return "ok";
  if (ageMs < 60000) return "warn";
  return "down";
}

function nodeStatus(detail, ageMs) {
  const cpu = metricValue(detail.latest.metrics, "cpu", "usage");
  if (ageMs >= 60000) return "DISCONNECTED";
  if (cpu >= 95) return "OVERHEAT ALERT";
  if (cpu >= 75) return "Active High";
  if (cpu >= 40) return "Processing";
  if (cpu >= 10) return "Stable";
  return "Standby";
}

function metricValue(metrics, moduleName, metricName) {
  const match = metrics.find(
    (item) => item.module === moduleName && item.name === metricName && typeof item.value === "number"
  );
  return match ? match.value : 0;
}

function metricValueAny(metrics, moduleName, names) {
  for (const name of names) {
    const value = metricValue(metrics, moduleName, name);
    if (value !== 0) {
      return value;
    }
  }
  return 0;
}

function kbToGiB(kb) {
  return kb / (1024 * 1024);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`request failed: ${path} (${response.status})`);
  }
  return response.json();
}

function renderSummary(nodes, details) {
  const cpuValues = details.map((detail) => metricValue(detail.latest.metrics, "cpu", "usage"));
  const avgCpu = cpuValues.length ? cpuValues.reduce((acc, v) => acc + v, 0) / cpuValues.length : 0;
  const estimatedPower = nodes.length * (0.35 + avgCpu * 0.045);

  let healthText = "Systems All Good";
  let healthColor = "var(--light-green)";
  const staleCount = nodes.filter((node) => node.age_ms >= 60000).length;
  const hotCount = cpuValues.filter((value) => value >= 95).length;
  if (staleCount > 0 || hotCount > 0) {
    healthText = "Alert Detected";
    healthColor = "var(--sweet-peony)";
  } else if (nodes.some((node) => node.age_ms >= 15000) || cpuValues.some((value) => value >= 80)) {
    healthText = "Load Elevated";
    healthColor = "#f2b84b";
  }

  document.getElementById("power-draw").textContent = fmtNumber(estimatedPower, 1);
  document.getElementById("cluster-meta").textContent = healthText;
  document.getElementById("cluster-meta").style.color = healthColor;
  document.getElementById("brand-status-dot").style.background = healthColor;
}

function renderFooter(nodes) {
  const avgAge = nodes.length ? nodes.reduce((acc, node) => acc + node.age_ms, 0) / nodes.length : 0;
  const live = nodes.filter((node) => node.age_ms < 15000).length;
  document.getElementById("uptime-indicator").textContent = `Nodes live: ${live}/${nodes.length}`;
  document.getElementById("security-indicator").textContent = "Security: Active";
  document.getElementById("latency-indicator").textContent = `Latency: ${fmtNumber(avgAge / 1000, 2)}s`;
}

function renderCards(nodes, detailsById) {
  const grid = document.getElementById("node-grid");
  grid.innerHTML = "";

  for (const node of nodes) {
    const detail = detailsById.get(node.node_id);
    if (!detail) continue;

    const metrics = detail.latest.metrics;
    const cpu = clampPercent(metricValue(metrics, "cpu", "usage"));
    const load1 = metricValueAny(metrics, "load", ["avg1", "1m"]);
    const load5 = metricValueAny(metrics, "load", ["avg5", "5m"]);
    const load15 = metricValueAny(metrics, "load", ["avg15", "15m"]);
    const memUsedKb = metricValue(metrics, "memory", "used");
    const memTotalKb = metricValue(metrics, "memory", "total");
    const swapUsedKb = metricValue(metrics, "memory", "swap_used");
    const swapTotalKb = metricValue(metrics, "memory", "swap_total");
    const memPct = memTotalKb > 0 ? clampPercent((memUsedKb / memTotalKb) * 100) : 0;
    const memLabel = memTotalKb > 0
      ? `${fmtNumber(kbToGiB(memUsedKb), 1)} / ${fmtNumber(kbToGiB(memTotalKb), 1)} GiB`
      : "-- / -- GiB";
    const swapLabel = swapTotalKb > 0
      ? `${fmtNumber(kbToGiB(swapUsedKb), 1)} / ${fmtNumber(kbToGiB(swapTotalKb), 1)} GiB`
      : "0.0 / 0.0 GiB";
    const status = nodeStatus(detail, node.age_ms);
    const ageTone = ageClass(node.age_ms);
    const alert = status === "OVERHEAT ALERT";

    const card = document.createElement("article");
    card.className = `pebble-card node-card${alert ? " alert" : ""}`;
    card.innerHTML = `
      <div class="node-top">
        <div>
          <div class="node-title">${node.node_id}</div>
          <div class="node-subtitle${alert ? " alert" : ""}">${status}</div>
        </div>
        <div class="node-orb-wrap">
          <div class="node-orb ${alert ? "alert" : ageTone}"></div>
        </div>
      </div>
      <div class="metric-stack">
        <div>
          <div class="metric-head">
            <span class="modern-label">CPU Usage</span>
            <span class="metric-value${alert ? " alert" : ""}">${fmtNumber(cpu, 0)}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-bar${alert ? " alert" : ""}" style="width:${fmtNumber(cpu, 2)}%"></div>
          </div>
        </div>
        <div>
          <div class="metric-head">
            <span class="modern-label">Load Avg (1/5/15)</span>
            <span class="metric-value compact${alert ? " alert" : ""}">${fmtNumber(load1, 2)} / ${fmtNumber(load5, 2)} / ${fmtNumber(load15, 2)}</span>
          </div>
          <div class="text-meta">Raw load averages</div>
        </div>
        <div>
          <div class="metric-head">
            <span class="modern-label">Memory Used / Total</span>
            <span class="metric-value compact${alert ? " alert" : ""}">${memLabel}</span>
          </div>
          <div class="progress-track">
            <div class="progress-bar ${alert ? "alert" : "alt"}" style="width:${fmtNumber(memPct, 2)}%"></div>
          </div>
          <div class="text-meta">Swap: ${swapLabel}</div>
        </div>
      </div>
    `;
    grid.appendChild(card);
  }
}

async function refresh() {
  try {
    const nodesPayload = await fetchJson("/api/nodes");
    const nodes = (nodesPayload.nodes || []).slice().sort((a, b) => a.node_id.localeCompare(b.node_id));
    const details = await Promise.all(
      nodes.map((node) => fetchJson(`/api/node/${encodeURIComponent(node.node_id)}`))
    );
    const detailsById = new Map(details.map((detail) => [detail.node_id, detail]));

    renderSummary(nodes, details);
    renderCards(nodes, detailsById);
    renderFooter(nodes);
  } catch (error) {
    document.getElementById("cluster-meta").textContent = `Error: ${error.message}`;
    document.getElementById("cluster-meta").style.color = "var(--sweet-peony)";
  }
}

refresh();
setInterval(refresh, 2000);
