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

## Config format

`config/worker.conf` uses `key=value`:

- `node_id`: unique node name
- `interval_ms`: sampling interval in milliseconds
- `transport`: transport adapter name
- `modules`: comma-separated collector modules

Example:

```text
node_id=node-01
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
