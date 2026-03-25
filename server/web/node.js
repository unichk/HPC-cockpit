function getNodeId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("node") || "";
}

let metricsOpen = false;
let sortByNameAsc = true;
let sortByModuleAsc = true;
let sortField = "name";
let latestMetrics = [];
const THRESHOLD_STORAGE_KEY = "hpc_thresholds_v2";
const NODE_DEFAULT_THRESHOLDS = {
  age_warn_ms: 15000,
  age_stale_ms: 60000,
  cpu_warn_pct: 80,
  cpu_hot_pct: 95,
  cpu_temp_warn_c: 80,
  cpu_temp_crit_c: 90,
  fan_ok_ratio_warn: 1.0,
  node_power_warn_w: 1700,
  node_power_hot_w: 1900,
  total_power_warn_w: 4500,
  total_power_hot_w: 4800,
};
let thresholds = loadThresholds();

function normalizeThresholds(raw) {
  const merged = { ...NODE_DEFAULT_THRESHOLDS, ...(raw || {}) };
  const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  merged.age_warn_ms = Math.max(1000, Math.round(toNumber(merged.age_warn_ms, NODE_DEFAULT_THRESHOLDS.age_warn_ms)));
  merged.age_stale_ms = Math.max(1000, Math.round(toNumber(merged.age_stale_ms, NODE_DEFAULT_THRESHOLDS.age_stale_ms)));
  merged.cpu_warn_pct = Math.max(0, Math.min(100, toNumber(merged.cpu_warn_pct, NODE_DEFAULT_THRESHOLDS.cpu_warn_pct)));
  merged.cpu_hot_pct = Math.max(0, Math.min(100, toNumber(merged.cpu_hot_pct, NODE_DEFAULT_THRESHOLDS.cpu_hot_pct)));
  merged.cpu_temp_warn_c = toNumber(merged.cpu_temp_warn_c, NODE_DEFAULT_THRESHOLDS.cpu_temp_warn_c);
  merged.cpu_temp_crit_c = toNumber(merged.cpu_temp_crit_c, NODE_DEFAULT_THRESHOLDS.cpu_temp_crit_c);
  merged.fan_ok_ratio_warn = Math.max(0, Math.min(1, toNumber(merged.fan_ok_ratio_warn, NODE_DEFAULT_THRESHOLDS.fan_ok_ratio_warn)));
  merged.node_power_warn_w = Math.max(1, toNumber(merged.node_power_warn_w, NODE_DEFAULT_THRESHOLDS.node_power_warn_w));
  merged.node_power_hot_w = Math.max(1, toNumber(merged.node_power_hot_w, NODE_DEFAULT_THRESHOLDS.node_power_hot_w));
  if (merged.node_power_hot_w <= merged.node_power_warn_w) {
    merged.node_power_hot_w = merged.node_power_warn_w + 1;
  }
  merged.total_power_warn_w = Math.max(1, toNumber(merged.total_power_warn_w, NODE_DEFAULT_THRESHOLDS.total_power_warn_w));
  merged.total_power_hot_w = Math.max(1, toNumber(merged.total_power_hot_w, NODE_DEFAULT_THRESHOLDS.total_power_hot_w));
  if (merged.total_power_hot_w <= merged.total_power_warn_w) {
    merged.total_power_hot_w = merged.total_power_warn_w + 1;
  }
  return merged;
}

function loadThresholds() {
  try {
    return normalizeThresholds(JSON.parse(localStorage.getItem(THRESHOLD_STORAGE_KEY) || "{}"));
  } catch (_) {
    return { ...NODE_DEFAULT_THRESHOLDS };
  }
}

function fmtValue(value, unit) {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "kb") return `${(value / (1024 * 1024)).toFixed(2)} GiB`;
  if (unit === "watt") return `${value.toFixed(1)} W`;
  if (unit === "rpm") return `${value.toFixed(0)} RPM`;
  if (unit === "celsius") return `${value.toFixed(1)} °C`;
  return `${value.toFixed(3)} ${unit || ""}`.trim();
}

function formatTimestamp(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms) || ms <= 0) return "--";
  return new Date(ms).toLocaleTimeString();
}

function formatAge(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms) || ms < 0) return "--";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function clampPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function metricValue(metrics, moduleName, metricName) {
  const match = (metrics || []).find((item) => item.module === moduleName && item.name === metricName);
  return match && typeof match.value === "number" ? match.value : 0;
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`request failed: ${path} (${response.status})`);
  return response.json();
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`request failed: ${path} (${response.status})`);
  return response.json();
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

function renderMetrics(metrics) {
  const rows = (metrics || [])
    .slice()
    .sort((a, b) => {
      if (sortField === "module") {
        const moduleCompare = `${a.module || ""}`.localeCompare(`${b.module || ""}`);
        if (moduleCompare !== 0) return sortByModuleAsc ? moduleCompare : -moduleCompare;
        return `${a.name || ""}`.localeCompare(`${b.name || ""}`);
      }
      const nameCompare = `${a.name || ""}`.localeCompare(`${b.name || ""}`);
      if (nameCompare !== 0) return sortByNameAsc ? nameCompare : -nameCompare;
      return `${a.module || ""}`.localeCompare(`${b.module || ""}`);
    })
    .map(
      (metric) => `
      <tr>
        <td>${metric.module || "--"}</td>
        <td>${metric.name || "--"}</td>
        <td>${fmtValue(metric.value, metric.unit)}</td>
        <td>${metric.unit || "--"}</td>
      </tr>`
    )
    .join("");

  if (!rows) {
    return `<p>No metrics</p>`;
  }

  return `
    <table>
      <thead>
        <tr>
          <th><button class="sort-name-btn" data-sort-module="1" type="button">Module ${sortField === "module" ? (sortByModuleAsc ? "▲" : "▼") : ""}</button></th>
          <th><button class="sort-name-btn" data-sort-name="1" type="button">Name ${sortField === "name" ? (sortByNameAsc ? "▲" : "▼") : ""}</button></th>
          <th>Value</th>
          <th>Unit</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderNodeVisual(metrics) {
  const cpu = clampPercent(metricValue(metrics, "cpu", "usage"));
  const memUsedKb = metricValue(metrics, "memory", "used");
  const memTotalKb = metricValue(metrics, "memory", "total");
  const memPct = memTotalKb > 0 ? clampPercent((memUsedKb / memTotalKb) * 100) : 0;
  const swapUsedKb = metricValue(metrics, "memory", "swap_used");
  const swapTotalKb = metricValue(metrics, "memory", "swap_total");
  const swapPct = swapTotalKb > 0 ? clampPercent((swapUsedKb / swapTotalKb) * 100) : 0;
  const load1 = metricValue(metrics, "load", "avg1");
  const load5 = metricValue(metrics, "load", "avg5");
  const load15 = metricValue(metrics, "load", "avg15");
  const thermalItems = (metrics || [])
    .filter((item) => item.module === "thermal" && typeof item.value === "number")
    .filter((item) => item.name.endsWith("_c"))
    .filter((item) => !item.name.endsWith("_warn_c") && !item.name.endsWith("_crit_c"))
    .map((item) => ({
      label: item.name
        .replace(/^cpu_package/, "cpu#")
        .replace(/_max_c$/, "_max")
        .replace(/_c$/, "")
        .replace(/_/g, " "),
      value: `${item.value.toFixed(1)}°C`,
      tone: item.value >= thresholds.cpu_temp_crit_c ? "alert" : item.value >= thresholds.cpu_temp_warn_c ? "warn" : "",
    }));

  const fanItems = (metrics || [])
    .filter((item) => item.module === "fan" && typeof item.value === "number")
    .filter((item) => item.name.endsWith("_rpm"))
    .filter((item) => !["min_rpm", "max_rpm", "avg_rpm"].includes(item.name))
    .map((item) => ({
      label: item.name.replace(/_rpm$/, "").replace(/_/g, " "),
      value: `${item.value.toFixed(0)} RPM`,
      tone: "",
    }));
  const missingFanItems = (metrics || [])
    .filter((item) => item.module === "fan" && typeof item.value === "number" && item.value > 0)
    .filter((item) => item.name.startsWith("missing_"))
    .map((item) => item.name.replace(/^missing_/, "").replace(/_/g, " "));
  const fanDisplayItems = fanItems
    .concat(missingFanItems.map((label) => ({ label, value: "--", tone: "alert" })))
    .sort((a, b) => a.label.localeCompare(b.label));

  const cpuTone = cpu >= thresholds.cpu_hot_pct ? "alert" : cpu >= thresholds.cpu_warn_pct ? "warn" : "";

  return `
    <div class="node-visual-grid">
      <div class="node-visual-item bar-item ${cpuTone}">
        <div class="label">CPU</div>
        <div class="bar-row">
          <div class="value">${cpu.toFixed(1)}%</div>
          <div class="bar-track"><div class="bar-fill cpu ${cpuTone}" style="width:${cpu.toFixed(1)}%"></div></div>
        </div>
      </div>

      <div class="node-visual-item bar-item">
        <div class="label">Memory</div>
        <div class="bar-row">
          <div class="value">${(memUsedKb / (1024 * 1024)).toFixed(1)} / ${(memTotalKb / (1024 * 1024)).toFixed(1)} G</div>
          <div class="bar-track"><div class="bar-fill memory" style="width:${memPct.toFixed(1)}%"></div></div>
          <div class="value">${(swapUsedKb / (1024 * 1024)).toFixed(1)} / ${(swapTotalKb / (1024 * 1024)).toFixed(1)} G</div>
          <div class="bar-track"><div class="bar-fill swap" style="width:${swapPct.toFixed(1)}%"></div></div>
        </div>
      </div>

      <div class="node-visual-item">
        <div class="label">Temp</div>
        <div class="sensor-grid">
          ${
            thermalItems.length > 0
              ? thermalItems
                  .map(
                    (item) =>
                      `<div class="sensor-item ${item.tone}"><span class="sensor-label">${item.label}</span><strong class="sensor-value">${item.value}</strong></div>`
                  )
                  .join("")
              : '<div class="sensor-item"><span class="sensor-label">temp</span><strong class="sensor-value">--</strong></div>'
          }
        </div>
      </div>

      <div class="node-visual-item">
        <div class="label">Fan</div>
        <div class="sensor-grid">
          ${
            fanDisplayItems.length > 0
              ? fanDisplayItems
                  .map(
                    (item) =>
                      `<div class="sensor-item ${item.tone}"><span class="sensor-label">${item.label}</span><strong class="sensor-value">${item.value}</strong></div>`
                  )
                  .join("")
              : '<div class="sensor-item"><span class="sensor-label">fan</span><strong class="sensor-value">--</strong></div>'
          }
        </div>
      </div>

      <div class="node-visual-item full">
        <div class="label">Load</div>
        <div class="chips">
          <span class="chip">1m ${load1.toFixed(2)}</span>
          <span class="chip">5m ${load5.toFixed(2)}</span>
          <span class="chip">15m ${load15.toFixed(2)}</span>
        </div>
      </div>
    </div>
  `;
}

function updateStatus(ageMs) {
  const dot = document.getElementById("node-status-dot");
  const text = document.getElementById("node-status-text");
  dot.classList.remove("warn", "alert");
  if (ageMs >= thresholds.age_stale_ms) {
    dot.classList.add("alert");
    text.textContent = `Worker not responding (stale, ${formatAge(ageMs)})`;
  } else if (ageMs >= thresholds.age_warn_ms) {
    dot.classList.add("warn");
    text.textContent = `Worker delayed (${formatAge(ageMs)})`;
  } else {
    text.textContent = "Worker healthy";
  }
}

async function refreshNode() {
  thresholds = loadThresholds();
  refreshWarningCaseOptionLabels();
  const nodeId = getNodeId();
  if (!nodeId) {
    document.getElementById("node-status-text").textContent = "Missing node id";
    return;
  }

  const detail = await fetchJson(`/api/node/${encodeURIComponent(nodeId)}`);
  const latest = detail.latest || {};
  const metrics = latest.metrics || [];
  latestMetrics = metrics;
  const ageMs = Math.max(0, Date.now() - (latest.received_at_ms || 0));
  const powerW = metricValue(metrics, "power", "watts");
  const cpu = clampPercent(metricValue(metrics, "cpu", "usage"));
  const cpuTemp = metricValue(metrics, "thermal", "cpu_package_max_c") || metricValue(metrics, "thermal", "cpu_package0_c");
  const fanCount = metricValue(metrics, "fan", "count");
  const fanOkCount = metricValue(metrics, "fan", "ok_count");
  const fanWarn = fanCount > 0 && (fanOkCount / fanCount) < thresholds.fan_ok_ratio_warn;
  const stale = ageMs >= thresholds.age_stale_ms;
  const delayed = !stale && ageMs >= thresholds.age_warn_ms;
  const cpuHot = cpu >= thresholds.cpu_hot_pct;
  const cpuWarn = !cpuHot && cpu >= thresholds.cpu_warn_pct;
  const tempHot = cpuTemp >= thresholds.cpu_temp_crit_c;
  const tempWarn = !tempHot && cpuTemp >= thresholds.cpu_temp_warn_c;
  const powerHot = powerW >= thresholds.node_power_hot_w;
  const powerWarn = !powerHot && powerW >= thresholds.node_power_warn_w;
  const nodeAlert = stale || cpuHot || tempHot || fanWarn || powerHot;
  const nodeWarn = !nodeAlert && (delayed || cpuWarn || tempWarn || powerWarn);

  document.title = `${detail.node_id} - HPC Cockpit`;
  document.getElementById("node-title").textContent = detail.node_id || nodeId;
  document.getElementById("node-hostname").textContent = detail.node_id || "--";
  document.getElementById("node-ip").textContent = latest.remote_ip || "--";
  document.getElementById("node-power").textContent = powerW > 0 ? `${powerW.toFixed(0)} W` : "--";
  document.getElementById("node-last-time").textContent = formatTimestamp(latest.timestamp_ms);
  document.getElementById("node-age").textContent = formatAge(ageMs);
  document.getElementById("node-metric-count").textContent = String(metrics.length);
  document.getElementById("node-visual").innerHTML = renderNodeVisual(metrics);
  const summaryCard = document.querySelector(".node-summary-card");
  const powerBlock = document.querySelector(".summary-power");
  summaryCard.classList.remove("warn", "alert");
  powerBlock.classList.remove("warn", "alert");
  if (nodeAlert) summaryCard.classList.add("alert");
  else if (nodeWarn) summaryCard.classList.add("warn");
  if (powerHot) powerBlock.classList.add("alert");
  else if (powerWarn) powerBlock.classList.add("warn");
  const metricsContainer = document.getElementById("node-metrics");
  metricsContainer.innerHTML = metricsOpen ? renderMetrics(metrics) : "";
  metricsContainer.classList.toggle("hidden", !metricsOpen);
  updateStatus(ageMs);
}

function setupNodePageControls() {
  document.getElementById("metrics-toggle").addEventListener("click", () => {
    metricsOpen = !metricsOpen;
    document.getElementById("metrics-toggle").textContent = metricsOpen ? "Close" : "Open";
    const metricsContainer = document.getElementById("node-metrics");
    metricsContainer.classList.toggle("hidden", !metricsOpen);
    if (metricsOpen) {
      metricsContainer.innerHTML = renderMetrics(latestMetrics);
    }
  });

  document.getElementById("node-metrics").addEventListener("click", (event) => {
    const nameButton = event.target.closest("[data-sort-name]");
    const moduleButton = event.target.closest("[data-sort-module]");
    if (!nameButton && !moduleButton) return;
    if (nameButton) {
      if (sortField === "name") sortByNameAsc = !sortByNameAsc;
      sortField = "name";
    }
    if (moduleButton) {
      if (sortField === "module") sortByModuleAsc = !sortByModuleAsc;
      sortField = "module";
    }
    document.getElementById("node-metrics").innerHTML = renderMetrics(latestMetrics);
  });
}

async function setupTestPanel() {
  try {
    const config = await fetchJson("/api/config");
    if (!config.test_panel) return;

    const panel = document.getElementById("test-panel");
    const showButton = document.getElementById("show-test-panel");
    const hideButton = document.getElementById("hide-test-panel");
    const storageKey = "hpc_node_test_panel_hidden";
    panel.classList.remove("hidden");
    refreshWarningCaseOptionLabels();

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
      await refreshNode();
    });

    document.getElementById("apply-warning-case").addEventListener("click", async () => {
      const select = document.getElementById("warning-case");
      const warningCase = select.value || "reset";
      await postJson("/api/test/warning-case", { case: warningCase });
      await refreshNode();
    });
  } catch (_) {
    // Test panel hidden when endpoint is unavailable.
  }
}

setupNodePageControls();
setupTestPanel();
refreshNode().catch((error) => {
  document.getElementById("node-status-text").textContent = `Error: ${error.message}`;
});

setInterval(() => {
  refreshNode().catch((error) => {
    document.getElementById("node-status-text").textContent = `Error: ${error.message}`;
  });
}, 1000);
