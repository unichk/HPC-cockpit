# HPC Cockpit

This repository contains a lightweight HPC worker, UDP ingest server, and web UI.

## Current scope

- Worker agent in C++ (`worker/`)
- UDP ingest server + web dashboard in Python stdlib (`server/`)
- Modular collectors and transports
- `systemd` service install/uninstall scripts
- Architecture notes (`docs/`)

## Quick start

Build worker:

```bash
cd worker
./build.sh
```

Run directly:

```bash
cd worker
./build/hpc_worker config/worker.conf
```

Run as system service (root):

```bash
cd worker
sudo ./systemd/install-service.sh
sudo systemctl status hpc-worker
```

Service logs:

```bash
sudo journalctl -u hpc-worker -f
```

Run server + web UI:

```bash
cd server
python3 server.py
```

Open:

```text
http://<server-ip>:8080/
```

## Repo layout

- `worker/`: worker source, build script, config, systemd files
- `server/`: UDP ingest server, API, and web UI
- `docs/`: architecture and design notes

## Main docs

- Worker usage: `worker/README.md`
- Server usage: `server/README.md`
- Architecture: `docs/hpc-cluster-monitor-architecture.md`
