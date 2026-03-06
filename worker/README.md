# HPC Worker (Base)

This is a lightweight worker designed for HPC nodes.

- Collectors are modular (`cpu`, `memory`, `load` built in).
- Transport is pluggable (`stdout` built in).
- Server is intentionally not included yet.

## Build

```bash
cd worker
cmake -S . -B build
cmake --build build -j
```

## Run

```bash
cd worker
./build/hpc_worker config/worker.conf
```

## Run As Service (`systemd`, root runtime)

This worker can run as a system service with `journald` logging and auto-restart.

Install service files (requires root, rebuilds worker first):

```bash
sudo ./systemd/install-service.sh --enable --start
```

Service operations:

```bash
sudo systemctl status hpc-worker
sudo systemctl restart hpc-worker
sudo systemctl stop hpc-worker
sudo systemctl start hpc-worker
```

Logs:

```bash
sudo journalctl -u hpc-worker -f
```

Uninstall service:

```bash
sudo ./systemd/uninstall-service.sh
```

Purge service + config + state:

```bash
sudo ./systemd/uninstall-service.sh --purge
```

Dry-run install/uninstall:

```bash
sudo ./systemd/install-service.sh --dry-run --enable --start
sudo ./systemd/uninstall-service.sh --dry-run --purge
```

Root runtime note:
- The service runs as root now to support future root-only collectors.
- A later hardening step can split privileged collectors into a narrow helper while keeping the main worker unprivileged.

## Config format

`config/worker.conf` uses `key=value`:

- `node_id`: unique node name
- `interval_ms`: sampling interval in milliseconds
- `transport`: transport adapter name
- `modules`: comma-separated collector modules

If `node_id` is omitted, worker uses the machine hostname.

Example:

```text
interval_ms=5000
transport=stdout
modules=cpu,memory,load
```

## Extend collectors

1. Add a new file in `src/collectors/`, implement `Collector`.
2. Expose a factory function (e.g., `CreateDiskCollector()`).
3. Register it in `src/collector_registry.cpp`.
4. Add source file in `CMakeLists.txt`.

## Extend transport

1. Add a new file in `src/transports/`, implement `Transport`.
2. Expose factory (e.g., `CreateHttpTransport()`).
3. Register it in `src/transport_registry.cpp`.
4. Add source file in `CMakeLists.txt`.
