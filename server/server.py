#!/usr/bin/env python3
import argparse
import json
import os
import socketserver
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote


def now_ms() -> int:
    return int(time.time() * 1000)


class StateStore:
    def __init__(self, history_size: int) -> None:
        self._history_size = history_size
        self._lock = threading.Lock()
        self._nodes = {}
        self._ingest_count = 0
        self._ingest_errors = 0
        self._fake_node_ids = set()

    def ingest_snapshot(self, payload: bytes, remote_ip: str) -> None:
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except Exception:
            with self._lock:
                self._ingest_errors += 1
            return

        if not isinstance(parsed, dict):
            with self._lock:
                self._ingest_errors += 1
            return

        node_id = parsed.get("node_id")
        if not isinstance(node_id, str) or not node_id.strip():
            node_id = remote_ip

        timestamp_ms = parsed.get("timestamp_ms")
        if not isinstance(timestamp_ms, int):
            timestamp_ms = now_ms()

        metrics = parsed.get("metrics")
        if not isinstance(metrics, list):
            metrics = []

        snapshot = {
            "node_id": node_id,
            "timestamp_ms": timestamp_ms,
            "metrics": metrics,
            "received_at_ms": now_ms(),
            "remote_ip": remote_ip,
        }

        with self._lock:
            self._ingest_count += 1
            node_entry = self._nodes.get(node_id)
            if node_entry is None:
                node_entry = {"latest": snapshot, "history": [snapshot]}
                self._nodes[node_id] = node_entry
            else:
                node_entry["latest"] = snapshot
                node_entry["history"].append(snapshot)
                if len(node_entry["history"]) > self._history_size:
                    node_entry["history"] = node_entry["history"][-self._history_size :]

    def health(self) -> dict:
        with self._lock:
            return {
                "status": "ok",
                "nodes": len(self._nodes),
                "ingest_count": self._ingest_count,
                "ingest_errors": self._ingest_errors,
            }

    def node_summaries(self) -> list:
        current = now_ms()
        with self._lock:
            rows = []
            for node_id, node_entry in self._nodes.items():
                latest = node_entry["latest"]
                age_ms = max(0, current - latest["received_at_ms"])
                rows.append(
                    {
                        "node_id": node_id,
                        "remote_ip": latest["remote_ip"],
                        "timestamp_ms": latest["timestamp_ms"],
                        "received_at_ms": latest["received_at_ms"],
                        "age_ms": age_ms,
                        "metric_count": len(latest["metrics"]),
                    }
                )
        rows.sort(key=lambda item: item["node_id"])
        return rows

    def node_detail(self, node_id: str) -> dict:
        with self._lock:
            node_entry = self._nodes.get(node_id)
            if node_entry is None:
                return {}
            return {
                "node_id": node_id,
                "latest": node_entry["latest"],
                "history": list(node_entry["history"]),
            }

    def cluster_latest(self) -> dict:
        with self._lock:
            latest_snapshots = [entry["latest"] for entry in self._nodes.values()]

        current = now_ms()
        aggregate = {}
        for snapshot in latest_snapshots:
            for metric in snapshot.get("metrics", []):
                module = metric.get("module")
                name = metric.get("name")
                unit = metric.get("unit")
                value = metric.get("value")
                if (
                    not isinstance(module, str)
                    or not isinstance(name, str)
                    or not isinstance(unit, str)
                    or not isinstance(value, (int, float))
                ):
                    continue
                key = (module, name, unit)
                aggregate[key] = aggregate.get(key, 0.0) + float(value)

        metrics = []
        for key, value in aggregate.items():
            module, name, unit = key
            metrics.append({"module": module, "name": name, "unit": unit, "sum": value})
        metrics.sort(key=lambda item: (item["module"], item["name"], item["unit"]))

        return {
            "timestamp_ms": current,
            "node_count": len(latest_snapshots),
            "metrics": metrics,
        }

    def set_fake_nodes(self, count: int) -> dict:
        if count < 0:
            count = 0
        if count > 200:
            count = 200

        with self._lock:
            for node_id in self._fake_node_ids:
                self._nodes.pop(node_id, None)
            self._fake_node_ids.clear()

            base_total_mem_kb = 755.3 * 1024 * 1024
            base_swap_total_kb = 8.0 * 1024 * 1024
            now = now_ms()

            for index in range(1, count + 1):
                node_id = f"fake-{index:02d}"
                cpu = float((index * 17) % 100)
                load1 = round(cpu / 100.0 * 1.8, 2)
                load5 = round(load1 * 0.8, 2)
                load15 = round(load1 * 0.6, 2)
                mem_used_ratio = 0.1 + ((index * 11) % 70) / 100.0
                mem_used_kb = base_total_mem_kb * mem_used_ratio
                swap_used_kb = base_swap_total_kb * (((index * 7) % 50) / 100.0)
                cpu_pkg_c = 48.0 + ((index * 3) % 35)
                nvme_c = 35.0 + ((index * 2) % 25)
                nic_c = 45.0 + ((index * 4) % 30)
                chipset_c = 32.0 + ((index * 2) % 18)
                power_w = 220.0 + cpu * 4.2
                fan_min = 5400.0 + (index % 7) * 230.0
                fan_max = fan_min + 2600.0
                fan_avg = (fan_min + fan_max) / 2.0
                fan_count = 12.0
                fan_ok = fan_count if index % 11 else fan_count - 1
                received_at = now - (index % 5) * 8000

                snapshot = {
                    "node_id": node_id,
                    "timestamp_ms": received_at,
                    "received_at_ms": received_at,
                    "remote_ip": f"198.51.100.{index}",
                    "metrics": [
                        {"module": "cpu", "name": "usage", "value": cpu, "unit": "percent"},
                        {"module": "load", "name": "avg1", "value": load1, "unit": "ratio"},
                        {"module": "load", "name": "avg5", "value": load5, "unit": "ratio"},
                        {"module": "load", "name": "avg15", "value": load15, "unit": "ratio"},
                        {"module": "memory", "name": "used", "value": mem_used_kb, "unit": "kb"},
                        {"module": "memory", "name": "total", "value": base_total_mem_kb, "unit": "kb"},
                        {"module": "memory", "name": "swap_used", "value": swap_used_kb, "unit": "kb"},
                        {"module": "memory", "name": "swap_total", "value": base_swap_total_kb, "unit": "kb"},
                        {"module": "thermal", "name": "available", "value": 1.0, "unit": "bool"},
                        {"module": "thermal", "name": "cpu_warn_c", "value": 80.0, "unit": "celsius"},
                        {"module": "thermal", "name": "cpu_crit_c", "value": 90.0, "unit": "celsius"},
                        {"module": "thermal", "name": "nvme_warn_c", "value": 70.0, "unit": "celsius"},
                        {"module": "thermal", "name": "nvme_crit_c", "value": 80.0, "unit": "celsius"},
                        {"module": "thermal", "name": "nic_warn_c", "value": 85.0, "unit": "celsius"},
                        {"module": "thermal", "name": "nic_crit_c", "value": 95.0, "unit": "celsius"},
                        {"module": "thermal", "name": "chipset_warn_c", "value": 75.0, "unit": "celsius"},
                        {"module": "thermal", "name": "chipset_crit_c", "value": 85.0, "unit": "celsius"},
                        {"module": "thermal", "name": "cpu_package0_c", "value": cpu_pkg_c, "unit": "celsius"},
                        {"module": "thermal", "name": "cpu_package_max_c", "value": cpu_pkg_c, "unit": "celsius"},
                        {"module": "thermal", "name": "cpu_alert_level", "value": 1.0 if cpu_pkg_c >= 80.0 else 0.0, "unit": "level"},
                        {"module": "thermal", "name": "nvme_max_c", "value": nvme_c, "unit": "celsius"},
                        {"module": "thermal", "name": "nvme_alert_level", "value": 1.0 if nvme_c >= 70.0 else 0.0, "unit": "level"},
                        {"module": "thermal", "name": "nic_max_c", "value": nic_c, "unit": "celsius"},
                        {"module": "thermal", "name": "nic_alert_level", "value": 1.0 if nic_c >= 85.0 else 0.0, "unit": "level"},
                        {"module": "thermal", "name": "chipset_c", "value": chipset_c, "unit": "celsius"},
                        {"module": "thermal", "name": "chipset_alert_level", "value": 1.0 if chipset_c >= 75.0 else 0.0, "unit": "level"},
                        {"module": "power", "name": "available", "value": 1.0, "unit": "bool"},
                        {"module": "power", "name": "watts", "value": power_w, "unit": "watt"},
                        {"module": "power", "name": "avg_watts", "value": power_w, "unit": "watt"},
                        {"module": "power", "name": "max_watts", "value": power_w, "unit": "watt"},
                        {"module": "power", "name": "sensor_count", "value": 1.0, "unit": "count"},
                        {"module": "fan", "name": "available", "value": 1.0, "unit": "bool"},
                        {"module": "fan", "name": "count", "value": fan_count, "unit": "count"},
                        {"module": "fan", "name": "ok_count", "value": fan_ok, "unit": "count"},
                        {"module": "fan", "name": "min_rpm", "value": fan_min, "unit": "rpm"},
                        {"module": "fan", "name": "max_rpm", "value": fan_max, "unit": "rpm"},
                        {"module": "fan", "name": "avg_rpm", "value": fan_avg, "unit": "rpm"},
                    ],
                }
                self._nodes[node_id] = {"latest": snapshot, "history": [snapshot]}
                self._fake_node_ids.add(node_id)

        return {"fake_nodes": count}


class UdpHandler(socketserver.BaseRequestHandler):
    state: StateStore = None

    def handle(self) -> None:
        payload = self.request[0]
        remote_ip = self.client_address[0]
        self.state.ingest_snapshot(payload, remote_ip)


class ApiHandler(SimpleHTTPRequestHandler):
    state: StateStore = None
    test_mode: bool = False

    def __init__(self, *args, **kwargs):
        web_dir = kwargs.pop("web_dir")
        super().__init__(*args, directory=web_dir, **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/config":
            self._json({"test_panel": self.test_mode})
            return

        if self.path == "/api/health":
            self._json(self.state.health())
            return

        if self.path == "/api/nodes":
            self._json({"nodes": self.state.node_summaries()})
            return

        if self.path == "/api/cluster":
            self._json(self.state.cluster_latest())
            return

        if self.path.startswith("/api/node/"):
            node_id = unquote(self.path[len("/api/node/") :])
            detail = self.state.node_detail(node_id)
            if not detail:
                self._json({"error": "not found"}, status=HTTPStatus.NOT_FOUND)
                return
            self._json(detail)
            return

        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/test/fake-nodes":
            if not self.test_mode:
                self._json({"error": "test mode disabled"}, status=HTTPStatus.FORBIDDEN)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                self._json({"error": "invalid json"}, status=HTTPStatus.BAD_REQUEST)
                return
            count = payload.get("count", 0)
            if not isinstance(count, int):
                self._json({"error": "count must be integer"}, status=HTTPStatus.BAD_REQUEST)
                return
            result = self.state.set_fake_nodes(count)
            self._json(result)
            return

        self._json({"error": "not found"}, status=HTTPStatus.NOT_FOUND)

    def _json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def start_udp_server(bind_host: str, bind_port: int, state: StateStore) -> socketserver.ThreadingUDPServer:
    UdpHandler.state = state
    udp_server = socketserver.ThreadingUDPServer((bind_host, bind_port), UdpHandler)
    udp_server.daemon_threads = True
    return udp_server


def start_http_server(bind_host: str, bind_port: int, state: StateStore, web_dir: str) -> ThreadingHTTPServer:
    ApiHandler.state = state

    def factory(*args, **kwargs):
        return ApiHandler(*args, web_dir=web_dir, **kwargs)

    return ThreadingHTTPServer((bind_host, bind_port), factory)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="HPC Cockpit UDP ingest server + Web UI")
    parser.add_argument("--udp-host", default="0.0.0.0", help="UDP bind host (default: 0.0.0.0)")
    parser.add_argument("--udp-port", type=int, default=9000, help="UDP bind port (default: 9000)")
    parser.add_argument("--http-host", default="0.0.0.0", help="HTTP bind host (default: 0.0.0.0)")
    parser.add_argument("--http-port", type=int, default=8080, help="HTTP bind port (default: 8080)")
    parser.add_argument("--history-size", type=int, default=120, help="Snapshots kept per node")
    parser.add_argument("--test-panel", action="store_true", help="Enable test side panel in UI")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.udp_port <= 0 or args.udp_port > 65535:
        print("error: udp-port must be between 1 and 65535")
        return 2
    if args.http_port <= 0 or args.http_port > 65535:
        print("error: http-port must be between 1 and 65535")
        return 2
    if args.history_size <= 0:
        print("error: history-size must be > 0")
        return 2

    base_dir = os.path.dirname(os.path.abspath(__file__))
    web_dir = os.path.join(base_dir, "web")
    state = StateStore(history_size=args.history_size)
    ApiHandler.test_mode = args.test_panel

    udp_server = start_udp_server(args.udp_host, args.udp_port, state)
    http_server = start_http_server(args.http_host, args.http_port, state, web_dir)

    udp_thread = threading.Thread(target=udp_server.serve_forever, daemon=True)
    udp_thread.start()

    print(
        f"udp_listen={args.udp_host}:{args.udp_port} "
        f"http_listen={args.http_host}:{args.http_port} web_dir={web_dir}"
    )

    try:
        http_server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        udp_server.shutdown()
        http_server.shutdown()
        udp_server.server_close()
        http_server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
