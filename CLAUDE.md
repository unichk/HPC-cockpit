# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HPC Cockpit is a lightweight HPC cluster monitoring system. Compute nodes run a C++ worker agent that collects metrics and sends them via UDP to a Python server, which serves a real-time web dashboard.

## Commands

### Server (Python)

```bash
cd server
python3 server.py                          # Default: UDP :9000, HTTP :8080
python3 server.py --test-panel             # Enable test/injection UI panel
python3 server.py --udp-port 9001 --http-port 8081  # Custom ports
```

### Worker (C++)

```bash
cd worker
./build.sh                                 # Build (cmake preferred, g++ fallback)
./build/hpc_worker config/worker.conf      # Run directly
```

```bash
# Install/manage as systemd service
sudo ./systemd/install-service.sh
sudo systemctl status hpc-worker
sudo journalctl -u hpc-worker -f
```

### Testing

No automated test suite exists. Use the built-in test panel:
- Start server with `--test-panel`
- Use the UI to inject fake nodes or trigger specific warning cases
- For UDP packet inspection: `nc -u -l 9000`

## Architecture

```
[Compute Nodes]
  hpc_worker (C++ systemd service)
    → collectors: cpu, memory, load, thermal, power, fan
    → serializes JSON snapshot every N ms
    → sends via UDP

[Server Node]
  server.py (Python, stdlib only)
    → UdpHandler: receives & parses UDP JSON into StateStore
    → StateStore: holds latest snapshot per node_id (in-memory, no persistence)
    → ApiHandler: serves static web/ files + REST API at /api/*

[Browser]
  app.js polls /api/nodes + /api/cluster every ~1-2s
  → renders node grid, thresholds, alarms, power summary
  node.js renders per-node detail page
```

### Wire Protocol

The worker sends JSON snapshots over UDP:
```json
{"node_id": "...", "timestamp_ms": 123456789, "metrics": [...]}
```
Each metric: `{"name": "cpu.usage", "value": 72.5}` (or `"string_value"` for fan health).

Delivery is lossy (UDP, at-most-once). The server tracks staleness by `timestamp_ms`.

### Server (`server/server.py`)

- **No external dependencies** — pure Python stdlib
- `StateStore`: central state; keyed by `node_id`; stores only the latest snapshot per node
- `ApiHandler`: HTTP handler that serves `web/` as static files and handles `/api/*` routes
- Two `ThreadingUDPServer` + `ThreadingHTTPServer` run concurrently in threads
- Test endpoints: `POST /api/test/fake-nodes`, `POST /api/test/warning-case`

### Worker (`worker/src/`)

- **Pluggable collectors** implement `Collector` interface (`Name()`, `Collect()`) — registered in `collector_registry.cpp`
- **Pluggable transports** implement `Transport` interface (`Name()`, `Send(snapshot)`) — registered in `transport_registry.cpp`
- Collectors requiring external tools: `thermal_collector` and `power_collector` shell out to `sensors`; `fan_collector` shells out to `ipmitool sdr type Fan`
- Main loop in `worker.cpp`: steady_clock timer → collect → send

### Frontend (`server/web/`)

- Vanilla JS, no build step, no framework
- `app.js`: dashboard polling loop, threshold system (persisted in localStorage), Web Audio alarm system, node grid rendering
- `node.js`: per-node detail view
- Thresholds generate alert levels (0=ok, 1=warn, 2=crit) used for coloring and audio alarms

## Configuration

Worker config (`worker/config/worker.conf`) key fields:
- `node_id`: defaults to hostname
- `interval_ms`: collection interval
- `transport`: `stdout` or `udp`
- `transport_udp_host` / `transport_udp_port`: UDP destination
- `modules`: comma-separated collector names (`cpu,memory,load,thermal,power,fan`)
