function clampPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function fmtNumber(value, digits = 1) {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  return value.toFixed(digits);
}

function ageClass(ageMs, thresholds) {
  if (ageMs < thresholds.age_warn_ms) return "ok";
  if (ageMs < thresholds.age_stale_ms) return "warn";
  return "down";
}

function formatTimestamp(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms) || ms <= 0) return "--";
  return new Date(ms).toLocaleTimeString();
}

function formatAge(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms) || ms < 0) return "--";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s ago`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s ago`;
}

function metricValue(metrics, moduleName, metricName) {
  const match = metrics.find(
    (item) => item.module === moduleName && item.name === metricName && typeof item.value === "number"
  );
  return match ? match.value : 0;
}

function hasMetric(metrics, moduleName, metricName) {
  return metrics.some((item) => item.module === moduleName && item.name === metricName && typeof item.value === "number");
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
  { id: "cpu_usage", label: "CPU" },
  { id: "memory_used_total", label: "Memory" },
  { id: "swap_used_total", label: "Swap" },
  { id: "load_avg_triplet", label: "Load" },
  { id: "thermal", label: "Thermal" },
  { id: "fan", label: "Fan" },
];

const DEFAULT_THRESHOLDS = {
  age_warn_ms: 15000,
  age_stale_ms: 60000,
  cpu_warn_pct: 80,
  cpu_hot_pct: 95,
  cpu_temp_warn_c: 80,
  cpu_temp_crit_c: 90,
  fan_ok_ratio_warn: 1.0,
  node_power_warn_w: 600,
  node_power_hot_w: 900,
  total_power_warn_w: 2000,
  total_power_hot_w: 3000,
};

const THRESHOLD_INPUT_IDS = {
  age_warn_ms: "th-age-warn",
  age_stale_ms: "th-age-stale",
  cpu_warn_pct: "th-cpu-warn",
  cpu_hot_pct: "th-cpu-hot",
  cpu_temp_warn_c: "th-cpu-temp-warn",
  cpu_temp_crit_c: "th-cpu-temp-crit",
  fan_ok_ratio_warn: "th-fan-ok-ratio",
  node_power_warn_w: "th-node-power-warn",
  node_power_hot_w: "th-node-power-hot",
  total_power_warn_w: "th-total-power-warn",
  total_power_hot_w: "th-total-power-hot",
};

const THRESHOLD_STORAGE_KEY = "hpc_thresholds_v1";

let selectedPointIds = new Set(METRIC_POINTS.map((point) => point.id));
let pointSelectionCustomized = false;
let testPanelEnabled = false;
let thresholds = loadThresholds();

function normalizeThresholds(raw) {
  const merged = { ...DEFAULT_THRESHOLDS, ...(raw || {}) };
  const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  merged.age_warn_ms = Math.max(1000, Math.round(toNumber(merged.age_warn_ms, DEFAULT_THRESHOLDS.age_warn_ms)));
  merged.age_stale_ms = Math.max(1000, Math.round(toNumber(merged.age_stale_ms, DEFAULT_THRESHOLDS.age_stale_ms)));
  if (merged.age_stale_ms <= merged.age_warn_ms) {
    merged.age_stale_ms = merged.age_warn_ms + 1000;
  }
  merged.cpu_warn_pct = clampPercent(toNumber(merged.cpu_warn_pct, DEFAULT_THRESHOLDS.cpu_warn_pct));
  merged.cpu_hot_pct = clampPercent(toNumber(merged.cpu_hot_pct, DEFAULT_THRESHOLDS.cpu_hot_pct));
  if (merged.cpu_hot_pct <= merged.cpu_warn_pct) {
    merged.cpu_hot_pct = Math.min(100, merged.cpu_warn_pct + 1);
  }
  merged.cpu_temp_warn_c = toNumber(merged.cpu_temp_warn_c, DEFAULT_THRESHOLDS.cpu_temp_warn_c);
  merged.cpu_temp_crit_c = toNumber(merged.cpu_temp_crit_c, DEFAULT_THRESHOLDS.cpu_temp_crit_c);
  merged.fan_ok_ratio_warn = Math.max(0, Math.min(1, toNumber(merged.fan_ok_ratio_warn, DEFAULT_THRESHOLDS.fan_ok_ratio_warn)));
  merged.node_power_warn_w = Math.max(1, toNumber(merged.node_power_warn_w, DEFAULT_THRESHOLDS.node_power_warn_w));
  merged.node_power_hot_w = Math.max(1, toNumber(merged.node_power_hot_w, DEFAULT_THRESHOLDS.node_power_hot_w));
  if (merged.node_power_hot_w <= merged.node_power_warn_w) {
    merged.node_power_hot_w = merged.node_power_warn_w + 1;
  }
  merged.total_power_warn_w = Math.max(1, toNumber(merged.total_power_warn_w, DEFAULT_THRESHOLDS.total_power_warn_w));
  merged.total_power_hot_w = Math.max(1, toNumber(merged.total_power_hot_w, DEFAULT_THRESHOLDS.total_power_hot_w));
  if (merged.total_power_hot_w <= merged.total_power_warn_w) {
    merged.total_power_hot_w = merged.total_power_warn_w + 1;
  }
  return merged;
}

function loadThresholds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(THRESHOLD_STORAGE_KEY) || "{}");
    return normalizeThresholds(parsed);
  } catch (_) {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function saveThresholds() {
  localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify(thresholds));
}

function renderThresholdPanelValues() {
  for (const [key, elementId] of Object.entries(THRESHOLD_INPUT_IDS)) {
    const element = document.getElementById(elementId);
    if (!element) continue;
    const value = thresholds[key];
    if (key.endsWith("_ms")) {
      element.value = String(Math.round(value / 1000));
    } else if (key === "fan_ok_ratio_warn") {
      element.value = value.toFixed(2);
    } else {
      element.value = String(Math.round(value));
    }
  }
}

function setupThresholdPanel() {
  const panel = document.getElementById("threshold-panel");
  const showButton = document.getElementById("show-threshold-panel");
  const hideButton = document.getElementById("hide-threshold-panel");
  const storageKey = "hpc_threshold_panel_hidden";

  const setPanelHidden = (hidden) => {
    panel.classList.toggle("hidden", hidden);
    showButton.classList.toggle("hidden", !hidden);
    localStorage.setItem(storageKey, hidden ? "1" : "0");
  };

  setPanelHidden(localStorage.getItem(storageKey) === "1");
  showButton.addEventListener("click", () => setPanelHidden(false));
  hideButton.addEventListener("click", () => setPanelHidden(true));

  renderThresholdPanelValues();
  refreshWarningCaseOptionLabels();
  document.getElementById("threshold-apply").addEventListener("click", async () => {
    const next = { ...thresholds };
    for (const [key, elementId] of Object.entries(THRESHOLD_INPUT_IDS)) {
      const element = document.getElementById(elementId);
      if (!element) continue;
      const parsed = Number(element.value);
      if (!Number.isFinite(parsed)) continue;
      if (key.endsWith("_ms")) {
        next[key] = parsed * 1000;
      } else {
        next[key] = parsed;
      }
    }
    thresholds = normalizeThresholds(next);
    saveThresholds();
    renderThresholdPanelValues();
    refreshWarningCaseOptionLabels();
    await refresh();
  });
  document.getElementById("threshold-reset").addEventListener("click", async () => {
    thresholds = { ...DEFAULT_THRESHOLDS };
    saveThresholds();
    renderThresholdPanelValues();
    refreshWarningCaseOptionLabels();
    await refresh();
  });
}

function refreshWarningCaseOptionLabels() {
  const select = document.getElementById("warning-case");
  if (!select) return;
  const setLabel = (value, label) => {
    const option = select.querySelector(`option[value="${value}"]`);
    if (option) option.textContent = label;
  };
  setLabel("no_response_warn", `No response warn (${Math.round(thresholds.age_warn_ms / 1000)}s)`);
  setLabel("no_response_stale", `No response stale (${Math.round(thresholds.age_stale_ms / 1000)}s)`);
  setLabel("cpu_warn", `CPU warn (${Math.round(thresholds.cpu_warn_pct)}%)`);
  setLabel("cpu_hot", `CPU hot (${Math.round(thresholds.cpu_hot_pct)}%)`);
  setLabel("cpu_temp_warn", `CPU temp warn (${Math.round(thresholds.cpu_temp_warn_c)}°C)`);
  setLabel("cpu_temp_crit", `CPU temp crit (${Math.round(thresholds.cpu_temp_crit_c)}°C)`);
  setLabel("fan_ok_ratio_warn", `Fan OK ratio warn (${thresholds.fan_ok_ratio_warn.toFixed(2)})`);
  setLabel("node_power_warn", `Node power warn (${Math.round(thresholds.node_power_warn_w)}W)`);
  setLabel("node_power_hot", `Node power hot (${Math.round(thresholds.node_power_hot_w)}W)`);
  setLabel("total_power_warn", `Total power warn (${Math.round(thresholds.total_power_warn_w)}W)`);
  setLabel("total_power_hot", `Total power hot (${Math.round(thresholds.total_power_hot_w)}W)`);
}

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
  const estimatedTotalPowerWatts = nodes.length * (350 + avgCpu * 45);
  const totalPowerWatts = measuredPowerWatts > 0 ? measuredPowerWatts : estimatedTotalPowerWatts;

  let healthText = "Systems All Good";
  let healthColor = "var(--light-green)";
  const staleCount = nodes.filter((node) => node.age_ms >= thresholds.age_stale_ms).length;
  const hotCount = cpuValues.filter((value) => value >= thresholds.cpu_hot_pct).length;
  const hasAgeWarn = nodes.some((node) => node.age_ms >= thresholds.age_warn_ms);
  const hasCpuWarn = cpuValues.some((value) => value >= thresholds.cpu_warn_pct);
  const hasThermalCrit = details.some((detail) => {
    const metrics = detail.latest.metrics;
    const cpu = metricValueAny(metrics, "thermal", ["cpu_package_max_c", "cpu_package0_c"]);
    return cpu >= thresholds.cpu_temp_crit_c;
  });
  const hasFanDegraded = details.some((detail) => {
    const metrics = detail.latest.metrics;
    const count = metricValue(metrics, "fan", "count");
    const ok = metricValue(metrics, "fan", "ok_count");
    if (count <= 0) return false;
    return ok / count < thresholds.fan_ok_ratio_warn;
  });
  const hasNodePowerHot = details.some((detail) => metricValue(detail.latest.metrics, "power", "watts") >= thresholds.node_power_hot_w);
  const hasNodePowerWarn = details.some((detail) => metricValue(detail.latest.metrics, "power", "watts") >= thresholds.node_power_warn_w);
  const hasTotalPowerHot = totalPowerWatts >= thresholds.total_power_hot_w;
  const hasTotalPowerWarn = totalPowerWatts >= thresholds.total_power_warn_w;

  if (hotCount > 0 || hasThermalCrit || hasFanDegraded || hasNodePowerHot || hasTotalPowerHot) {
    healthText = "Alert Detected";
    healthColor = "var(--sweet-peony)";
  } else if (staleCount > 0) {
    healthText = "Worker Not Responding";
    healthColor = "var(--sweet-peony)";
  } else if (hasAgeWarn && !hasCpuWarn) {
    healthText = "Worker Not Responding";
    healthColor = "#f2b84b";
  } else if (hasAgeWarn || hasCpuWarn || hasNodePowerWarn || hasTotalPowerWarn) {
    healthText = "Load Elevated";
    healthColor = "#f2b84b";
  }

  document.getElementById("power-draw").textContent = fmtNumber(totalPowerWatts, 0);
  document.getElementById("cluster-meta").textContent = healthText;
  document.getElementById("cluster-meta").style.color = healthColor;
  document.getElementById("brand-status-dot").style.background = healthColor;
}

function renderFooter(nodes) {
  const maxAge = nodes.length ? nodes.reduce((max, node) => Math.max(max, node.age_ms), 0) : 0;
  const live = nodes.filter((node) => node.age_ms < thresholds.age_warn_ms).length;
  document.getElementById("uptime-indicator").textContent = `Nodes live: ${live}/${nodes.length}`;
  document.getElementById("latency-indicator").textContent = `Data Age(max): ${fmtNumber(maxAge / 1000, 2)}s`;
}

function renderPointRow(pointId, metrics, issues) {
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
    const cpuToneClass = issues.cpuHot ? "alert" : issues.cpuWarn ? "warn" : "";
    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">CPU</span></span>
          <span class="metric-right">
            ${ringMarkup(cpu, `${fmtNumber(cpu, 0)}%`, `large${cpuToneClass ? ` ${cpuToneClass}` : ""}`)}
          </span>
        </div>
      </div>
    `;
  }

  if (pointId === "load_avg_triplet") {
    const loadToneClass = issues.stale || issues.cpuHot ? "alert" : issues.cpuWarn ? "warn" : "";
    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">Load</span></span>
          <span class="load-triplet${loadToneClass ? ` ${loadToneClass}` : ""}">
            <span class="load-chip"><span>1m</span><strong>${fmtNumber(load1, 2)}</strong></span>
            <span class="load-chip"><span>5m</span><strong>${fmtNumber(load5, 2)}</strong></span>
            <span class="load-chip"><span>15m</span><strong>${fmtNumber(load15, 2)}</strong></span>
          </span>
        </div>
      </div>
    `;
  }

  if (pointId === "memory_used_total") {
    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">Memory</span></span>
          <span class="metric-right">
            ${ringMarkup(memPct, `${fmtNumber(kbToGiB(memUsedKb), 1)}G`, "alt large")}
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
            ${ringMarkup(swapPct, `${fmtNumber(kbToGiB(swapUsedKb), 1)}G`, "alt large")}
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
    const hot = cpuPkgMax >= thresholds.cpu_temp_crit_c;
    const warm = !hot && cpuPkgMax >= thresholds.cpu_temp_warn_c;
    const tone = hot ? "crit" : warm ? "warn" : "";

    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">Thermal</span><span class="metric-sub">°C</span></span>
        </div>
        ${
          !thermalAvailable
            ? '<div class="text-meta">Unavailable</div>'
            : `<div class="kv-list ${tone}">
                <span>CPU <strong>${fmtNumber(cpuPkgMax, 1)}</strong></span>
                <span>NVMe <strong>${fmtNumber(nvmeMax, 1)}</strong></span>
                <span>NIC <strong>${fmtNumber(nicMax, 1)}</strong></span>
                <span>PCH <strong>${fmtNumber(chipset, 1)}</strong></span>
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
    const fanAlert = fanAvailable && fanCount > 0 && (okCount / fanCount) < thresholds.fan_ok_ratio_warn;
    const avgKrpm = avgRpm / 1000.0;
    const minKrpm = minRpm / 1000.0;
    const maxKrpm = maxRpm / 1000.0;
    return `
      <div class="metric-row">
        <div class="metric-head">
          <span class="metric-label"><span class="metric-main">Fan</span><span class="metric-sub">kRPM</span></span>
        </div>
        ${
          !fanAvailable
            ? '<div class="text-meta">Unavailable</div>'
            : `<div class="kv-list${fanAlert ? " crit" : ""}">
                <span>Avg <strong>${fmtNumber(avgKrpm, 2)}</strong></span>
                <span>Min <strong>${fmtNumber(minKrpm, 2)}</strong></span>
                <span>Max <strong>${fmtNumber(maxKrpm, 2)}</strong></span>
                <span>OK <strong>${fmtNumber(okCount, 0)}/${fmtNumber(fanCount, 0)}</strong></span>
              </div>`
        }
      </div>
    `;
  }

  return "";
}

function pointHasData(pointId, metrics) {
  if (pointId === "cpu_usage") return hasMetric(metrics, "cpu", "usage");
  if (pointId === "memory_used_total") return hasMetric(metrics, "memory", "used") && hasMetric(metrics, "memory", "total");
  if (pointId === "swap_used_total") return hasMetric(metrics, "memory", "swap_used") && hasMetric(metrics, "memory", "swap_total");
  return true;
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
    const nodePowerHot = powerAvailable && powerWatts >= thresholds.node_power_hot_w;
    const nodePowerWarn = powerAvailable && !nodePowerHot && powerWatts >= thresholds.node_power_warn_w;
    const cpuPkgMax = metricValueAny(metrics, "thermal", ["cpu_package_max_c", "cpu_package0_c"]);
    const nvmeMax = metricValue(metrics, "thermal", "nvme_max_c");
    const nicMax = metricValue(metrics, "thermal", "nic_max_c");
    const chipset = metricValue(metrics, "thermal", "chipset_c");
    const thermalCrit =
      cpuPkgMax >= thresholds.cpu_temp_crit_c;
    const thermalWarn = !thermalCrit && cpuPkgMax >= thresholds.cpu_temp_warn_c;
    const fanCount = metricValue(metrics, "fan", "count");
    const fanOkCount = metricValue(metrics, "fan", "ok_count");
    const fanDegraded = fanCount > 0 && (fanOkCount / fanCount) < thresholds.fan_ok_ratio_warn;
    const stale = node.age_ms >= thresholds.age_stale_ms;
    const ageWarn = !stale && node.age_ms >= thresholds.age_warn_ms;
    const nodeTimestamp = formatTimestamp(detail.latest.timestamp_ms);
    const subtitle = stale || ageWarn
      ? `Worker not responding (last response: ${formatAge(node.age_ms)} at ${nodeTimestamp})`
      : `Last data: ${nodeTimestamp}`;
    const ageTone = ageClass(node.age_ms, thresholds);
    const cpuHot = cpu >= thresholds.cpu_hot_pct;
    const cpuWarn = !cpuHot && cpu >= thresholds.cpu_warn_pct;
    const alert = stale || cpuHot || thermalCrit || fanDegraded || nodePowerHot;
    const elevated = !alert && (ageWarn || cpuWarn || thermalWarn || nodePowerWarn);
    const issues = { stale, ageWarn, cpuHot, cpuWarn };

    const topRowCandidates = ["cpu_usage", "memory_used_total", "swap_used_total"];
    const selectedIds = new Set(selectedRows.map((row) => row.id));
    const topRowIds = topRowCandidates.filter((id) => selectedIds.has(id) && pointHasData(id, metrics));
    const topCols = Math.max(1, Math.min(3, topRowIds.length));

    const topRowHtml =
      topRowIds.length > 0
        ? `<div class="metric-top-row cols-${topCols}">
            ${topRowIds.map((id) => `<div class="metric-top-cell">${renderPointRow(id, metrics, issues)}</div>`).join("")}
          </div>`
        : "";

    const loadVisible = selectedIds.has("load_avg_triplet");
    const loadRowHtml = loadVisible
      ? `<div class="metric-mid-row">
          <div class="metric-mid-cell">${renderPointRow("load_avg_triplet", metrics, issues)}</div>
        </div>`
      : "";

    const bottomRowIds = ["thermal", "fan"].filter((id) => selectedIds.has(id));
    const bottomCols = Math.max(1, Math.min(2, bottomRowIds.length));
    const bottomRowHtml =
      bottomRowIds.length > 0
        ? `<div class="metric-bottom-row cols-${bottomCols}">
            ${bottomRowIds.map((id) => `<div class="metric-bottom-cell">${renderPointRow(id, metrics, issues)}</div>`).join("")}
          </div>`
        : "";

    const extraRowsHtml = selectedRows
      .filter((row) => !topRowCandidates.includes(row.id) && row.id !== "load_avg_triplet" && row.id !== "thermal" && row.id !== "fan")
      .map((row) => renderPointRow(row.id, metrics, issues))
      .join("");

    const anySectionVisible = topRowHtml || loadRowHtml || bottomRowHtml || extraRowsHtml;
    const metricsHtml = anySectionVisible ? `${loadRowHtml}${bottomRowHtml}${extraRowsHtml}` : "<div class=\"text-meta\">No metric selected</div>";

    const card = document.createElement("article");
    card.className = `pebble-card node-card${alert ? " alert" : elevated ? " warn" : ""}`;
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
          <div class="node-power${nodePowerHot ? " alert" : nodePowerWarn ? " warn" : ""}">${powerAvailable ? `${fmtNumber(powerWatts, 0)}W` : "--"}</div>
          <div class="node-orb-wrap">
            <div class="node-orb ${stale ? "alert" : ageTone}"></div>
          </div>
        </div>
      </div>
      ${topRowHtml}
      ${metricsHtml}
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
    refreshWarningCaseOptionLabels();
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

    document.getElementById("apply-warning-case").addEventListener("click", async () => {
      const select = document.getElementById("warning-case");
      const warningCase = select.value || "reset";
      await postJson("/api/test/warning-case", { case: warningCase });
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

setupThresholdPanel();
