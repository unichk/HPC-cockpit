// Status wall: one light per node x subsystem, plus a strip of cluster-wide
// services. Lights come from two places:
//   - the worker's "health" module (disk, nfs, ib, net, svc, slurm, gpu, bmc):
//     each metric is one check, value 0 OK / 1 warning / 2 failure, with text
//   - rules over metrics the cockpit already collects (thermal alert levels,
//     fans, memory, power, freshness)
// Clicking a light lists every check behind it and the runbook for that part.

const { useState, useEffect, useMemo } = React;

const STATUS_POLL_MS = 3000;
// SCC26 cluster power cap (nodes + IB switch).
const CLUSTER_BUDGET_W = 10000;
const CLUSTER_WARN_W = 9500;
// A health module older than this is shown as unknown rather than trusted.
const HEALTH_STALE_MS = 120000;

const OK = 0, WARN = 1, FAIL = 2, UNKNOWN = -1;
const STATUS_CLASS = { [OK]: "ok", [WARN]: "warn", [FAIL]: "fail", [UNKNOWN]: "unknown" };

const COLUMNS = [
  { key: "node", label: "Node" },
  { key: "cpu", label: "CPU" },
  { key: "mem", label: "Mem" },
  { key: "gpu", label: "GPU" },
  { key: "thrm", label: "Therm" },
  { key: "fan", label: "Fan" },
  { key: "pwr", label: "Power" },
  { key: "disk", label: "Disk" },
  { key: "nfs", label: "NFS" },
  { key: "ib", label: "IB" },
  { key: "net", label: "Net" },
  { key: "svc", label: "Svc" },
];

// Health-module groups feeding each column.
const HEALTH_GROUPS = {
  gpu: ["gpu"], pwr: ["bmc"], disk: ["disk"], nfs: ["nfs"],
  ib: ["ib"], net: ["net"], svc: ["svc", "slurm"],
};

// What each light means and where to look when it is not green. This is the
// "the system is sluggish, where do you go" runbook, one part at a time.
const RUNBOOK = {
  node: {
    title: "Node reporting",
    what: "The node's cockpit worker is sending data. Silence means the node is down, hung, off the network, or hpc-worker stopped.",
    steps: [
      ["Is the node up and reachable?", "ping <node>; ssh <node> uptime"],
      ["Is the worker running?", "systemctl status hpc-worker; journalctl -u hpc-worker -n 50"],
      ["Does Slurm see it?", "sinfo -N -l; scontrol show node <node>"],
      ["No ssh at all: use the BMC console / power state", "ipmitool -I lanplus -H <bmc> -U admin -E chassis status"],
    ],
  },
  cpu: {
    title: "CPU",
    what: "Package temperature against the BMC's thresholds, and every core online. High utilization alone is not a fault.",
    steps: [
      ["Who is using it?", "top -o %CPU; ps -eo pid,user,pcpu,comm --sort=-pcpu | head"],
      ["Frequency, governor, throttling", "cpupower frequency-info; grep MHz /proc/cpuinfo | sort -k4 -n | tail -3"],
      ["Jobs on this node", "squeue -w <node> -o '%i %u %j %C %M'"],
      ["Offline cores / MCE errors", "lscpu | grep -i on-line; dmesg -T | grep -i -E 'mce|machine check'"],
    ],
  },
  mem: {
    title: "Memory",
    what: "RAM use (warn 90%, fail 97%) and swap activity. Swapping on a compute node makes everything sluggish.",
    steps: [
      ["Overall and per process", "free -h; ps -eo pid,user,rss,comm --sort=-rss | head"],
      ["Swap activity (si/so columns)", "vmstat 1 5"],
      ["OOM kills", "dmesg -T | grep -i -E 'out of memory|oom'"],
      ["Slurm memory limits of running jobs", "sstat -j <jobid> -o JobID,MaxRSS; scontrol show job <jobid> | grep -i mem"],
    ],
  },
  gpu: {
    title: "GPU",
    what: "All GPUs visible to the driver, temperature, uncorrected ECC / row remapping, hardware slowdown (not the normal power-cap throttle), and Xid errors in the kernel log.",
    steps: [
      ["State of all GPUs", "nvidia-smi; nvidia-smi -q -d PERFORMANCE | grep -A12 'Clocks Event'"],
      ["Memory errors / row remapping", "nvidia-smi -q -d ECC,ROW_REMAPPER"],
      ["Xid errors", "journalctl -k --since -1h | grep -i xid"],
      ["Missing GPU: compare PCI vs driver", "lspci -d 10de: | wc -l; nvidia-smi -L | wc -l"],
      ["Who is on the GPUs", "nvidia-smi --query-compute-apps=pid,used_memory --format=csv"],
    ],
  },
  thrm: {
    title: "Thermal",
    what: "Board, VR, NIC, NVMe, PSU and DIMM sensors from the BMC, each against its own warning / critical threshold.",
    steps: [
      ["All BMC temperature sensors", "ipmitool sdr type Temperature"],
      ["Fan profile in effect (cockpit settings page / BMC)", "ipmitool sdr type Fan"],
      ["Hot spot vs inlet: is the room or the fan curve the problem?", "open the node page in the cockpit for per-sensor history"],
    ],
  },
  fan: {
    title: "Fans",
    what: "Every populated fan spinning above its lower threshold.",
    steps: [
      ["Fan readings and thresholds", "ipmitool sdr type Fan"],
      ["BMC event log (fan failures, removals)", "ipmitool sel elist | tail -20"],
    ],
  },
  pwr: {
    title: "Power",
    what: "Node power reading available, the BMC answering Redfish, and each PSU's own health. A disabled PSU is the configured layout, not a fault.",
    steps: [
      ["PSU states from the BMC", "ipmitool sdr type 'Power Supply'; ipmitool sel elist | tail"],
      ["Node power now", "ipmitool dcmi power reading"],
      ["Cluster total vs the 10 kW cap", "Grafana: cockpit:cluster_power_watts"],
    ],
  },
  disk: {
    title: "Local disks",
    what: "Local filesystem use (warn 85%, fail 95%), software RAID state and NVMe SMART health (critical warning, wear, media errors).",
    steps: [
      ["Space and inodes", "df -h; df -i"],
      ["What is filling it", "du -xh --max-depth=1 / 2>/dev/null | sort -h | tail"],
      ["RAID", "cat /proc/mdstat; mdadm --detail /dev/md0"],
      ["NVMe health", "nvme smart-log /dev/nvme0  (or: smartctl -a /dev/nvme0)"],
      ["I/O saturation", "iostat -x 1 3"],
    ],
  },
  nfs: {
    title: "NFS",
    what: "Every NFS mount answers within 2 s, and its usage. A hung mount freezes logins and any job touching /mnt/home or /work.",
    steps: [
      ["Is it hung? (this blocks if so)", "timeout 3 stat -f /mnt/home && echo ok"],
      ["Client RPC stats: retrans climbing = server or network trouble", "nfsstat -c; nfsstat -m"],
      ["Server side on ntu-scc01", "systemctl status nfs-server; exportfs -v; cat /proc/mdstat"],
      ["Network path (NFS runs over IPoIB)", "ping ntu-scc01-ib5"],
    ],
  },
  ib: {
    title: "InfiniBand",
    what: "Every IB port ACTIVE / LinkUp at the node's full rate, and no error counters rising in the last 15 minutes.",
    steps: [
      ["Port state and rate", "ibstat; ibstatus"],
      ["Error counters on a port", "perfquery -x  (or: cat /sys/class/infiniband/mlx5_0/ports/1/counters/*error*)"],
      ["Subnet manager present (ports stuck in INIT = no SM)", "sminfo"],
      ["Fabric-wide view", "ibnetdiscover; iblinkinfo"],
      ["Bandwidth between two nodes", "ib_write_bw (server) / ib_write_bw <host> (client)"],
    ],
  },
  net: {
    title: "Ethernet",
    what: "Every Ethernet port with an address has link at 1 Gb/s or more. Ports without an address are listed as unused.",
    steps: [
      ["Link state, speed, errors", "ip -br link; ethtool eno1; ip -s link show eno1"],
      ["Reachability", "ping -c3 <gateway or other node>"],
    ],
  },
  svc: {
    title: "Services",
    what: "Key systemd services (Slurm, munge, sssd, NFS, LDAP, Prometheus, ...) enabled and running, any other failed units, and this node's Slurm state (drain / down).",
    steps: [
      ["Failed units", "systemctl --failed"],
      ["A service's recent log", "journalctl -u <service> -n 50 --no-pager"],
      ["Slurm node state and reason", "sinfo -R; scontrol show node <node>"],
      ["Return a drained node to service", "scontrol update nodename=<node> state=resume"],
      ["munge / auth", "munge -n | unmunge; id <user>"],
    ],
  },
  cluster: {
    title: "Cluster services",
    what: "Services that exist once per cluster, the IB switch, and total power against the 10 kW cap.",
    steps: [
      ["Slurm controller / database", "scontrol ping; sacctmgr show cluster"],
      ["LDAP", "ldapsearch -x -ZZ -H ldap://ntu-scc04 -b dc=scc26,dc=ntu,dc=local -s base"],
      ["Prometheus / Grafana", "curl -s http://ntu-scc04:9090/-/healthy; curl -s http://ntu-scc04:3000/api/health"],
      ["IB switch", "ibswitches; switch_power.py --once --dry-run"],
    ],
  },
};

function statusOf(items) {
  if (!items.length) return UNKNOWN;
  return items.reduce((worst, it) => Math.max(worst, it.status), OK);
}

function fmtAge(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  return `${(ms / 3600000).toFixed(1)} h`;
}

// Turn one node from /api/nodes into {column: [{status, text}]}.
function evaluateNode(node) {
  const idx = indexMetrics(node.metrics);
  const has = (k) => typeof idx[k] === "number";
  const cells = {};
  const add = (col, status, text) => (cells[col] = cells[col] || []).push({ status, text });

  // Freshness
  const age = node.age_ms || 0;
  add("node", age <= 15000 ? OK : age <= 60000 ? WARN : FAIL,
      age <= 15000 ? `reporting (last data ${fmtAge(age)} ago)` : `no data for ${fmtAge(age)}`);
  const stale = age > 60000;

  // Health module checks
  const healthAge = (node.module_ages_ms || {}).health;
  const healthFresh = typeof healthAge === "number" && healthAge <= HEALTH_STALE_MS;
  for (const m of node.metrics || []) {
    if (m.module !== "health" || typeof m.value !== "number") continue;
    const group = String(m.name).split(":")[0];
    const col = Object.keys(HEALTH_GROUPS).find((c) => HEALTH_GROUPS[c].includes(group));
    if (!col) continue;
    add(col, healthFresh ? m.value : UNKNOWN,
        (m.text || m.name) + (healthFresh ? "" : " (stale)"));
  }
  if (typeof healthAge !== "number") {
    for (const col of ["disk", "nfs", "ib", "net", "svc"]) {
      add(col, UNKNOWN, "health collector not reporting (worker needs the 'health' module)");
    }
  }

  // CPU
  if (has("thermal.cpu_alert_level")) {
    add("cpu", idx["thermal.cpu_alert_level"],
        `package max ${Math.round(idx["thermal.cpu_max_c"] || 0)} °C ` +
        `(warn ${Math.round(idx["thermal.cpu_warn_c"] || 0)}, crit ${Math.round(idx["thermal.cpu_crit_c"] || 0)})`);
  }
  if (has("cpu.core_count") && has("cpu.cores_online")) {
    const off = idx["cpu.core_count"] - idx["cpu.cores_online"];
    add("cpu", off > 0 ? WARN : OK,
        off > 0 ? `${off} of ${idx["cpu.core_count"]} cores offline`
                : `${idx["cpu.core_count"]} cores online, ${Math.round(idx["cpu.usage"] || 0)}% busy`);
  }

  // Memory
  if (has("memory.used_pct")) {
    const pct = idx["memory.used_pct"];
    add("mem", pct >= 97 ? FAIL : pct >= 90 ? WARN : OK,
        `${pct.toFixed(0)}% of ${kbToGiB(idx["memory.total"]).toFixed(0)} GiB used`);
  }
  if (idx["memory.swap_total"] > 0) {
    const swapPct = 100 * (idx["memory.swap_used"] || 0) / idx["memory.swap_total"];
    add("mem", swapPct >= 50 ? WARN : OK,
        `swap ${swapPct.toFixed(0)}% used (${kbToGiB(idx["memory.swap_used"] || 0).toFixed(1)} GiB)`);
  }

  // GPU temperature (presence, ECC, Xid come from the health module)
  if (has("gpu.temp_max_c") && idx["gpu.count"] > 0) {
    const t = idx["gpu.temp_max_c"];
    const warn = idx["thermal.gpu_warn_c"] || 85, crit = idx["thermal.gpu_crit_c"] || 90;
    add("gpu", t >= crit ? FAIL : t >= warn ? WARN : OK,
        `${idx["gpu.count"]} GPUs, hottest ${Math.round(t)} °C (warn ${Math.round(warn)}, crit ${Math.round(crit)}), ` +
        `${Math.round(idx["gpu.power_sum_w"] || 0)} W total`);
  }

  // Thermal domains other than CPU and GPU, which have their own columns
  if (idx["thermal.available"] === 0) add("thrm", UNKNOWN, "no BMC temperature readings");
  for (const dom of ["board", "vr", "nic", "nvme", "psu", "dimm"]) {
    const k = `thermal.${dom}_alert_level`;
    if (!has(k)) continue;
    add("thrm", idx[k], `${dom.toUpperCase()}: max ${Math.round(idx[`thermal.${dom}_max_c`] || 0)} °C ` +
        `(${idx[`thermal.${dom}_count`] || "?"} sensors)`);
  }

  // Fans
  if (idx["fan.available"] === 0) {
    add("fan", UNKNOWN, "no fan readings from the BMC");
  } else if (has("fan.count")) {
    const n = idx["fan.count"], okc = idx["fan.ok_count"] || 0;
    add("fan", okc < n ? FAIL : OK,
        okc < n ? `${n - okc} of ${n} fans below threshold` : `${n} fans OK, avg ${Math.round(idx["fan.avg_rpm"] || 0)} rpm`);
  }

  // Power reading
  if (idx["power.available"] === 0) {
    add("pwr", FAIL, "no power reading from the BMC");
  } else if (has("power.watts")) {
    const src = idx["power.source_code"] === 3 ? "Redfish PSU output" : "IPMI DCMI (75 W steps)";
    add("pwr", OK, `${Math.round(idx["power.watts"])} W via ${src}`);
  }

  if (stale) {
    for (const col of Object.keys(cells)) {
      if (col === "node") continue;
      cells[col] = cells[col].map((it) => ({ status: UNKNOWN, text: it.text + " (last known, node silent)" }));
    }
  }
  return cells;
}

// Cluster-wide strip: services that run once, found on whichever node
// reports them, plus the IB switch and the power budget.
function evaluateCluster(nodes, aux) {
  const CLUSTER_UNITS = [
    ["slurmctld", "Slurm controller"],
    ["slurmdbd", "Slurm database"],
    ["slapd", "LDAP"],
    ["nfs-server", "NFS server"],
    ["mariadb", "MariaDB"],
    ["prometheus", "Prometheus"],
    ["grafana-server", "Grafana"],
  ];
  const out = [];
  for (const [unit, label] of CLUSTER_UNITS) {
    const found = [];
    for (const node of nodes) {
      const m = (node.metrics || []).find((x) => x.module === "health" && x.name === `svc:${unit}`);
      if (m) found.push({ status: node.age_ms > 60000 ? UNKNOWN : m.value, text: `${node.node_id}: ${m.text}` });
    }
    if (!found.length && unit === "mariadb") continue;  // optional
    out.push({
      key: unit, label, where: found.map((f) => f.text.split(":")[0]).join(", "),
      items: found.length ? found : [{ status: UNKNOWN, text: `${unit}: not reported by any node (not a systemd unit, or not installed)` }],
    });
  }

  // Slurm node states together
  const slurm = [];
  for (const node of nodes) {
    const m = (node.metrics || []).find((x) => x.module === "health" && x.name === "slurm:node");
    if (m) slurm.push({ status: m.value, text: `${node.node_id}: ${m.text}` });
  }
  if (slurm.length) {
    const usable = slurm.filter((s) => s.status === OK).length;
    out.push({ key: "slurm-nodes", label: "Slurm nodes", where: `${usable}/${slurm.length} usable`, items: slurm });
  }

  // IB switch: its power poller doubles as a liveness check.
  const sw = (aux || []).find((a) => a.source.startsWith("ib-"));
  out.push({
    key: "ib-switch", label: "IB switch", where: sw ? sw.source : "",
    items: [sw ? { status: OK, text: `${sw.source} answering, ${Math.round(sw.watts)} W` }
               : { status: WARN, text: "no data from the switch power poller (switch down, or switch_power.py not running)" }],
  });

  // Power budget
  let total = 0, counted = 0;
  const parts = [];
  for (const node of nodes) {
    const idx = indexMetrics(node.metrics);
    if (typeof idx["power.watts"] === "number" && node.age_ms <= 60000) {
      total += idx["power.watts"]; counted++;
      parts.push(`${node.node_id} ${Math.round(idx["power.watts"])} W`);
    }
  }
  for (const a of aux || []) { total += a.watts; parts.push(`${a.source} ${Math.round(a.watts)} W`); }
  out.push({
    key: "power", label: "Cluster power", where: counted ? `${(total / 1000).toFixed(2)} kW` : "",
    items: counted
      ? [{ status: total >= CLUSTER_BUDGET_W ? FAIL : total >= CLUSTER_WARN_W ? WARN : OK,
           text: `${Math.round(total)} W of ${CLUSTER_BUDGET_W} W budget (instantaneous)` },
         { status: OK, text: parts.join(" · ") }]
      : [{ status: UNKNOWN, text: "no node power readings" }],
  });
  return out;
}

function Light({ status, count, selected, onClick, title }) {
  const cls = STATUS_CLASS[status];
  return (
    <button className={`st-light ${cls} ${selected ? "selected" : ""}`} onClick={onClick} title={title}>
      {status === UNKNOWN ? "?" : count > 1 && status !== OK ? count : ""}
    </button>
  );
}

function StatusPage() {
  const [data, setData] = useState({ nodes: [], aux_power: [] });
  const [updated, setUpdated] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(null);  // {row, col} or {cluster: key}
  const [me, setMe] = useState(null);
  useEffect(() => { window.cockpitAuth.me().then(setMe); }, []);

  useEffect(() => {
    const cached = readCachedSettings();
    if (cached && cached.theme) document.documentElement.dataset.theme = cached.theme;
    loadSettings().then((s) => { if (s && s.theme) document.documentElement.dataset.theme = s.theme; });
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/nodes", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        if (!alive) return;
        setData({ nodes: body.nodes || [], aux_power: body.aux_power || [] });
        setUpdated(Date.now());
        setError(null);
      } catch (e) {
        if (alive) setError(String(e.message || e));
      }
    };
    tick();
    const h = setInterval(tick, STATUS_POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, []);

  const rows = useMemo(() => data.nodes.map((n) => ({ id: n.node_id, cells: evaluateNode(n) })), [data]);
  const cluster = useMemo(() => evaluateCluster(data.nodes, data.aux_power), [data]);

  const tally = { [OK]: 0, [WARN]: 0, [FAIL]: 0, [UNKNOWN]: 0 };
  for (const r of rows) for (const c of COLUMNS) { const it = r.cells[c.key]; if (it) tally[statusOf(it)]++; }
  for (const c of cluster) tally[statusOf(c.items)]++;

  // Default selection: the first red, else the first yellow light.
  let selected = sel;
  if (!selected) {
    outer: for (const want of [FAIL, WARN]) {
      for (const c of cluster) if (statusOf(c.items) === want) { selected = { cluster: c.key }; break outer; }
      for (const r of rows) for (const c of COLUMNS) {
        const it = r.cells[c.key];
        if (it && statusOf(it) === want) { selected = { row: r.id, col: c.key }; break outer; }
      }
    }
  }

  let detail = null;
  if (selected && selected.cluster) {
    const c = cluster.find((x) => x.key === selected.cluster);
    if (c) detail = { title: `Cluster · ${c.label}`, items: c.items, book: RUNBOOK.cluster };
  } else if (selected) {
    const r = rows.find((x) => x.id === selected.row);
    const items = r && r.cells[selected.col];
    if (items) detail = { title: `${selected.row} · ${COLUMNS.find((c) => c.key === selected.col).label}`,
                          items, book: RUNBOOK[selected.col] };
  }
  const sortedItems = detail ? [...detail.items].sort((a, b) => b.status - a.status) : [];

  return (
    <div className="st-layout">
      <div className="st-topbar">
        <a className="st-back" href="index.html">← Cockpit</a>
        <div>
          <div className="st-title">System status</div>
          <div className="st-sub">
            {error ? `server unreachable: ${error}` : updated ? `updated ${new Date(updated).toLocaleTimeString()}` : "loading…"}
          </div>
        </div>
        <div className="st-spacer" />
        {me && me.user && (
          <button className="st-chip" style={{ cursor: "pointer", fontFamily: "inherit" }}
                  onClick={() => window.cockpitAuth.logout()} title="Log out">
            {me.user} · log out
          </button>
        )}
        <div className="st-tally">
          <span className="st-chip"><span className="st-dot ok" />{tally[OK]} OK</span>
          <span className="st-chip"><span className="st-dot warn" />{tally[WARN]} warning</span>
          <span className="st-chip"><span className="st-dot fail" />{tally[FAIL]} failed</span>
          {tally[UNKNOWN] > 0 && <span className="st-chip"><span className="st-dot unknown" />{tally[UNKNOWN]} unknown</span>}
        </div>
      </div>

      <div className="st-body">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          <div className="st-card">
            <h2>Nodes</h2>
            <div className="st-matrix-wrap">
              <table className="st-matrix">
                <thead>
                  <tr>
                    <th className="st-rowhead" />
                    {COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={COLUMNS.length + 1} className="st-empty">No nodes reporting.</td></tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="st-rowhead"><a href={`node.html?node=${encodeURIComponent(r.id)}`}>{r.id}</a></td>
                      {COLUMNS.map((c) => {
                        const items = r.cells[c.key];
                        if (!items) return <td key={c.key}><span className="st-light na">–</span></td>;
                        const st = statusOf(items);
                        const bad = items.filter((i) => i.status === st).length;
                        const isSel = selected && selected.row === r.id && selected.col === c.key;
                        return (
                          <td key={c.key}>
                            <Light status={st} count={bad} selected={isSel}
                                   title={items.filter((i) => i.status === st).map((i) => i.text).join("\n")}
                                   onClick={() => setSel({ row: r.id, col: c.key })} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="st-legend">
              <span><span className="st-light ok" />OK</span>
              <span><span className="st-light warn" />warning</span>
              <span><span className="st-light fail" />failed</span>
              <span><span className="st-light unknown" />unknown / stale</span>
              <span><span className="st-light na">–</span>not applicable</span>
              <span>number = how many checks are at that level</span>
            </div>
          </div>

          <div className="st-card">
            <h2>Cluster</h2>
            <div className="st-cluster">
              {cluster.map((c) => {
                const st = statusOf(c.items);
                const isSel = selected && selected.cluster === c.key;
                return (
                  <button key={c.key} className={`st-cl-item ${isSel ? "selected" : ""}`}
                          onClick={() => setSel({ cluster: c.key })}>
                    <span className={`st-light ${STATUS_CLASS[st]}`} />
                    {c.label}
                    {c.where && <span className="st-cl-where">{c.where}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="st-card st-detail">
          {!detail ? (
            <div className="st-empty">Everything is green. Click any light to see the checks behind it and how to investigate.</div>
          ) : (
            <>
              <h3>{detail.title}</h3>
              <div className="st-what">{detail.book.what}</div>
              <ul className="st-items">
                {sortedItems.map((it, i) => (
                  <li key={i} className={STATUS_CLASS[it.status]}>
                    <span className={`st-dot ${STATUS_CLASS[it.status]}`} />
                    <span className="st-item-text">{it.text}</span>
                  </li>
                ))}
              </ul>
              <div className="st-runbook">
                <h4>Investigate</h4>
                <ol>
                  {detail.book.steps.map(([why, cmd], i) => (
                    <li key={i}>{why}<code>{cmd}</code></li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<StatusPage />);
