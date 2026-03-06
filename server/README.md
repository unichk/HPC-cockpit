# HPC Server (UDP Ingest + Web UI)

This server receives worker UDP snapshots and serves a live web dashboard.

## Run

```bash
cd server
python3 server.py
```

Defaults:
- UDP ingest: `0.0.0.0:9000`
- Web UI/API: `0.0.0.0:8080`

Open UI:
- `http://<server-ip>:8080/`

## CLI options

```bash
python3 server.py \
  --udp-host 0.0.0.0 --udp-port 9000 \
  --http-host 0.0.0.0 --http-port 8080 \
  --history-size 120
```

## Worker integration

Set worker config:

```text
transport=udp
transport_udp_host=<server-ip>
transport_udp_port=9000
```

Then restart worker.

## API endpoints

- `GET /api/health`
- `GET /api/nodes`
- `GET /api/cluster`
- `GET /api/node/<node_id>`
