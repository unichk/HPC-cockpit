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

function formatTimestamp(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms) || ms <= 0) return "--";
  return new Date(ms).toLocaleTimeString();
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
    if (value !== 0) return value;
  }
  return 0;
}

function kbToGiB(kb) {
  return kb / (1024 * 1024);
}

function ringMarkup(percent, text, extraClass = "") {
  const pct = clampPercent(percent);
  return `<span class="ring ${extraClass}" style="--pct:${fmtNumber(pct, 2)}"><span class="ring-value">${text}</span></span>`;
}

const METRIC_POINTS = [
  { id: "cpu_usage", label: "CPU usage" },
  { id: "load_avg_triplet", label: "Load avg (1/5/15)" },
  { id: "memory_used_total", label: "Memory (used/all)" },
  { id: "swap_used_total", label: "Swap (used/all)" },
  { id: "thermal", label: "Thermal" },
  { id: "fan", label: "Fan" },
];

let selectedPointIds = new Set(METRIC_POINTS.map((point) => point.id));
let pointSelectionCustomized = false;
let testPanelEnabled = false;

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`request failed: ${path} (${response.status})`);
  }
  return response.json();
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`request failed: ${path} (${response.status})`);
  }
  return response.json();
}

function syncMetricChooser() {
  if (!testPanelEnabled) return;

  if (!pointSelectionCustomized) {
    selectedPointIds = new Set(METRIC_POINTS.map((point) => point.id));
  }

  const chooser = document.getElementById("metric-chooser");
  chooser.innerHTML = METRIC_POINTS.map((point) => {
    const checked = selectedPointIds.has(point.id) ? "checked" : "";
    return `<label class="metric-chip"><input type="checkbox" data-point-id="${point.id}" ${checked} />${point.label}</label>`;
  }).join("");

  chooser.querySelectorAll("input[type=checkbox][data-point-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", async (event) => {
      pointSelectionCustomized = true;
      const pointId = event.target.getAttribute("data-point-id");
      if (!pointId) return;
      if (event.target.checked) selectedPointIds.add(pointId);
      else selectedPointIds.delete(pointId);
      await refresh();
    });
  });

  document.getElementById("metrics-all").onclick = async () => {
    pointSelectionCustomized = true;
    selectedPointIds = new Set(METRIC_POINTS.map((point) => point.id));
    await refresh();
  };
  document.getElementById("metrics-none").onclick = async () => {
    pointSelectionCustomized = true;
    selectedPointIds = new Set();
    await refresh();
  };
}

function selectedPoints() {
  if (!pointSelectionCustomized) return METRIC_POINTS;
  return METRIC_POINTS.filter((point) => selectedPointIds.has(point.id));
}

function renderSummary(nodes, details) {
  const cpuValues = details.map((detail) => metricValue(detail.latest.metrics, "cpu", "usage"));
  const avgCpu = cpuValues.length ? cpuValues.reduce((acc, v) => acc + v, 0) / cpuValues.length : 0;
  const measuredPowerWatts = details
    .map((detail) => metricValue(detail.latest.metrics, "power", "watts"))
    .reduce((acc, value) => acc + value, 0);
  const estimatedPowerWatts = nodes.length * (350 + avgCpu * 45);
  const powerWatts = measuredPowerWatts > 0 ? measuredPowerWatts : estimatedPowerWatts;

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

  document.getElementById("power-draw").textContent = fmtNumber(powerWatts, 0);
  document.getElementById("cluster-meta").textContent = healthText;
  document.getElementById("cluster-meta").style.color = healthColor;
  document.getElementById("brand-status-dot").style.background = healthColor;
}

function renderFooter(nodes) {
  const maxAge = nodes.length ? nodes.reduce((max, node) => Math.max(max, node.age_ms), 0) : 0;
  const live = nodes.filter((node) => node.age_ms < 15000).length;
  document.getElementById("uptime-indicator").textContent = `Nodes live: ${live}/${nodes.length}`;
  document.getElementById("latency-indicator").textContent = `Data Age(max): ${fmtNumber(maxAge / 1000, 2)}s`;
}

function renderPointRow(pointId, metrics, alert) {
  const cpu = clampPercent(metricValue(metrics, "cpu", "usage"));
  const load1 = metricValueAny(metrics, "load", ["avg1", "1m"]);
  const load5 = metricValueAny(metrics, "load", ["avg5", "5m"]);
  const load15 = metricValueAny(metrics, "load", ["avg15", "15m"]);
  const memUsedKb = metricValue(metrics, "memory", "used");
  const memTotalKb = metricValue(metrics, "memory", "total");
  const memPct = memTotalKb > 0 ? clampPercent((memUsedKb / memTotalKb) * 100) : 0;
  const swapUsedKb = metricValue(metrics, "memory", "swap_used");
  const swapTotalKb = metricValue(metrics, "memory", "swap_total");
  const swapPct = swapTotalKb > 0 ? clampPercent((swapUsedKb / swapTotalKb) * 100) : 0;
  const thermalAvailable = metricValue(metrics, "thermal", "available") > 0;
  const fanAvailable = metricValue(metrics, "fan", "available") > 0;

  if (pointId === "cpu_usage") {
    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">CPU</span></span>
          <span class="metric-right">
            ${ringMarkup(cpu, `${fmtNumber(cpu, 0)}%`, `large${alert ? " alert" : ""}`)}
          </span>
        </div>
      </div>
    `;
  }

  if (pointId === "load_avg_triplet") {
    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">Load</span></span>
        </div>
        <span class="load-triplet${alert ? " alert" : ""}">
          <span class="load-chip"><span>1m</span><strong>${fmtNumber(load1, 2)}</strong></span>
          <span class="load-chip"><span>5m</span><strong>${fmtNumber(load5, 2)}</strong></span>
          <span class="load-chip"><span>15m</span><strong>${fmtNumber(load15, 2)}</strong></span>
        </span>
      </div>
    `;
  }

  if (pointId === "memory_used_total") {
    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">Memory</span></span>
          <span class="metric-right">
            ${ringMarkup(memPct, `${fmtNumber(kbToGiB(memUsedKb), 1)}G`, `${alert ? "alert" : "alt"} large`)}
          </span>
        </div>
      </div>
    `;
  }

  if (pointId === "swap_used_total") {
    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">Swap</span></span>
          <span class="metric-right">
            ${ringMarkup(swapPct, `${fmtNumber(kbToGiB(swapUsedKb), 1)}G`, `${alert ? "alert" : "alt"} large`)}
          </span>
        </div>
      </div>
    `;
  }

  if (pointId === "thermal") {
    const cpuPkgMax = metricValueAny(metrics, "thermal", ["cpu_package_max_c", "cpu_package0_c"]);
    const nvmeMax = metricValue(metrics, "thermal", "nvme_max_c");
    const nicMax = metricValue(metrics, "thermal", "nic_max_c");
    const chipset = metricValue(metrics, "thermal", "chipset_c");
    const cpuLevel = metricValue(metrics, "thermal", "cpu_alert_level");
    const nvmeLevel = metricValue(metrics, "thermal", "nvme_alert_level");
    const nicLevel = metricValue(metrics, "thermal", "nic_alert_level");
    const chipsetLevel = metricValue(metrics, "thermal", "chipset_alert_level");
    const hot = cpuLevel >= 2 || nvmeLevel >= 2 || nicLevel >= 2 || chipsetLevel >= 2;
    const warm = !hot && (cpuLevel >= 1 || nvmeLevel >= 1 || nicLevel >= 1 || chipsetLevel >= 1);
    const tone = hot ? "crit" : warm ? "warn" : "";

    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">Thermal</span></span>
        </div>
        ${
          !thermalAvailable
            ? '<div class="text-meta">Unavailable</div>'
            : `<div class="kv-list ${tone}">
                <span>CPU <strong>${fmtNumber(cpuPkgMax, 1)}°C</strong></span>
                <span>NVMe <strong>${fmtNumber(nvmeMax, 1)}°C</strong></span>
                <span>NIC <strong>${fmtNumber(nicMax, 1)}°C</strong></span>
                <span>PCH <strong>${fmtNumber(chipset, 1)}°C</strong></span>
              </div>`
        }
      </div>
    `;
  }

  if (pointId === "fan") {
    const minRpm = metricValue(metrics, "fan", "min_rpm");
    const maxRpm = metricValue(metrics, "fan", "max_rpm");
    const avgRpm = metricValue(metrics, "fan", "avg_rpm");
    const fanCount = metricValue(metrics, "fan", "count");
    const okCount = metricValue(metrics, "fan", "ok_count");
    const fanAlert = fanAvailable && fanCount > 0 && okCount < fanCount;
    const avgKrpm = avgRpm / 1000.0;
    const minKrpm = minRpm / 1000.0;
    const maxKrpm = maxRpm / 1000.0;
    return `
      <div class="metric-row fan-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">Fan</span></span>
        </div>
        ${
          !fanAvailable
            ? '<div class="text-meta">Unavailable</div>'
            : `<div class="kv-list fan-inline${fanAlert ? " crit" : ""}">
                <span>A <strong>${fmtNumber(avgKrpm, 2)}k</strong></span>
                <span>Mn <strong>${fmtNumber(minKrpm, 2)}k</strong></span>
                <span>Mx <strong>${fmtNumber(maxKrpm, 2)}k</strong></span>
                <span>OK <strong>${fmtNumber(okCount, 0)}/${fmtNumber(fanCount, 0)}</strong></span>
              </div>`
        }
      </div>
    `;
  }

  return "";
}

function renderCards(nodes, detailsById, selectedRows) {
  const grid = document.getElementById("node-grid");
  grid.innerHTML = "";
  const count = nodes.length;
  grid.dataset.count = count > 6 ? "many" : String(count);

  for (const node of nodes) {
    const detail = detailsById.get(node.node_id);
    if (!detail) continue;

    const metrics = detail.latest.metrics;
    const cpu = clampPercent(metricValue(metrics, "cpu", "usage"));
    const powerWatts = metricValue(metrics, "power", "watts");
    const powerAvailable = metricValue(metrics, "power", "available") > 0;
    const stale = node.age_ms >= 60000;
    const nodeTimestamp = formatTimestamp(detail.latest.timestamp_ms);
    const subtitle = stale ? `Last data: ${nodeTimestamp} (stale)` : `Last data: ${nodeTimestamp}`;
    const ageTone = ageClass(node.age_ms);
    const alert = stale || cpu >= 95;

    const rowsHtml = selectedRows.map((row) => renderPointRow(row.id, metrics, alert)).join("") || "<div class=\"text-meta\">No metric selected</div>";

    const card = document.createElement("article");
    card.className = `pebble-card node-card${alert ? " alert" : ""}`;
    card.innerHTML = `
      <div class="node-top">
        <div>
          <div class="node-title-wrap">
            <div class="node-title">${node.node_id}</div>
            <div class="node-ip">${node.remote_ip || "--"}</div>
          </div>
          <div class="node-subtitle${stale ? " alert" : ""}">${subtitle}</div>
        </div>
        <div class="node-top-right">
          <div class="node-power">${powerAvailable ? `${fmtNumber(powerWatts, 0)}W` : "--"}</div>
          <div class="node-orb-wrap">
            <div class="node-orb ${stale ? "alert" : ageTone}"></div>
          </div>
        </div>
      </div>
      <div class="metric-stack">
        ${rowsHtml}
      </div>
    `;
    grid.appendChild(card);
  }
}

let refreshInFlight = false;

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const nodesPayload = await fetchJson("/api/nodes");
    const nodes = (nodesPayload.nodes || []).slice().sort((a, b) => a.node_id.localeCompare(b.node_id));
    const details = await Promise.all(nodes.map((node) => fetchJson(`/api/node/${encodeURIComponent(node.node_id)}`)));
    const detailsById = new Map(details.map((detail) => [detail.node_id, detail]));

    syncMetricChooser();
    const rows = selectedPoints();

    renderSummary(nodes, details);
    renderCards(nodes, detailsById, rows);
    renderFooter(nodes);
  } catch (error) {
    document.getElementById("cluster-meta").textContent = `Error: ${error.message}`;
    document.getElementById("cluster-meta").style.color = "var(--sweet-peony)";
  } finally {
    refreshInFlight = false;
  }
}

async function setupTestPanel() {
  try {
    const config = await fetchJson("/api/config");
    if (!config.test_panel) return;

    const panel = document.getElementById("test-panel");
    const layout = document.querySelector(".layout");
    const showButton = document.getElementById("show-test-panel");
    const hideButton = document.getElementById("hide-test-panel");
    const storageKey = "hpc_test_panel_hidden";
    panel.classList.remove("hidden");
    layout.classList.add("with-test-panel");
    testPanelEnabled = true;

    const setPanelHidden = (hidden) => {
      panel.classList.toggle("hidden", hidden);
      showButton.classList.toggle("hidden", !hidden);
      localStorage.setItem(storageKey, hidden ? "1" : "0");
    };

    setPanelHidden(localStorage.getItem(storageKey) === "1");
    showButton.addEventListener("click", () => setPanelHidden(false));
    hideButton.addEventListener("click", () => setPanelHidden(true));

    document.getElementById("apply-fake-nodes").addEventListener("click", async () => {
      const input = document.getElementById("fake-count");
      const count = Number.parseInt(input.value, 10);
      if (Number.isNaN(count) || count < 0) {
        input.value = "0";
        return;
      }
      await postJson("/api/test/fake-nodes", { count });
      await refresh();
    });
  } catch (_) {
    // Test panel stays hidden when endpoint is unavailable.
  }
}

setupTestPanel().then(() => {
  refresh();
  setInterval(refresh, 1000);
});
