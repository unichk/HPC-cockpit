# HPC Worker (Base)

This is a lightweight worker designed for HPC nodes.

- Collectors are modular (`cpu`, `memory`, `load`, `thermal`, `power`, `fan` built in).
- Transport is pluggable (`stdout`, `udp` built in).
- Server/UI lives in `../server`.

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

Install service files (requires root, rebuilds worker first, enables + starts by default):

```bash
sudo ./systemd/install-service.sh
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

Uninstall service (always purges config + state):

```bash
sudo ./systemd/uninstall-service.sh
```

Dry-run install/uninstall:

```bash
sudo ./systemd/install-service.sh --dry-run
sudo ./systemd/uninstall-service.sh --dry-run
```

Skip auto-enable/start if needed:

```bash
sudo ./systemd/install-service.sh --no-enable --no-start
```

Keep existing config/state during reinstall:

```bash
sudo ./systemd/install-service.sh --no-clean-reinstall
```

Root runtime note:
- The service runs as root now to support future root-only collectors.
- A later hardening step can split privileged collectors into a narrow helper while keeping the main worker unprivileged.

## Config format

`config/worker.conf` uses `key=value`:

- `node_id`: unique node name (optional, defaults to hostname)
- `interval_ms`: sampling interval in milliseconds
- `transport`: transport adapter name
- `transport_udp_host`: destination IPv4 address for UDP transport
- `transport_udp_port`: destination UDP port for UDP transport
- `modules`: comma-separated collector modules

If `node_id` is omitted, worker uses the machine hostname.

Example:

```text
interval_ms=5000
transport=stdout
transport_udp_host=127.0.0.1
transport_udp_port=9000
modules=cpu,memory,load,thermal,power,fan
```

UDP mode example:

```text
interval_ms=5000
transport=udp
transport_udp_host=192.168.1.50
transport_udp_port=9000
modules=cpu,memory,load,thermal,power,fan
```

Thermal thresholds emitted by `thermal` collector:
- CPU package: warn `80C`, critical `90C`
- NVMe composite: warn `70C`, critical `80C`
- NIC: warn `85C`, critical `95C`
- Chipset/PCH: warn `75C`, critical `85C`

Host portability notes:
- `cpu`, `memory`, `load` are Linux `/proc` based and portable across most Linux hosts.
- `thermal` and `power` currently parse `sensors` CLI output (depends on `lm-sensors` and board sensor exposure).
- `fan` currently parses `ipmitool sdr type Fan` output (depends on BMC/IPMI availability and permissions).
- On hosts without those capabilities, these collectors report `available=0` instead of failing the worker.

Protocol contract:
- Transport sends one JSON snapshot per UDP datagram.
- Payload schema matches stdout JSON fields (`node_id`, `timestamp_ms`, `metrics[]`).
- UDP is lossy by design; dropped packets are expected under congestion.

Receiver quick test:

```bash
nc -u -l -p 9000
```

If your `nc` uses OpenBSD-style flags:

```bash
nc -u -l 9000
```

Troubleshooting:
- `nc -lnvp 9000` listens on TCP. UDP transport requires `-u`.
- After config changes under service mode, run `sudo systemctl restart hpc-worker`.
- Check worker logs with `sudo journalctl -u hpc-worker -f`.
- Verify packets on receiver with `sudo tcpdump -n -i any udp port 9000`.

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
