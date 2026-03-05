# HPC Cluster Monitor: Laptop UI + Ultra‑Light Workers

## Architecture (minimal)

- **Worker (every node):** read a small set of kernel counters (`/proc`, `/sys`) on a fixed interval (e.g., 5s), batch a few samples, send to the laptop.
- **Laptop server:** ingest → store time-series on disk → compute aggregates/graphs → serve UI.
- **Typical HPC wiring:** if nodes can’t reach your laptop directly, use a **login/head node as a dumb relay** (forward packets/streams; no DB, no analytics).

Worker rules to stay lightweight:
- No per-process scanning by default, no frequent vendor CLIs, no unbounded buffering (drop when offline).

## What to collect (monitoring-only)

Include these fields in every sample:
- **Identity/health:** `node_id`, `timestamp`, `uptime`, `boot_id` (or similar), agent version, “last error / drops”.

Core metrics (cheap, high value):
- **CPU:** total utilization split (user/system/iowait/idle), load average, runnable threads (optional).
- **Memory:** total, used, available, swap used, major page faults (optional).
- **Disk capacity:** per mount (used/free, inode usage).
- **Disk I/O (counters):** read/write bytes, IOPS, queue time if available.
- **Network (counters):** rx/tx bytes, packets, errors/drops per interface.

Optional (enable only if you need it):
- **GPU:** utilization, memory used, temperature, power draw (if available cheaply).
- **Scheduler context (Slurm/PBS):** current job id(s) on node, user, partition/queue (avoid high-frequency queries).
- **Temps/power/IPMI:** usually privileged and heavier; keep off by default.

Practical sampling defaults:
- **5s** for “live dashboard”, **15–30s** for long-term trends; send in small batches (e.g., 3–10 samples).
