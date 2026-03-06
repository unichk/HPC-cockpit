# HPC Cockpit

This repository contains a lightweight HPC worker and service tooling.

## Current scope

- Worker agent in C++ (`worker/`)
- Modular collectors and transports
- `systemd` service install/uninstall scripts
- Architecture notes (`docs/`)

Server/UI is not implemented yet.

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
sudo ./systemd/install-service.sh --enable --start
sudo systemctl status hpc-worker
```

Service logs:

```bash
sudo journalctl -u hpc-worker -f
```

## Repo layout

- `worker/`: worker source, build script, config, systemd files
- `docs/`: architecture and design notes

## Main docs

- Worker usage: `worker/README.md`
- Architecture: `docs/hpc-cluster-monitor-architecture.md`
