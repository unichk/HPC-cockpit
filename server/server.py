#!/usr/bin/env python3
import argparse
import json
import os
import socket
import socketserver
import tempfile
import threading
import time
import zlib
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote


def now_ms() -> int:
    return int(time.time() * 1000)


class ScheduleStore:
    """Persists schedule events to a JSON file with atomic replace."""

    def __init__(self, path: str) -> None:
        self._lock = threading.Lock()
        self._path = path
        self._events: list = []
        self._next_id: int = 1
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self._path):
            return
        try:
            with open(self._path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            return
        if not isinstance(data, dict):
            return
        events = data.get("events")
        if isinstance(events, list):
            cleaned: list = []
            for ev in events:
                if not isinstance(ev, dict):
                    continue
                cleaned.append(self._normalize(ev))
            self._events = [ev for ev in cleaned if ev is not None]
        next_id = data.get("next_id")
        if isinstance(next_id, int) and next_id > 0:
            self._next_id = next_id
        else:
            self._next_id = max((int(e["id"]) for e in self._events), default=0) + 1

    def _normalize(self, ev: dict):
        try:
            eid = int(ev["id"])
            start_ms = int(ev["startMs"])
            end_ms = int(ev["endMs"])
        except (KeyError, TypeError, ValueError):
            return None
        title = str(ev.get("title", ""))
        nodes = str(ev.get("nodes", ""))
        desc = str(ev.get("desc", ""))
        return {
            "id": eid,
            "title": title,
            "nodes": nodes,
            "startMs": start_ms,
            "endMs": end_ms,
            "desc": desc,
        }

    def _save_locked(self) -> None:
        payload = {"next_id": self._next_id, "events": self._events}
        directory = os.path.dirname(os.path.abspath(self._path)) or "."
        os.makedirs(directory, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix=".schedule-", suffix=".json.tmp", dir=directory
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
                handle.write("\n")
            os.replace(tmp_path, self._path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    @staticmethod
    def _validate_body(body: dict):
        if not isinstance(body, dict):
            return None, "body must be an object"
        title = body.get("title", "")
        nodes = body.get("nodes", "")
        desc = body.get("desc", "")
        start_ms = body.get("startMs")
        end_ms = body.get("endMs")
        if not isinstance(title, str) or not title.strip():
            return None, "title required"
        if not isinstance(nodes, str):
            return None, "nodes must be a string"
        if not isinstance(desc, str):
            return None, "desc must be a string"
        if not isinstance(start_ms, int) or not isinstance(end_ms, int):
            return None, "startMs and endMs must be integers (ms since epoch)"
        if end_ms <= start_ms:
            return None, "endMs must be greater than startMs"
        return {
            "title": title.strip(),
            "nodes": nodes,
            "desc": desc,
            "startMs": start_ms,
            "endMs": end_ms,
        }, None

    def list_events(self) -> list:
        with self._lock:
            return [dict(ev) for ev in self._events]

    def create(self, body: dict):
        fields, err = self._validate_body(body)
        if err:
            return None, err
        with self._lock:
            event = {"id": self._next_id, **fields}
            self._next_id += 1
            self._events.append(event)
            self._save_locked()
            return dict(event), None

    def update(self, event_id: int, body: dict):
        fields, err = self._validate_body(body)
        if err:
            return None, err
        with self._lock:
            for idx, ev in enumerate(self._events):
                if ev["id"] == event_id:
                    updated = {"id": event_id, **fields}
                    self._events[idx] = updated
                    self._save_locked()
                    return dict(updated), None
        return None, "not found"

    def delete(self, event_id: int) -> bool:
        with self._lock:
            for idx, ev in enumerate(self._events):
                if ev["id"] == event_id:
                    del self._events[idx]
                    self._save_locked()
                    return True
        return False


DEFAULT_SETTINGS = {
    "theme": "light",
    "ganttStartH": 0,
    "ganttEndH": 24,
    "visibleMetrics": {
        "cpu": True, "mem": True, "swap": True,
        "load": True, "temp": True, "fan": True,
    },
    "alerts": {
        "ageWarn": 15, "ageStale": 60,
        "cpuWarn": 80, "cpuHot": 95,
        "tempWarn": 80, "tempCrit": 90,
        "fanOkRatio": 1.0,
        "nodePowerWarn": 1700, "nodePowerHot": 1900,
        "totalPowerWarn": 4500, "totalPowerHot": 4800,
    },
    # Per-group power-draw bands. Used when a node is assigned to a group
    # via `nodeGroups`; otherwise the node falls back to alerts.nodePowerWarn/Hot.
    "groupAlerts": {
        "idle":  {"nodePowerWarn":  300, "nodePowerHot":  500},
        "login": {"nodePowerWarn":  500, "nodePowerHot":  800},
        "cpu":   {"nodePowerWarn": 1700, "nodePowerHot": 1900},
        "gpu":   {"nodePowerWarn": 2200, "nodePowerHot": 2500},
    },
    # nodeId → group name. Set from the per-node detail page.
    "nodeGroups": {},
    # Saved per-node group presets ("modes"). The dashboard's mode picker
    # applies one of these by overwriting nodeGroups. Each entry:
    #   {"id": "<slug>", "name": "<display>", "groups": {nodeId: groupName}}
    "modes": [],
    # Audio cues fired when a node escalates to warn/crit on the dashboard.
    "alarms": {
        "enabled": True,
        "volume": 0.7,
        # Paths under server/web/. Empty string silences that level.
        "warnSound": "sounds/warn.mp3",
        "critSound": "sounds/crit.mp3",
    },
}


class SettingsStore:
    """Persists UI settings to a JSON file with atomic replace."""

    def __init__(self, path: str) -> None:
        self._lock = threading.Lock()
        self._path = path
        self._settings = json.loads(json.dumps(DEFAULT_SETTINGS))
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self._path):
            return
        try:
            with open(self._path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            return
        if isinstance(data, dict):
            self._settings = self._merge(DEFAULT_SETTINGS, data)

    @staticmethod
    def _merge(base: dict, override: dict) -> dict:
        # Shallow-merge top level; deep-merge for known dict children
        # (visibleMetrics, alerts, groupAlerts, nodeGroups) so a partial
        # save doesn't drop unrelated keys.
        out = json.loads(json.dumps(base))
        for k, v in override.items():
            if k in ("visibleMetrics", "alerts", "nodeGroups", "alarms") and isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k].update({sk: sv for sk, sv in v.items() if isinstance(sv, (int, float, bool, str))})
            elif k == "groupAlerts" and isinstance(v, dict) and isinstance(out.get(k), dict):
                # Two levels deep: groupAlerts -> {idle, login, ...} -> {nodePowerWarn, nodePowerHot}
                for gname, gvals in v.items():
                    if not isinstance(gvals, dict):
                        continue
                    if gname not in out[k] or not isinstance(out[k][gname], dict):
                        out[k][gname] = {}
                    out[k][gname].update({sk: sv for sk, sv in gvals.items() if isinstance(sv, (int, float))})
            elif isinstance(v, (int, float, bool, str, list)):
                out[k] = v
        return out

    def _save_locked(self) -> None:
        directory = os.path.dirname(os.path.abspath(self._path)) or "."
        os.makedirs(directory, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix=".settings-", suffix=".json.tmp", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(self._settings, handle, indent=2)
                handle.write("\n")
            os.replace(tmp_path, self._path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    def get(self) -> dict:
        with self._lock:
            return json.loads(json.dumps(self._settings))

    def replace(self, payload: dict):
        if not isinstance(payload, dict):
            return None, "body must be an object"
        with self._lock:
            self._settings = self._merge(DEFAULT_SETTINGS, payload)
            self._save_locked()
            return json.loads(json.dumps(self._settings)), None


class StateStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._nodes = {}
        self._ingest_count = 0
        self._ingest_errors = 0
        self._fake_node_ids = set()

    def ingest_snapshot(self, payload: bytes, remote_ip: str) -> None:
        # Workers deflate the snapshot so it fits in one unfragmented datagram.
        # Raw JSON starts with '{'; a zlib stream starts with a CMF byte, so
        # the two are unambiguous and a worker and server can be upgraded in
        # either order. A stream that claims to be zlib but will not inflate
        # falls through to the JSON parse below and is reported there.
        if payload[:1] != b"{":
            try:
                payload = zlib.decompress(payload)
            except zlib.error:
                pass

        try:
            parsed = json.loads(payload.decode("utf-8"))
        except Exception as exc:
            with self._lock:
                self._ingest_errors += 1
                count = self._ingest_errors
            # Log the first few and then every 100th, so a node emitting bad
            # packets is obvious without flooding the console. Size is the
            # useful clue: a payload at exactly the read limit was truncated.
            if count <= 5 or count % 100 == 0:
                print(
                    f"ingest_error from={remote_ip} bytes={len(payload)} "
                    f"errors={count} msg={exc}"
                )
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

        received_at_ms = now_ms()

        # Workers send one datagram per module, naming it in `module`, so a lost
        # packet costs one module's freshness instead of the whole snapshot.
        # Each module therefore replaces only its own slot. A datagram with no
        # `module` field is a whole-snapshot send from an older worker: group
        # its metrics by their own module field and replace every slot they
        # cover, which keeps an un-upgraded worker working against this server.
        module = parsed.get("module")
        incoming: dict = {}
        if isinstance(module, str) and module:
            incoming[module] = metrics
        else:
            for metric in metrics:
                if not isinstance(metric, dict):
                    continue
                name = metric.get("module")
                if isinstance(name, str) and name:
                    incoming.setdefault(name, []).append(metric)

        with self._lock:
            self._ingest_count += 1
            node_entry = self._nodes.get(node_id)
            if node_entry is None:
                node_entry = {"modules": {}}
                self._nodes[node_id] = node_entry
            modules = node_entry.setdefault("modules", {})
            for name, module_metrics in incoming.items():
                modules[name] = {
                    "metrics": module_metrics,
                    "timestamp_ms": timestamp_ms,
                    "received_at_ms": received_at_ms,
                }
            self._rebuild_latest_locked(node_id, node_entry, remote_ip, received_at_ms)

    # Longest a module's last packet may sit before it is treated as gone
    # rather than merely stale. Well beyond any plausible loss burst, so this
    # only fires when a collector is actually removed or permanently failing --
    # otherwise stale metrics for absent hardware would linger forever.
    MODULE_TTL_MS = 300_000

    def _rebuild_latest_locked(self, node_id: str, node_entry: dict, remote_ip: str,
                               seen_ms: int) -> None:
        """Flatten the per-module slots into the single combined snapshot the
        rest of the server reads. Called with the lock held."""
        modules = node_entry.get("modules", {})
        # Fall back to this packet's arrival time so a worker reporting no
        # metrics at all still counts as alive rather than instantly stale.
        newest = max((m["received_at_ms"] for m in modules.values()), default=seen_ms)

        for name in [n for n, m in modules.items()
                     if newest - m["received_at_ms"] > self.MODULE_TTL_MS]:
            del modules[name]

        metrics: list = []
        for name in sorted(modules):
            metrics.extend(modules[name]["metrics"])

        node_entry["latest"] = {
            "node_id": node_id,
            # The node is live if *any* module arrived recently -- a single
            # lossy module must not make the whole node look offline.
            "timestamp_ms": max((m["timestamp_ms"] for m in modules.values()), default=seen_ms),
            "received_at_ms": newest,
            "metrics": metrics,
            "remote_ip": remote_ip,
            # Per-module receipt ages, so a consumer can tell which module is
            # behind rather than seeing one blended freshness number.
            "module_received_at_ms": {n: m["received_at_ms"] for n, m in modules.items()},
        }

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
                        "metrics": latest["metrics"],
                        # Age of each module's own last packet. Modules arrive
                        # in separate datagrams, so one can lag behind the rest.
                        "module_ages_ms": {
                            name: max(0, current - seen)
                            for name, seen in latest.get("module_received_at_ms", {}).items()
                        },
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
                fan_step = (fan_max - fan_min) / max(1.0, fan_count - 1.0)
                fan_sensor_values = {
                    "psu0_fan_rpm": fan_max,
                    "psu1_fan_rpm": fan_max - fan_step,
                    "sys_fan1_f_rpm": fan_min + fan_step * 2.0,
                    "sys_fan1_r_rpm": fan_min + fan_step * 1.0,
                    "sys_fan2_f_rpm": fan_min + fan_step * 9.0,
                    "sys_fan2_r_rpm": fan_min + fan_step * 8.0,
                    "sys_fan3_f_rpm": fan_min + fan_step * 8.5,
                    "sys_fan3_r_rpm": fan_min + fan_step * 7.2,
                    "sys_fan4_f_rpm": fan_min + fan_step * 3.0,
                    "sys_fan4_r_rpm": fan_min + fan_step * 2.0,
                    "sys_fan5_f_rpm": fan_min + fan_step * 3.2,
                    "sys_fan5_r_rpm": fan_min + fan_step * 1.8,
                    "sys_fan6_f_rpm": fan_min + fan_step * 2.4,
                    "sys_fan6_r_rpm": fan_min + fan_step * 2.0,
                }
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
                        *[
                            {"module": "fan", "name": name, "value": value, "unit": "rpm"}
                            for name, value in fan_sensor_values.items()
                        ],
                    ],
                }
                self._nodes[node_id] = {"latest": snapshot}
                self._fake_node_ids.add(node_id)

        return {"fake_nodes": count}

    def apply_warning_case(self, case_name: str) -> dict:
        case = (case_name or "").strip().lower()
        valid_cases = {
            "reset",
            "no_response_warn",
            "no_response_stale",
            "cpu_warn",
            "cpu_hot",
            "cpu_temp_warn",
            "cpu_temp_crit",
            "fan_ok_ratio_warn",
            "node_power_warn",
            "node_power_hot",
            "total_power_warn",
            "total_power_hot",
        }
        if case not in valid_cases:
            return {"error": "unknown case"}

        with self._lock:
            fake_count = len(self._fake_node_ids)
        if fake_count == 0:
            self.set_fake_nodes(1)
            fake_count = 1
        if case in {"total_power_warn", "total_power_hot"} and fake_count < 4:
            self.set_fake_nodes(4)
            fake_count = 4
        if case == "reset":
            self.set_fake_nodes(fake_count)
            return {"warning_case": case, "target_node": "all"}

        with self._lock:
            target_id = sorted(self._fake_node_ids)[0] if self._fake_node_ids else None
            if not target_id:
                return {"error": "no target node"}

            now = now_ms()
            for node_id in self._fake_node_ids:
                entry = self._nodes.get(node_id)
                if not entry:
                    continue
                latest = dict(entry["latest"])
                latest["received_at_ms"] = now
                latest["timestamp_ms"] = now
                metrics = []
                for item in latest.get("metrics", []):
                    metric = dict(item)
                    if metric.get("module") == "cpu" and metric.get("name") == "usage":
                        metric["value"] = 25.0
                    if metric.get("module") == "thermal":
                        if metric.get("name") in {"cpu_alert_level", "nvme_alert_level", "nic_alert_level", "chipset_alert_level"}:
                            metric["value"] = 0.0
                        if metric.get("name") == "cpu_package0_c":
                            metric["value"] = 54.0
                        if metric.get("name") == "cpu_package_max_c":
                            metric["value"] = 54.0
                        if metric.get("name") == "nvme_max_c":
                            metric["value"] = 39.0
                        if metric.get("name") == "nic_max_c":
                            metric["value"] = 53.0
                        if metric.get("name") == "chipset_c":
                            metric["value"] = 36.0
                    if metric.get("module") == "fan":
                        if metric.get("name") == "count":
                            metric["value"] = 12.0
                        if metric.get("name") == "ok_count":
                            metric["value"] = 12.0
                    metrics.append(metric)
                latest["metrics"] = metrics
                entry["latest"] = latest

            target = self._nodes[target_id]["latest"]
            metrics_by_key = {(m.get("module"), m.get("name")): m for m in target.get("metrics", [])}

            def set_metric(module: str, name: str, value: float) -> None:
                item = metrics_by_key.get((module, name))
                if item is not None:
                    item["value"] = value

            if case == "cpu_warn":
                set_metric("cpu", "usage", 85.0)
            elif case == "cpu_hot":
                set_metric("cpu", "usage", 97.0)
            elif case == "no_response_warn":
                target["received_at_ms"] = now - 20000
                target["timestamp_ms"] = now - 20000
            elif case == "no_response_stale":
                target["received_at_ms"] = now - 70000
                target["timestamp_ms"] = now - 70000
            elif case == "cpu_temp_warn":
                set_metric("thermal", "cpu_alert_level", 1.0)
                set_metric("thermal", "cpu_package0_c", 82.0)
                set_metric("thermal", "cpu_package_max_c", 82.0)
            elif case == "cpu_temp_crit":
                set_metric("thermal", "cpu_alert_level", 2.0)
                set_metric("thermal", "cpu_package0_c", 92.0)
                set_metric("thermal", "cpu_package_max_c", 92.0)
            elif case == "fan_ok_ratio_warn":
                expected_count = 14.0
                missing = {"sys_fan6_r_rpm", "sys_fan6_f_rpm", "psu1_fan_rpm"}
                kept_rpms = []
                filtered_metrics = []
                for metric in target.get("metrics", []):
                    if metric.get("module") == "fan" and metric.get("name") in missing:
                        continue
                    if (
                        metric.get("module") == "fan"
                        and isinstance(metric.get("value"), (int, float))
                        and str(metric.get("name", "")).endswith("_rpm")
                        and metric.get("name") not in {"min_rpm", "max_rpm", "avg_rpm"}
                    ):
                        kept_rpms.append(float(metric["value"]))
                    filtered_metrics.append(metric)
                for missing_name in sorted(missing):
                    filtered_metrics.append(
                        {"module": "fan", "name": f"missing_{missing_name.replace('_rpm', '')}", "value": 1.0, "unit": "bool"}
                    )
                target["metrics"] = filtered_metrics
                if kept_rpms:
                    set_metric("fan", "min_rpm", min(kept_rpms))
                    set_metric("fan", "max_rpm", max(kept_rpms))
                    set_metric("fan", "avg_rpm", sum(kept_rpms) / len(kept_rpms))
                set_metric("fan", "count", expected_count)
                set_metric("fan", "ok_count", float(len(kept_rpms)))
            elif case == "node_power_warn":
                set_metric("power", "watts", 1800.0)
                set_metric("power", "avg_watts", 1800.0)
                set_metric("power", "max_watts", 1800.0)
            elif case == "node_power_hot":
                set_metric("power", "watts", 2000.0)
                set_metric("power", "avg_watts", 2000.0)
                set_metric("power", "max_watts", 2000.0)
            elif case in {"total_power_warn", "total_power_hot"}:
                target_watts = 1150.0 if case == "total_power_warn" else 1250.0
                for node_id in list(self._fake_node_ids):
                    entry = self._nodes.get(node_id)
                    if not entry:
                        continue
                    latest_metrics = entry["latest"].get("metrics", [])
                    for metric in latest_metrics:
                        if metric.get("module") == "power" and metric.get("name") in {"watts", "avg_watts", "max_watts"}:
                            metric["value"] = target_watts

        return {"warning_case": case, "target_node": target_id}


class UdpHandler(socketserver.BaseRequestHandler):
    state: StateStore = None

    def handle(self) -> None:
        payload = self.request[0]
        remote_ip = self.client_address[0]
        self.state.ingest_snapshot(payload, remote_ip)


def proxy_exec_to_worker(
    remote_ip: str, port: int, token: str, cmd: str, timeout_s: int
) -> tuple:
    """Open a TCP connection to the worker's command_server, send one JSON
    request line, read one JSON response line. Returns (payload_dict, None) on
    success or (None, error_tag)."""
    request = json.dumps(
        {"token": token, "cmd": cmd, "timeout_s": timeout_s}, ensure_ascii=False
    ) + "\n"
    # Worker has its own per-command timeout; give the network hop + server-side
    # wait a generous buffer so we don't cut off slow commands.
    network_timeout = max(10, timeout_s + 10)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5)
    try:
        try:
            sock.connect((remote_ip, port))
        except (ConnectionRefusedError, OSError):
            return None, "unreachable"
        sock.settimeout(network_timeout)
        try:
            sock.sendall(request.encode("utf-8"))
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            return None, "send_failed"
        chunks = []
        total = 0
        while True:
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                return None, "read_timeout"
            except OSError:
                return None, "read_failed"
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            # hard cap to match worker's per-response ceiling + envelope
            if total > 8 * 1024 * 1024:
                return None, "response_too_large"
        raw = b"".join(chunks).decode("utf-8", errors="replace").strip()
        if not raw:
            return None, "empty_response"
        try:
            return json.loads(raw), None
        except json.JSONDecodeError:
            return None, "bad_response"
    finally:
        try:
            sock.close()
        except OSError:
            pass


class ApiHandler(SimpleHTTPRequestHandler):
    state: StateStore = None
    schedule: ScheduleStore = None
    settings: SettingsStore = None
    test_mode: bool = False
    worker_exec_port: int = 9100

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

        if self.path == "/api/schedule":
            self._json({"events": self.schedule.list_events()})
            return

        if self.path == "/api/settings":
            self._json(self.settings.get())
            return

        if self.path == "/api/sounds":
            sounds_dir = os.path.join(self.directory, "sounds")
            files = []
            try:
                for entry in sorted(os.listdir(sounds_dir)):
                    if entry.lower().endswith((".mp3", ".ogg", ".wav")):
                        files.append(entry)
            except FileNotFoundError:
                pass
            self._json({"sounds": files})
            return

        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_PUT(self) -> None:
        event_id = self._match_schedule_id()
        if event_id is None:
            self._json({"error": "not found"}, status=HTTPStatus.NOT_FOUND)
            return
        body = self._read_json_body()
        if body is None:
            return
        event, err = self.schedule.update(event_id, body)
        if err == "not found":
            self._json({"error": err}, status=HTTPStatus.NOT_FOUND)
            return
        if err:
            self._json({"error": err}, status=HTTPStatus.BAD_REQUEST)
            return
        self._json(event)

    def do_DELETE(self) -> None:
        event_id = self._match_schedule_id()
        if event_id is None:
            self._json({"error": "not found"}, status=HTTPStatus.NOT_FOUND)
            return
        if not self.schedule.delete(event_id):
            self._json({"error": "not found"}, status=HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.NO_CONTENT.value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _match_schedule_id(self):
        prefix = "/api/schedule/"
        if not self.path.startswith(prefix):
            return None
        try:
            return int(self.path[len(prefix):])
        except ValueError:
            return None

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            self._json({"error": "invalid json"}, status=HTTPStatus.BAD_REQUEST)
            return None

    def do_POST(self) -> None:
        if self.path == "/api/schedule":
            body = self._read_json_body()
            if body is None:
                return
            event, err = self.schedule.create(body)
            if err:
                self._json({"error": err}, status=HTTPStatus.BAD_REQUEST)
                return
            self._json(event, status=HTTPStatus.CREATED)
            return

        if self.path == "/api/settings":
            body = self._read_json_body()
            if body is None:
                return
            saved, err = self.settings.replace(body)
            if err:
                self._json({"error": err}, status=HTTPStatus.BAD_REQUEST)
                return
            self._json(saved)
            return

        exec_suffix = "/exec"
        if self.path.startswith("/api/node/") and self.path.endswith(exec_suffix):
            node_id = unquote(self.path[len("/api/node/") : -len(exec_suffix)])
            if not node_id:
                self._json({"error": "node id required"}, status=HTTPStatus.BAD_REQUEST)
                return
            token = self.headers.get("X-Exec-Token", "")
            if not token:
                self._json({"error": "X-Exec-Token header required"}, status=HTTPStatus.UNAUTHORIZED)
                return
            body = self._read_json_body()
            if body is None:
                return
            if not isinstance(body, dict):
                self._json({"error": "body must be an object"}, status=HTTPStatus.BAD_REQUEST)
                return
            cmd = body.get("cmd", "")
            timeout_s = body.get("timeout_s", 0)
            if not isinstance(cmd, str) or not cmd.strip():
                self._json({"error": "cmd required"}, status=HTTPStatus.BAD_REQUEST)
                return
            if len(cmd) > 32 * 1024:
                self._json({"error": "cmd too long"}, status=HTTPStatus.BAD_REQUEST)
                return
            if not isinstance(timeout_s, int) or timeout_s < 0 or timeout_s > 300:
                self._json(
                    {"error": "timeout_s must be integer in [0, 300]"},
                    status=HTTPStatus.BAD_REQUEST,
                )
                return
            detail = self.state.node_detail(node_id)
            latest = detail.get("latest") if detail else None
            remote_ip = latest.get("remote_ip") if isinstance(latest, dict) else None
            if not remote_ip:
                self._json({"error": "node not found"}, status=HTTPStatus.NOT_FOUND)
                return
            resp, err = proxy_exec_to_worker(
                remote_ip, self.worker_exec_port, token, cmd, timeout_s or 30
            )
            if err is not None:
                status_map = {
                    "unreachable": HTTPStatus.SERVICE_UNAVAILABLE,
                    "send_failed": HTTPStatus.BAD_GATEWAY,
                    "read_failed": HTTPStatus.BAD_GATEWAY,
                    "read_timeout": HTTPStatus.GATEWAY_TIMEOUT,
                    "empty_response": HTTPStatus.BAD_GATEWAY,
                    "bad_response": HTTPStatus.BAD_GATEWAY,
                    "response_too_large": HTTPStatus.BAD_GATEWAY,
                }
                self._json(
                    {"error": err, "node_id": node_id},
                    status=status_map.get(err, HTTPStatus.BAD_GATEWAY),
                )
                return
            if not isinstance(resp, dict):
                self._json({"error": "bad_response"}, status=HTTPStatus.BAD_GATEWAY)
                return
            stdout_len = len(resp.get("stdout", "")) if isinstance(resp.get("stdout"), str) else 0
            stderr_len = len(resp.get("stderr", "")) if isinstance(resp.get("stderr"), str) else 0
            print(
                f"exec node={node_id} exit={resp.get('exit')} "
                f"signal={resp.get('signal')} out={stdout_len}b err={stderr_len}b "
                f"trunc={resp.get('truncated')} tag={resp.get('error')}"
            )
            self._json(resp)
            return

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

        if self.path == "/api/test/warning-case":
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
            case = payload.get("case", "")
            if not isinstance(case, str):
                self._json({"error": "case must be string"}, status=HTTPStatus.BAD_REQUEST)
                return
            result = self.state.apply_warning_case(case)
            if "error" in result:
                self._json(result, status=HTTPStatus.BAD_REQUEST)
                return
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


class SnapshotUDPServer(socketserver.ThreadingUDPServer):
    # socketserver defaults max_packet_size to 8192 and silently truncates
    # anything larger, which then fails to parse and is counted as an ingest
    # error rather than surfacing as "your packet is too big".
    #
    # A fully-populated node overruns that easily: IPMI thermal (~41 metrics),
    # one row per chassis fan (~43) and per-GPU rows on an 8-GPU box (~69) add
    # up to ~12 KB. Read up to the largest payload a single UDP datagram can
    # carry (65507 bytes + slack) so snapshots arrive whole.
    max_packet_size = 65535


def start_udp_server(bind_host: str, bind_port: int, state: StateStore) -> socketserver.ThreadingUDPServer:
    UdpHandler.state = state
    udp_server = SnapshotUDPServer((bind_host, bind_port), UdpHandler)
    udp_server.daemon_threads = True
    return udp_server


def start_http_server(
    bind_host: str,
    bind_port: int,
    state: StateStore,
    schedule: ScheduleStore,
    settings: SettingsStore,
    web_dir: str,
    worker_exec_port: int,
) -> ThreadingHTTPServer:
    ApiHandler.state = state
    ApiHandler.schedule = schedule
    ApiHandler.settings = settings
    ApiHandler.worker_exec_port = worker_exec_port

    def factory(*args, **kwargs):
        return ApiHandler(*args, web_dir=web_dir, **kwargs)

    return ThreadingHTTPServer((bind_host, bind_port), factory)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="HPC Cockpit UDP ingest server + Web UI")
    parser.add_argument("--udp-host", default="0.0.0.0", help="UDP bind host (default: 0.0.0.0)")
    parser.add_argument("--udp-port", type=int, default=9000, help="UDP bind port (default: 9000)")
    parser.add_argument("--http-host", default="0.0.0.0", help="HTTP bind host (default: 0.0.0.0)")
    parser.add_argument("--http-port", type=int, default=8080, help="HTTP bind port (default: 8080)")
    parser.add_argument("--test-panel", action="store_true", help="Enable test side panel in UI")
    parser.add_argument(
        "--schedule-file",
        default=None,
        help="Path to schedule JSON file (default: <server_dir>/schedule.json)",
    )
    parser.add_argument(
        "--settings-file",
        default=None,
        help="Path to settings JSON file (default: <server_dir>/settings.json)",
    )
    parser.add_argument(
        "--worker-exec-port",
        type=int,
        default=9100,
        help="TCP port where the hpc_worker command channel listens (default: 9100)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.udp_port <= 0 or args.udp_port > 65535:
        print("error: udp-port must be between 1 and 65535")
        return 2
    if args.http_port <= 0 or args.http_port > 65535:
        print("error: http-port must be between 1 and 65535")
        return 2
    base_dir = os.path.dirname(os.path.abspath(__file__))
    web_dir = os.path.join(base_dir, "web")
    schedule_path = args.schedule_file or os.path.join(base_dir, "schedule.json")
    settings_path = args.settings_file or os.path.join(base_dir, "settings.json")
    state = StateStore()
    schedule = ScheduleStore(schedule_path)
    settings = SettingsStore(settings_path)
    ApiHandler.test_mode = args.test_panel

    if args.worker_exec_port <= 0 or args.worker_exec_port > 65535:
        print("error: worker-exec-port must be between 1 and 65535")
        return 2

    udp_server = start_udp_server(args.udp_host, args.udp_port, state)
    http_server = start_http_server(
        args.http_host,
        args.http_port,
        state,
        schedule,
        settings,
        web_dir,
        args.worker_exec_port,
    )

    udp_thread = threading.Thread(target=udp_server.serve_forever, daemon=True)
    udp_thread.start()

    print(
        f"udp_listen={args.udp_host}:{args.udp_port} "
        f"http_listen={args.http_host}:{args.http_port} "
        f"web_dir={web_dir} schedule_file={schedule_path} settings_file={settings_path}"
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
