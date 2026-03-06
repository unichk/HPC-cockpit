# HPC Cluster Monitor Architecture

## Current repository status

Implemented now:
- Modular C++ worker with pluggable collectors and transports.
- Built-in collectors: `cpu`, `memory`, `load`.
- Built-in transports: `stdout`, `udp`.
- System `systemd` service support (`hpc-worker.service`) with root runtime.

Not implemented yet:
- Disk/network/GPU collectors.
- Privilege split between main worker and root-only helper.

## Runtime model

- One worker process per node.
- Worker reads lightweight kernel data (`/proc`, `/sys`) on a fixed interval.
- Worker sends one snapshot each interval.
- Main deployment path is a system service with restart and `journald` logs.

## Transport and wire contract (current)

- Recommended current transport for remote receive: `udp`.
- `udp` sends one JSON snapshot per datagram to configured IPv4 `host:port`.
- Payload fields:
  - `node_id` (defaults to hostname if omitted in config)
  - `timestamp_ms`
  - `metrics[]` with `{module,name,value,unit}`
- Delivery semantics: at-most-once, lossy under congestion/network issues.

## Lightweight worker principles

- No per-process scans by default.
- No expensive vendor CLI calls in the hot path.
- Small fixed work per interval.
- Keep heavy analytics/query/UI on the future server side.

## Metrics scope

Current metrics:
- CPU usage.
- Load averages (avg1/avg5/avg15).
- Memory used/total and swap used/total.

Planned next metrics:
- Disk capacity and I/O counters.
- Network counters.
- Optional GPU/scheduler/IPMI modules as opt-in.

## Network topology guidance

- Direct node -> laptop/server receive is simplest when routing allows.
- If compute nodes cannot reach laptop directly, use a login/head-node relay.
