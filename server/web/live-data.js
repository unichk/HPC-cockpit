// Live data feed: fetches /api/nodes and maps server metrics → design node shape.
// Replaces the design prototype's data.js fake generator.

const HISTORY_LEN = 60;
const POLL_MS = 1500;
const KB_PER_GIB = 1024 * 1024;

// CPU governor encoding must mirror cpu_collector.cpp's GovernorCode().
const GOVERNOR_NAMES = [null, "performance", "powersave", "schedutil", "ondemand", "conservative", "userspace"];

// Fan/chassis vendor encoding must mirror fan_collector.cpp's DetectVendor().
// Code 5 ("redfish") is not a hardware vendor — it's a fallback for ODM
// whitebox boards whose BMC exposes an AMI MegaRAC-style Redfish Thermal
// resource with a writable Oem.Public.FanControlMode field.
const FAN_VENDOR_NAMES = [null, "supermicro", "dell", "hpe", "inventec", "redfish"];

function fanVendorName(code) {
  const c = code | 0;
  return (c > 0 && c < FAN_VENDOR_NAMES.length) ? FAN_VENDOR_NAMES[c] : "unknown";
}

// GPU vendor encoding must mirror gpu_collector.cpp's GpuVendor enum.
// NOTE: UNTESTED — worker-side collector has not been exercised against a
// real GPU machine yet. See gpu_collector.cpp for details.
const GPU_VENDOR_NAMES = [null, "amd", "nvidia", "mixed"];
const GPU_MAX = 8;

function gpuVendorName(code) {
  const c = code | 0;
  return (c > 0 && c < GPU_VENDOR_NAMES.length) ? GPU_VENDOR_NAMES[c] : "unknown";
}

// UI-tuning placeholder: when the dev cluster has no GPU, synthesize fake
// per-node GPU data so the KPI tile, detail card and modal are visible.
// Turn off (set to 0) before shipping to the competition cluster.
//
// Override options:
//   - URL query param:   ?fakegpu=0   disables for one page load
//   - URL query param:   ?fakegpu=4   forces 4 fake GPUs
//   - sessionStorage:    cockpit_fake_gpu = "0" / "2" / "4" etc.
const FAKE_GPU_DEFAULT_COUNT = 0;
const FAKE_GPU_VENDOR = "amd";  // "amd" | "nvidia"

function fakeGpuCount() {
  try {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("fakegpu");
    if (q !== null) return Math.max(0, Math.min(GPU_MAX, parseInt(q, 10) || 0));
    const s = sessionStorage.getItem("cockpit_fake_gpu");
    if (s !== null) return Math.max(0, Math.min(GPU_MAX, parseInt(s, 10) || 0));
  } catch {}
  return FAKE_GPU_DEFAULT_COUNT;
}

// Build empty GPU slots (all zero / unknown vendor) so the UI renders its
// "—" placeholder fallbacks. No fake numbers — this is only to make the
// visual shape of the card visible on a GPU-less dev box.
function placeholderGpus(n) {
  const gpus = [];
  for (let i = 0; i < n; i++) {
    gpus.push({
      idx: i,
      vendor: "unknown",
      tempC: 0, utilPct: 0, powerW: 0, powerCapW: 0,
      memUsedMb: 0, memTotalMb: 0, clockMhz: 0,
    });
  }
  return {
    gpus,
    gpuCount: n,
    gpuVendor: "unknown",
    gpuTempMax: 0,
    gpuPowerSumW: 0,
    gpuUtilAvgPct: 0,
  };
}

function governorName(code) {
  const c = code | 0;
  return (c > 0 && c < GOVERNOR_NAMES.length) ? GOVERNOR_NAMES[c] : "";
}

function governorsFromMask(mask) {
  const m = mask | 0;
  const out = [];
  for (let i = 1; i < GOVERNOR_NAMES.length; i++) {
    if (m & (1 << (i - 1))) out.push(GOVERNOR_NAMES[i]);
  }
  return out;
}

// Server-backed settings persistence. Reads/writes /api/settings, with a
// localStorage cache so the UI renders immediately on next load even before
// the network round-trip completes (and as a hard fallback if the server is
// unreachable). Callers that mutate settings should call saveSettings(); the
// helper debounces+coalesces server writes to avoid hammering the endpoint.
const SETTINGS_KEY = "cockpit_settings_v1";
let _saveTimer = null;
let _pendingSettings = null;

async function loadSettings() {
  try {
    const r = await fetch("/api/settings", { cache: "no-store" });
    if (r.ok) {
      const body = await r.json();
      if (body && typeof body === "object") {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(body)); } catch {}
        return body;
      }
    }
  } catch {}
  // Fallback to whatever is cached locally.
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function readCachedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveSettings(settings) {
  // Always update the local cache immediately so a reload on the same browser
  // sees the new values even if the server is mid-flight or offline.
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  _pendingSettings = settings;
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    const payload = _pendingSettings;
    _pendingSettings = null;
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {}
  }, 350);
}

// Resolve a node's effective power thresholds. If the node has been assigned
// to a group via settings.nodeGroups[nodeId], use that group's bands from
// settings.groupAlerts; otherwise fall back to the global alerts.
function resolveNodePower(nodeId, settings) {
  const fallback = {
    nodePowerWarn: settings?.alerts?.nodePowerWarn,
    nodePowerHot:  settings?.alerts?.nodePowerHot,
  };
  const group = settings?.nodeGroups?.[nodeId];
  if (!group) return fallback;
  const ga = settings?.groupAlerts?.[group];
  if (!ga) return fallback;
  return {
    nodePowerWarn: ga.nodePowerWarn ?? fallback.nodePowerWarn,
    nodePowerHot:  ga.nodePowerHot  ?? fallback.nodePowerHot,
  };
}

// Returns the global threshold dict with the power keys overridden when the
// node belongs to a group. Pass the result to classifyNode / NodeRow.
function nodeThresholds(nodeId, settings, base) {
  const power = resolveNodePower(nodeId, settings);
  return { ...base, ...power };
}

const DEFAULT_THRESHOLDS = {
  ageWarn: 15,
  ageStale: 60,
  cpuWarn: 80,
  cpuHot: 95,
  tempWarn: 80,
  tempCrit: 90,
  fanOkRatio: 1.0,
  nodePowerWarn: 1700,
  nodePowerHot: 1900,
  totalPowerWarn: 4500,
  totalPowerHot: 4800,
};

// Per-node rolling history keyed by node_id. Persisted to sessionStorage so
// navigating between index.html / node.html / schedule.html keeps the same
// sparkline buffers instead of restarting from scratch.
const HISTORY_KEY = "cockpit_history_v1";

function loadHistoryStore() {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    const map = new Map();
    for (const [id, entry] of Object.entries(obj || {})) {
      if (!entry || typeof entry !== "object") continue;
      map.set(id, {
        cpu:   Array.isArray(entry.cpu)   ? entry.cpu.slice(-HISTORY_LEN)   : [],
        mem:   Array.isArray(entry.mem)   ? entry.mem.slice(-HISTORY_LEN)   : [],
        swap:  Array.isArray(entry.swap)  ? entry.swap.slice(-HISTORY_LEN)  : [],
        temp:  Array.isArray(entry.temp)  ? entry.temp.slice(-HISTORY_LEN)  : [],
        power: Array.isArray(entry.power) ? entry.power.slice(-HISTORY_LEN) : [],
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

const historyStore = loadHistoryStore();

let historyFlushPending = false;
function flushHistoryStore() {
  if (historyFlushPending) return;
  historyFlushPending = true;
  // Coalesce multi-node-per-tick updates into one write.
  setTimeout(() => {
    historyFlushPending = false;
    try {
      const obj = {};
      for (const [id, entry] of historyStore) obj[id] = entry;
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(obj));
    } catch {
      // quota/disabled — silently drop persistence, in-memory still works
    }
  }, 0);
}

function pushHistory(id, key, value) {
  let entry = historyStore.get(id);
  if (!entry) {
    entry = { cpu: [], mem: [], swap: [], temp: [], power: [], t: [] };
    historyStore.set(id, entry);
  }
  // Created on demand: "t" is newer than the other series, so entries restored
  // from a previous session's sessionStorage will not have it yet.
  let arr = entry[key];
  if (!Array.isArray(arr)) arr = entry[key] = [];
  arr.push(value);
  if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
  flushHistoryStore();
  return arr.slice();
}

function seedHistory(base, n = HISTORY_LEN) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(base);
  return arr;
}

// Timestamps for a seeded series: the synthetic samples are backdated one poll
// interval apart so the hover readout on a just-discovered node shows a
// sensible time axis instead of 60 identical stamps.
function seedTimes(n = HISTORY_LEN) {
  const now = Date.now();
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(now - (n - 1 - i) * POLL_MS);
  return arr;
}

function indexMetrics(metrics) {
  const idx = {};
  for (const m of metrics || []) {
    if (!m || typeof m !== "object") continue;
    const key = `${m.module}.${m.name}`;
    if (typeof m.value === "number") idx[key] = m.value;
  }
  return idx;
}

function kbToGiB(kb) {
  return kb > 0 ? kb / KB_PER_GIB : 0;
}

function pickNum(idx, ...keys) {
  for (const k of keys) {
    if (typeof idx[k] === "number") return idx[k];
  }
  return 0;
}

// Presentation order for the chassis fan banks. The BMC reports sensors in SDR
// order, which interleaves them -- on the G494 chassis SYS_FAN6/7 are listed
// after SYS_FAN12 and the two EXT fans sit in the middle of the wall -- so the
// banks are unreadable as banks unless we regroup them.
const FAN_BANK_ORDER = ["sys", "rear", "ext"];

// Split "sys_fan12_rpm" into its bank ("sys") and index (12). Handles the
// sanitised BMC names (sys_fan1, rear_fan1, ext_fan3, cpu_fan_0) and the
// generic fan_N fallback.
function fanBankAndIndex(name) {
  const base = String(name).replace(/_rpm$/, "");
  const m = base.match(/^(.*?)_?(\d+)$/);
  const idx = m ? parseInt(m[2], 10) : 0;
  const bank = (m ? m[1] : base).replace(/_?fan_?$/, "").replace(/_+$/, "");
  return { bank, idx };
}

function perFanRpms(metrics) {
  const out = [];
  const skip = new Set(["min_rpm", "max_rpm", "avg_rpm"]);
  for (const m of metrics || []) {
    if (
      m &&
      m.module === "fan" &&
      typeof m.name === "string" &&
      typeof m.value === "number" &&
      m.name.endsWith("_rpm") &&
      !skip.has(m.name)
    ) {
      const { bank, idx } = fanBankAndIndex(m.name);
      out.push({ name: m.name, rpm: m.value, bank, idx });
    }
  }
  // Known banks first in FAN_BANK_ORDER, then any unrecognised bank
  // alphabetically, and numerically within each bank.
  const rank = b => {
    const i = FAN_BANK_ORDER.indexOf(b);
    return i === -1 ? FAN_BANK_ORDER.length : i;
  };
  out.sort((a, b) =>
    rank(a.bank) - rank(b.bank) ||
    (a.bank < b.bank ? -1 : a.bank > b.bank ? 1 : 0) ||
    a.idx - b.idx
  );
  return out;
}

// Map a server node summary to the design node shape.
function mapNode(raw, nowMs) {
  const idx = indexMetrics(raw.metrics);
  const id = raw.node_id;
  const ageSec = Math.max(0, (nowMs - (raw.received_at_ms || nowMs)) / 1000);

  const cpu = pickNum(idx, "cpu.usage");
  const cpuFreqCapKhz = pickNum(idx, "cpu.freq_cap_khz");
  const cpuFreqMinKhz = pickNum(idx, "cpu.freq_min_khz");
  const cpuFreqMaxKhz = pickNum(idx, "cpu.freq_max_khz");
  const cpuFreqBiosLimitKhz = pickNum(idx, "cpu.freq_bios_limit_khz");
  const cpuGovernorCode = pickNum(idx, "cpu.governor_code");
  const cpuGovernorsMask = pickNum(idx, "cpu.governors_mask");
  const cpuCoreCount = pickNum(idx, "cpu.core_count") | 0;
  const cpuCoresOnline = pickNum(idx, "cpu.cores_online") | 0;
  const memUsedKb = pickNum(idx, "memory.used");
  const memTotalKb = pickNum(idx, "memory.total");
  const swapUsedKb = pickNum(idx, "memory.swap_used");
  const swapTotalKb = pickNum(idx, "memory.swap_total");
  const memG = kbToGiB(memUsedKb);
  const memTotalG = kbToGiB(memTotalKb);
  const swapG = kbToGiB(swapUsedKb);
  const swapTotalG = kbToGiB(swapTotalKb);
  const memPct = memTotalG > 0 ? (memG / memTotalG) * 100 : 0;
  const swapPct = swapTotalG > 0 ? (swapG / swapTotalG) * 100 : 0;

  const temp = pickNum(idx, "thermal.cpu_package_max_c", "thermal.cpu_package0_c");
  const power = pickNum(idx, "power.max_watts", "power.watts");
  const fanCount = pickNum(idx, "fan.count");
  const fanOk = pickNum(idx, "fan.ok_count");
  const fanRpm = pickNum(idx, "fan.avg_rpm");
  const fanVendorCode = pickNum(idx, "fan.vendor_code");
  // Worker packs IPv4 into a single uint32: octets in [31:24], [23:16], [15:8], [7:0].
  // We use >>> 0 to coerce to unsigned (JS bit-ops are signed 32-bit), then
  // bit-extract. Empty/0 means no BMC IP discovered → leave host falsy.
  const bmcIpPacked = pickNum(idx, "fan.bmc_ipv4_packed") >>> 0;
  const bmcHost = bmcIpPacked > 0
    ? `${(bmcIpPacked >>> 24) & 255}.${(bmcIpPacked >>> 16) & 255}.${(bmcIpPacked >>> 8) & 255}.${bmcIpPacked & 255}`
    : "";

  let gpuCount = pickNum(idx, "gpu.count") | 0;
  let gpuVendor = gpuVendorName(pickNum(idx, "gpu.vendor_code"));
  let gpuPlaceholder = false;
  let gpuTempMax = pickNum(idx, "gpu.temp_max_c");
  let gpuPowerSumW = pickNum(idx, "gpu.power_sum_w");
  let gpuUtilAvgPct = pickNum(idx, "gpu.util_avg_percent");
  let gpus = [];
  for (let i = 0; i < Math.min(gpuCount, GPU_MAX); i++) {
    gpus.push({
      idx: i,
      vendor: gpuVendorName(pickNum(idx, `gpu.${i}.vendor_code`)),
      tempC: pickNum(idx, `gpu.${i}.temp_c`),
      utilPct: pickNum(idx, `gpu.${i}.util_percent`),
      powerW: pickNum(idx, `gpu.${i}.power_w`),
      powerCapW: pickNum(idx, `gpu.${i}.power_cap_w`),
      memUsedMb: pickNum(idx, `gpu.${i}.mem_used_mb`),
      memTotalMb: pickNum(idx, `gpu.${i}.mem_total_mb`),
      clockMhz: pickNum(idx, `gpu.${i}.clock_mhz`),
    });
  }

  // UI-tuning injection: only kick in when the worker reports no GPU, so a
  // real GPU host is never touched.
  if (gpuCount === 0) {
    const fakeN = fakeGpuCount();
    if (fakeN > 0) {
      const fake = placeholderGpus(fakeN);
      gpus = fake.gpus;
      gpuCount = fake.gpuCount;
      gpuVendor = fake.gpuVendor;
      gpuTempMax = fake.gpuTempMax;
      gpuPowerSumW = fake.gpuPowerSumW;
      gpuUtilAvgPct = fake.gpuUtilAvgPct;
      gpuPlaceholder = true;
    }
  }

  const load = [
    pickNum(idx, "load.avg1"),
    pickNum(idx, "load.avg5"),
    pickNum(idx, "load.avg15"),
  ];

  // Seed history on first sight of this node so sparklines render immediately.
  if (!historyStore.has(id)) {
    historyStore.set(id, {
      cpu: seedHistory(cpu),
      mem: seedHistory(memPct),
      swap: seedHistory(swapPct),
      temp: seedHistory(temp),
      power: seedHistory(power / 10),
      t: seedTimes(),
    });
  }
  const cpuHistory = pushHistory(id, "cpu", cpu);
  const memHistory = pushHistory(id, "mem", memPct);
  const swapHistory = pushHistory(id, "swap", swapPct);
  const tempHistory = pushHistory(id, "temp", temp);
  const powerHistory = pushHistory(id, "power", power / 10);
  // One shared time axis: every series above is pushed on the same tick.
  const historyTimes = pushHistory(id, "t", Date.now());

  return {
    id,
    ip: raw.remote_ip || "",
    age: ageSec,
    offline: false,
    cpu,
    memG,
    memTotal: Math.round(memTotalG) || 1,
    memPct,
    swapG,
    swapTotal: Math.round(swapTotalG) || 1,
    swapPct,
    load,
    temp,
    power,
    fanOk,
    fanTotal: fanCount,
    fanRpm,
    fanVendor: fanVendorName(fanVendorCode),
    bmcHost,
    historyTimes,
    perFan: perFanRpms(raw.metrics),
    gpuCount,
    gpuVendor,
    gpus,
    gpuTempMax,
    gpuPowerSumW,
    gpuUtilAvgPct,
    gpuPlaceholder,
    extraThermal: {
      nvmeMax: pickNum(idx, "thermal.nvme_max_c"),
      nicMax: pickNum(idx, "thermal.nic_max_c"),
      chipset: pickNum(idx, "thermal.chipset_c"),
    },
    cpuFreqMhz: cpuFreqCapKhz > 0 ? cpuFreqCapKhz / 1000 : 0,
    cpuFreqMinMhz: cpuFreqMinKhz > 0 ? cpuFreqMinKhz / 1000 : 0,
    cpuFreqMaxMhz: cpuFreqMaxKhz > 0 ? cpuFreqMaxKhz / 1000 : 0,
    cpuFreqBiosLimitMhz: cpuFreqBiosLimitKhz > 0 ? cpuFreqBiosLimitKhz / 1000 : 0,
    cpuGovernor: governorName(cpuGovernorCode),
    cpuGovernorsAvailable: governorsFromMask(cpuGovernorsMask),
    cpuCoreCount,
    cpuCoresOnline,
    rawMetrics: raw.metrics || [],
    timestampMs: raw.timestamp_ms || 0,
    receivedAtMs: raw.received_at_ms || 0,
    cpuHistory,
    memHistory,
    swapHistory,
    tempHistory,
    powerHistory,
  };
}

function initNodes() {
  return [];
}

function classifyNode(node, thresholds) {
  if (node.offline || node.age >= thresholds.ageStale) return "crit-offline";
  const critical =
    node.cpu >= thresholds.cpuHot ||
    node.temp >= thresholds.tempCrit ||
    node.power >= thresholds.nodePowerHot ||
    (node.fanTotal > 0 && node.fanOk / node.fanTotal < thresholds.fanOkRatio) ||
    node.age >= thresholds.ageStale;
  const warn =
    node.cpu >= thresholds.cpuWarn ||
    node.temp >= thresholds.tempWarn ||
    node.power >= thresholds.nodePowerWarn ||
    node.age >= thresholds.ageWarn ||
    node.memPct >= 85 ||
    node.swapPct >= 25;
  if (critical) return "crit";
  if (warn) return "warn";
  return "ok";
}

async function fetchNodes() {
  const r = await fetch("/api/nodes", { cache: "no-store" });
  if (!r.ok) throw new Error(`/api/nodes ${r.status}`);
  const data = await r.json();
  const now = Date.now();
  const list = Array.isArray(data.nodes) ? data.nodes : [];

  // If the list endpoint doesn't embed per-node metrics (older server
  // before node_summaries started returning `metrics`), fetch each
  // node's detail in parallel and merge.
  const need = list.filter((n) => !Array.isArray(n.metrics) || n.metrics.length === 0);
  if (need.length > 0) {
    const details = await Promise.all(
      need.map(async (n) => {
        try {
          const dr = await fetch(`/api/node/${encodeURIComponent(n.node_id)}`, { cache: "no-store" });
          if (!dr.ok) return null;
          const dd = await dr.json();
          return dd && dd.latest ? { id: n.node_id, latest: dd.latest } : null;
        } catch { return null; }
      })
    );
    const byId = new Map(details.filter(Boolean).map((d) => [d.id, d.latest]));
    for (const n of list) {
      const latest = byId.get(n.node_id);
      if (latest) {
        n.metrics = latest.metrics || [];
        if (latest.timestamp_ms) n.timestamp_ms = latest.timestamp_ms;
        if (latest.received_at_ms) n.received_at_ms = latest.received_at_ms;
        if (!n.remote_ip && latest.remote_ip) n.remote_ip = latest.remote_ip;
      }
    }
  }

  return list.map((n) => mapNode(n, now));
}

async function fetchNode(nodeId) {
  const r = await fetch(`/api/node/${encodeURIComponent(nodeId)}`, { cache: "no-store" });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data || !data.latest) return null;
  const raw = {
    node_id: data.node_id || data.latest.node_id,
    remote_ip: data.latest.remote_ip,
    received_at_ms: data.latest.received_at_ms,
    timestamp_ms: data.latest.timestamp_ms,
    metrics: data.latest.metrics,
  };
  return mapNode(raw, Date.now());
}

function startLiveNodeFeed(setNodes) {
  let cancelled = false;
  const tick = async () => {
    try {
      const nodes = await fetchNodes();
      if (!cancelled) setNodes(nodes);
    } catch (err) {
      console.warn("node feed error", err);
    }
  };
  tick();
  const handle = setInterval(tick, POLL_MS);
  return () => {
    cancelled = true;
    clearInterval(handle);
  };
}

function startLiveNodeDetail(nodeId, setNode) {
  let cancelled = false;
  const tick = async () => {
    try {
      const node = await fetchNode(nodeId);
      if (!cancelled) setNode(node);
    } catch (err) {
      console.warn("node detail feed error", err);
    }
  };
  tick();
  const handle = setInterval(tick, POLL_MS);
  return () => {
    cancelled = true;
    clearInterval(handle);
  };
}

Object.assign(window, {
  initNodes,
  classifyNode,
  DEFAULT_THRESHOLDS,
  startLiveNodeFeed,
  startLiveNodeDetail,
  fetchNode,
  loadSettings,
  saveSettings,
  readCachedSettings,
  resolveNodePower,
  nodeThresholds,
});
