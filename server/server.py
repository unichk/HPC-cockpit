#!/usr/bin/env python3
import argparse
import ipaddress
import json
import os
import posixpath
import re
import secrets
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading
import time
import zlib
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request
from urllib.parse import quote, unquote, urlsplit


def now_ms() -> int:
    return int(time.time() * 1000)


def _prom_name(name: str) -> str:
    """Prometheus metric names allow [a-zA-Z_:][a-zA-Z0-9_:]*."""
    name = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    name = re.sub(r"_+", "_", name).strip("_")
    return name if re.match(r"^[a-zA-Z_]", name) else "_" + name


def _prom_escape(value) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


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
        # Power drawn by equipment that is not a node (e.g. the IB switch),
        # keyed by source name: {"watts", "received_at_ms", "remote_ip"}.
        self._aux_power = {}

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

        if parsed.get("kind") == "aux_power":
            self._ingest_aux_power(parsed, remote_ip)
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

    def _ingest_aux_power(self, parsed: dict, remote_ip: str) -> None:
        """{"kind": "aux_power", "source": "ib-qm8700", "watts": 231.0}.
        Counted in total power but never shown as a node."""
        source, watts = parsed.get("source"), parsed.get("watts")
        if (not isinstance(source, str) or not source.strip()
                or not isinstance(watts, (int, float)) or isinstance(watts, bool)
                or not 0 <= watts < 100_000):
            with self._lock:
                self._ingest_errors += 1
            return
        with self._lock:
            self._ingest_count += 1
            self._aux_power[source.strip()] = {
                "watts": float(watts), "received_at_ms": now_ms(), "remote_ip": remote_ip}

    def aux_power(self) -> list:
        """Fresh auxiliary power sources; stale ones are left out so a dead
        poller cannot keep adding a frozen value to the total."""
        current = now_ms()
        with self._lock:
            return sorted(
                ({"source": k, "watts": v["watts"], "age_ms": current - v["received_at_ms"]}
                 for k, v in self._aux_power.items()
                 if current - v["received_at_ms"] <= self.METRICS_STALE_MS),
                key=lambda r: r["source"])

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

    # A module whose last packet is older than this is left OUT of /metrics
    # rather than repeated. Prometheus would otherwise record a frozen value
    # as real history (the BMC that sat at exactly 1425 W for hours is why).
    # 6x the default 5 s worker interval tolerates a few lost datagrams.
    METRICS_STALE_MS = 30_000

    def prometheus_text(self) -> str:
        """Prometheus text exposition (format 0.0.4) of every node's latest,
        still-fresh metrics. Series are gauges named cockpit_<module>_<name>
        with a node label; GPU metrics ("<index>.<field>") become
        cockpit_gpu_<field> with a gpu label. Module freshness is always
        exported, so a gap in a series can be told apart from a dead node."""
        current = now_ms()
        families: dict = {}   # metric name -> {label tuple: value}

        def put(name: str, labels: tuple, value: float) -> None:
            families.setdefault(name, {})[labels] = value

        with self._lock:
            for node_id, entry in self._nodes.items():
                latest = entry.get("latest", {})
                put("cockpit_node_last_seen_seconds", (("node", node_id),),
                    latest.get("received_at_ms", 0) / 1000.0)
                modules = entry.get("modules")
                if modules is None:
                    # test-panel fake nodes carry a flat snapshot, no modules
                    modules = {"": {"metrics": latest.get("metrics", []),
                                    "received_at_ms": latest.get("received_at_ms", 0)}}
                for mod_name, mod in modules.items():
                    age_ms = max(0, current - mod.get("received_at_ms", 0))
                    fresh = age_ms <= self.METRICS_STALE_MS
                    if mod_name:
                        lbl = (("node", node_id), ("module", mod_name))
                        put("cockpit_module_age_seconds", lbl, age_ms / 1000.0)
                        put("cockpit_module_fresh", lbl, 1.0 if fresh else 0.0)
                    if not fresh:
                        continue
                    for m in mod.get("metrics", []):
                        value = m.get("value")
                        if not isinstance(value, (int, float)) or isinstance(value, bool):
                            continue          # string_value metrics are not numeric
                        value = float(value)
                        if value != value or value in (float("inf"), float("-inf")):
                            continue
                        module = m.get("module") or mod_name or "misc"
                        raw = str(m.get("name", ""))
                        labels = [("node", node_id)]
                        gpu = re.match(r"^(\d+)\.(.+)$", raw)
                        if gpu:
                            labels.append(("gpu", gpu.group(1)))
                            raw = gpu.group(2)
                        put(_prom_name(f"cockpit_{module}_{raw}"), tuple(labels), value)

        for aux in self.aux_power():
            put("cockpit_aux_power_watts", (("source", aux["source"]),), aux["watts"])

        lines = []
        for name in sorted(families):
            lines.append(f"# TYPE {name} gauge")
            for labels, value in sorted(families[name].items()):
                body = ",".join(f'{k}="{_prom_escape(v)}"' for k, v in labels)
                lines.append(f"{name}{{{body}}} {repr(value)}")
        return "\n".join(lines) + "\n"

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


# Discord webhook that warn/crit escalations are posted to. Anyone holding this
# URL can post to that channel, so it is deliberately NOT exposed through
# /api/settings (readable by every logged-in user) and is never logged.
# --discord-webhook / HPC_COCKPIT_DISCORD_WEBHOOK override it; "" disables.
DISCORD_WEBHOOK_URL = (
    "https://discord.com/api/webhooks/1547626216046071899/"
    "zSX2myyqelAFgm9eZNhBln-_ZvAC5algUm_xaLa4fDnVwZVVXp1K82SD-nRJSHcEvF-x"
)

STATUS_RANK = {"ok": 0, "warn": 1, "crit": 2}
STATUS_COLOR = {"ok": 0x3BA55D, "warn": 0xE8A33D, "crit": 0xE0524A}
STATUS_EMOJI = {"ok": "\U0001F7E2", "warn": "\U0001F7E1", "crit": "\U0001F534"}
STATUS_WORD = {"ok": "recovered", "warn": "warning", "crit": "critical"}

# Discord MessageFlags.SUPPRESS_NOTIFICATIONS. The message still posts and is
# still highlighted in the channel, it just does not push or ping. Only "crit"
# is worth waking someone for; warnings and recoveries post silently.
DISCORD_SILENT = 1 << 12
# Leading emoji per reason, matched on the text the evaluator produces, so a
# glance at the message says which subsystem moved without reading the words.
REASON_EMOJI = (
    ("no data", "\U0001F4E1"),      # satellite
    ("CPU temp", "\U0001F321\uFE0F"),  # thermometer
    ("GPU temp", "\U0001F321\uFE0F"),
    ("CPU ", "\U0001F9E0"),         # brain
    ("power", "\u26A1"),            # high voltage
    ("fans", "\U0001F300"),         # cyclone
    ("memory", "\U0001F4BE"),       # floppy
    ("swap", "\U0001F4BE"),
)


def reason_emoji(text: str) -> str:
    for prefix, emoji in REASON_EMOJI:
        if text.startswith(prefix):
            return emoji
    return "\u2022"


class AlertNotifier:
    """Watches StateStore and posts node warn/crit escalations to Discord.

    The dashboard already colours and sounds alarms, but only while a browser
    has it open. This runs in the server so alerts fire unattended.

    Classification mirrors classifyNode() in web/live-data.js so the message
    always agrees with what the UI shows; if you change the rules there, change
    them here too.
    """

    INTERVAL_S = 10
    # Per node+level, the minimum gap between messages. Escalation-only already
    # suppresses repeats, but a node flapping ok->warn->ok would otherwise send
    # on every bounce.
    COOLDOWN_S = 300

    def __init__(self, webhook_url: str, state: "StateStore", settings: "SettingsStore") -> None:
        self._url = webhook_url
        self._state = state
        self._settings = settings
        self._prev: dict = {}
        self._last_sent: dict = {}
        self._primed = False
        self._stop = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self.INTERVAL_S):
            try:
                self._tick()
            except Exception as exc:
                # A notifier fault must never take the server down.
                print(f"alert_notifier_error msg={exc}")

    def _tick(self) -> None:
        settings = self._settings.get()
        rows = self._state.node_summaries()
        events = []
        seen = set()
        now = time.time()

        for row in rows:
            node_id = row["node_id"]
            seen.add(node_id)
            status, reasons = self._evaluate(row, settings)
            prev = self._prev.get(node_id)
            self._prev[node_id] = status
            if not self._primed or prev is None:
                continue
            escalated = STATUS_RANK.get(status, 0) > STATUS_RANK.get(prev, 0)
            recovered = status == "ok" and prev != "ok"
            if not (escalated or recovered):
                continue
            key = (node_id, status)
            if now - self._last_sent.get(key, 0) < self.COOLDOWN_S:
                continue
            self._last_sent[key] = now
            events.append((node_id, prev, status, reasons))

        for node_id in [n for n in self._prev if n not in seen]:
            del self._prev[node_id]

        # First pass only records the baseline, so a restart does not fire an
        # alert for every node that is already warm.
        if not self._primed:
            self._primed = True
            return
        if events:
            self._post(events)

    def _power_bands(self, node_id: str, settings: dict) -> tuple:
        alerts = settings.get("alerts", {})
        warn = alerts.get("nodePowerWarn")
        hot = alerts.get("nodePowerHot")
        group = (settings.get("nodeGroups") or {}).get(node_id)
        if group:
            band = (settings.get("groupAlerts") or {}).get(group) or {}
            warn = band.get("nodePowerWarn", warn)
            hot = band.get("nodePowerHot", hot)
        return warn, hot

    @staticmethod
    def _index(row: dict) -> dict:
        out = {}
        for metric in row.get("metrics", []):
            if not isinstance(metric, dict):
                continue
            module, name, value = metric.get("module"), metric.get("name"), metric.get("value")
            if isinstance(module, str) and isinstance(name, str) and isinstance(value, (int, float)):
                out[f"{module}.{name}"] = float(value)
        return out

    @staticmethod
    def _pick(idx: dict, *keys: str) -> float:
        for key in keys:
            if key in idx:
                return idx[key]
        return 0.0

    def _power_breakdown(self, idx: dict) -> list:
        """Component power, one entry per line, appended to a power alert so
        the message says what is actually drawing the watts rather than just
        that the total crossed a line. Mirrors the detail page's breakdown:
        the measured parts, then the rest as "Others"."""
        total = self._pick(idx, "power.watts", "power.max_watts")
        if total <= 0:
            return []
        parts = []
        for index in range(int(self._pick(idx, "cpu.socket_count"))):
            watts = self._pick(idx, f"cpu.socket{index}_power_w")
            if watts > 0:
                parts.append((f"CPU {index}", watts))
        gpu_count = int(self._pick(idx, "gpu.count"))
        gpu_watts = self._pick(idx, "gpu.power_sum_w")
        if gpu_count > 0 and gpu_watts > 0:
            parts.append((f"GPUs ({gpu_count})", gpu_watts))
        dimm_watts = self._pick(idx, "memory.dimm_power_w")
        if dimm_watts > 0:
            parts.append((f"DIMMs ({int(self._pick(idx, 'memory.dimm_count'))})", dimm_watts))
        if not parts:
            return []
        others = total - sum(watts for _, watts in parts)
        if others > 0:
            parts.append(("Others", others))
        return [f"breakdown: {name} {watts:.0f}W ({watts / total * 100:.0f}%)"
                for name, watts in parts]

    def _evaluate(self, row: dict, settings: dict) -> tuple:
        idx = self._index(row)
        alerts = settings.get("alerts", {})

        def band(key: str, default: float) -> float:
            value = alerts.get(key)
            return float(value) if isinstance(value, (int, float)) else default

        age_s = max(0.0, row.get("age_ms", 0) / 1000.0)
        age_warn, age_stale = band("ageWarn", 15), band("ageStale", 60)
        cpu_warn, cpu_hot = band("cpuWarn", 80), band("cpuHot", 95)
        # Hardware limits win over the settings, matching nodeTempBands() in
        # web/live-data.js: the BMC publishes the board vendor's own CPU
        # thresholds, and alerting on a generic default instead would disagree
        # with what the dashboard and detail page show.
        temp_warn = self._pick(idx, "thermal.cpu_warn_c") or band("tempWarn", 80)
        temp_crit = self._pick(idx, "thermal.cpu_crit_c") or band("tempCrit", 90)
        fan_ratio_min = band("fanOkRatio", 1.0)
        power_warn, power_hot = self._power_bands(row["node_id"], settings)
        power_warn = float(power_warn) if isinstance(power_warn, (int, float)) else 1700.0
        power_hot = float(power_hot) if isinstance(power_hot, (int, float)) else 1900.0

        # GPUs are scored against the BMC's GPU slot limits rather than the
        # CPU's, mirroring nodeTempBands(node, thresholds, "gpu") in the UI.
        gpu_temp = self._pick(idx, "gpu.temp_max_c")
        gpu_count = self._pick(idx, "gpu.count")
        gpu_warn = self._pick(idx, "thermal.gpu_warn_c") or band("tempWarn", 80)
        gpu_crit = self._pick(idx, "thermal.gpu_crit_c") or band("tempCrit", 90)

        cpu = self._pick(idx, "cpu.usage")
        temp = self._pick(idx, "thermal.cpu_package_max_c", "thermal.cpu_package0_c")
        # Instantaneous, matching live-data.js: alerting on the BMC's windowed
        # maximum would page on a single glitched statistics register.
        power = self._pick(idx, "power.watts", "power.max_watts")
        fan_total = self._pick(idx, "fan.count")
        fan_ok = self._pick(idx, "fan.ok_count")
        mem_total = self._pick(idx, "memory.total")
        mem_pct = (self._pick(idx, "memory.used") / mem_total * 100.0) if mem_total > 0 else 0.0
        swap_total = self._pick(idx, "memory.swap_total")
        swap_pct = (self._pick(idx, "memory.swap_used") / swap_total * 100.0) if swap_total > 0 else 0.0
        fan_ratio = (fan_ok / fan_total) if fan_total > 0 else 1.0

        crit, warn = [], []
        if age_s >= age_stale:
            crit.append(f"no data for {age_s:.0f}s (stale at {age_stale:.0f}s)")
        if cpu >= cpu_hot:
            crit.append(f"CPU {cpu:.0f}% (crit {cpu_hot:.0f}%)")
        if temp >= temp_crit:
            crit.append(f"CPU temp {temp:.0f}C (crit {temp_crit:.0f}C)")
        if power >= power_hot:
            crit.append(f"power {power:.0f}W (crit {power_hot:.0f}W)")
        if fan_total > 0 and fan_ratio < fan_ratio_min:
            crit.append(f"fans {fan_ok:.0f}/{fan_total:.0f} ok")
        if gpu_count > 0 and gpu_temp >= gpu_crit:
            crit.append(f"GPU temp {gpu_temp:.0f}C (crit {gpu_crit:.0f}C)")

        if age_s >= age_warn:
            warn.append(f"no data for {age_s:.0f}s (warn {age_warn:.0f}s)")
        if cpu >= cpu_warn:
            warn.append(f"CPU {cpu:.0f}% (warn {cpu_warn:.0f}%)")
        if temp >= temp_warn:
            warn.append(f"CPU temp {temp:.0f}C (warn {temp_warn:.0f}C)")
        if power >= power_warn:
            warn.append(f"power {power:.0f}W (warn {power_warn:.0f}W)")
        if mem_pct >= 85:
            warn.append(f"memory {mem_pct:.0f}%")
        if swap_pct >= 25:
            warn.append(f"swap {swap_pct:.0f}%")
        if gpu_count > 0 and gpu_temp >= gpu_warn:
            warn.append(f"GPU temp {gpu_temp:.0f}C (warn {gpu_warn:.0f}C)")

        # A power crossing says the total moved; the breakdown says why.
        def with_breakdown(reasons: list) -> list:
            if not any(r.startswith("power ") for r in reasons):
                return reasons
            return reasons + self._power_breakdown(idx)

        if crit:
            return "crit", with_breakdown(crit)
        if warn:
            return "warn", with_breakdown(warn)
        return "ok", []

    def _post(self, events: list) -> None:
        worst = "ok"
        for _, _, status, _ in events:
            if STATUS_RANK.get(status, 0) > STATUS_RANK.get(worst, 0):
                worst = status

        fields = []
        # Discord caps an embed at 25 fields and a field value at 1024 chars.
        for node_id, prev, status, reasons in events[:25]:
            lines = []
            for reason in reasons:
                if reason.startswith("breakdown: "):
                    # Rendered as its own italic line rather than a bullet: it
                    # explains the reading above it instead of being a separate
                    # thing that went wrong.
                    lines.append(f"\u2003\u21B3 *{reason[len('breakdown: '):]}*")
                else:
                    lines.append(f"{reason_emoji(reason)}\u2002{reason}")
            if not lines:
                lines.append("\u2705\u2002all metrics back within limits")
            transition = (f"`{prev} \u2192 {status}`" if status != "ok"
                          else f"`{prev} \u2192 ok`")
            fields.append({
                "name": f"{node_id} {STATUS_EMOJI.get(status, '')}",
                "value": (transition + "\n" + "\n".join(lines))[:1024],
                "inline": False,
            })
        if len(events) > 25:
            fields.append({
                "name": "\u2026",
                "value": f"and {len(events) - 25} more node(s)",
                "inline": False,
            })

        counts = {level: sum(1 for e in events if e[2] == level) for level in ("crit", "warn", "ok")}
        summary = " \u00b7 ".join(
            f"{STATUS_EMOJI[level]} {counts[level]} {STATUS_WORD[level]}"
            for level in ("crit", "warn", "ok") if counts[level]
        )

        payload = {
            "username": "HPC Cockpit",
            "embeds": [{
                "title": summary or "node status change",
                "color": STATUS_COLOR.get(worst, STATUS_COLOR["warn"]),
                "fields": fields,
                "footer": {"text": "hpc-cockpit"},
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
            }],
        }
        # A batch can carry several nodes; it rings only if the worst of them
        # is critical, so one crit is never silenced by warnings beside it.
        silent = worst != "crit"
        if silent:
            payload["flags"] = DISCORD_SILENT

        request = urllib.request.Request(
            self._url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": "hpc-cockpit/1.0"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                code = response.status
        except urllib.error.HTTPError as exc:
            # 429 is Discord rate limiting; the next tick will try again.
            print(f"discord_post_failed status={exc.code} events={len(events)}")
            return
        except Exception as exc:
            print(f"discord_post_failed msg={type(exc).__name__} events={len(events)}")
            return
        print(f"discord_post ok status={code} events={len(events)} worst={worst}"
              f" mode={'silent' if silent else 'notify'}")


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


class AuthManager:
    """Login against the cluster's LDAP, then an in-memory session cookie.

    A password is checked by binding to LDAP as the user (ldapwhoami over
    StartTLS), so the cockpit never stores or sees a password hash. The
    password reaches ldapwhoami through a pipe (-y /dev/fd/N), never argv,
    the environment or a file. Sessions live in memory: a server restart logs
    everyone out, which is acceptable for a team dashboard."""

    COOKIE = "cockpit_session"
    USERNAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
    # Failed logins per client IP before it is refused for the window.
    MAX_FAILURES = 5
    FAILURE_WINDOW_S = 600

    def __init__(self, ldap_uri: str, user_dn_template: str, session_hours: float,
                 login_group: str = "") -> None:
        self.ldap_uri = ldap_uri
        self.user_dn_template = user_dn_template
        self.session_s = session_hours * 3600
        self.login_group = login_group
        self._lock = threading.Lock()
        self._sessions = {}   # token -> {"user", "expires"}
        self._failures = {}   # ip -> [monotonic times of recent failures]

    def throttled(self, ip: str) -> bool:
        now = time.monotonic()
        with self._lock:
            recent = [t for t in self._failures.get(ip, []) if now - t < self.FAILURE_WINDOW_S]
            self._failures[ip] = recent
            return len(recent) >= self.MAX_FAILURES

    def _record_failure(self, ip: str) -> None:
        with self._lock:
            self._failures.setdefault(ip, []).append(time.monotonic())

    def _in_group(self, user: str) -> bool:
        if not self.login_group:
            return True
        try:
            import grp
            import pwd
            entry = pwd.getpwnam(user)
            gids = os.getgrouplist(user, entry.pw_gid)
            return any(grp.getgrgid(g).gr_name == self.login_group for g in gids)
        except (KeyError, OSError):
            return False

    def _ldap_bind(self, user: str, password: str) -> bool:
        dn = self.user_dn_template.format(user=user)
        read_fd, write_fd = os.pipe()
        try:
            # Passwords are small; the pipe buffer holds it without a reader.
            os.write(write_fd, password.encode("utf-8"))
            os.close(write_fd)
            write_fd = -1
            proc = subprocess.run(
                ["ldapwhoami", "-x", "-ZZ", "-H", self.ldap_uri, "-D", dn,
                 "-y", f"/dev/fd/{read_fd}"],
                pass_fds=(read_fd,), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            print(f"login_error user={user} msg={type(exc).__name__}")
            return False
        finally:
            os.close(read_fd)
            if write_fd >= 0:
                os.close(write_fd)
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
            # "Invalid credentials" is the normal wrong-password answer; any
            # other message means LDAP itself is unreachable or misconfigured.
            if err and "Invalid credentials" not in err[-1]:
                print(f"login_ldap_error user={user} msg={err[-1][:200]}")
            return False
        return True

    def login(self, user: str, password: str, ip: str):
        """Returns (token, None) or (None, reason)."""
        if self.throttled(ip):
            return None, "throttled"
        # An empty password makes an LDAP simple bind "unauthenticated" and it
        # SUCCEEDS, so it must be refused here, before LDAP sees it.
        if not isinstance(user, str) or not self.USERNAME_RE.match(user) \
                or not isinstance(password, str) or not password or len(password) > 1024:
            self._record_failure(ip)
            return None, "invalid"
        if not self._ldap_bind(user, password) or not self._in_group(user):
            self._record_failure(ip)
            print(f"login_failed user={user} ip={ip}")
            return None, "invalid"
        token = secrets.token_urlsafe(32)
        with self._lock:
            now = time.time()
            self._sessions = {t: s for t, s in self._sessions.items() if s["expires"] > now}
            self._sessions[token] = {"user": user, "expires": now + self.session_s}
            self._failures.pop(ip, None)
        print(f"login_ok user={user} ip={ip}")
        return token, None

    def session_user(self, token: str):
        if not token:
            return None
        with self._lock:
            s = self._sessions.get(token)
            if s is None:
                return None
            if s["expires"] <= time.time():
                del self._sessions[token]
                return None
            return s["user"]

    def logout(self, token: str) -> None:
        with self._lock:
            self._sessions.pop(token, None)


class ApiHandler(SimpleHTTPRequestHandler):
    state: StateStore = None
    schedule: ScheduleStore = None
    settings: SettingsStore = None
    test_mode: bool = False
    worker_exec_port: int = 9100
    auth: AuthManager = None      # None only with --no-auth
    tls: bool = False

    # Reachable without a session: the login page and what it loads.
    PUBLIC_PATHS = {"/login.html", "/styles.css", "/vendor/fonts.css", "/auth.js"}
    PUBLIC_PREFIXES = ("/vendor/fonts/", "/assets/")

    def _clean_path(self) -> str:
        path = posixpath.normpath(unquote(urlsplit(self.path).path))
        return "/" if path in (".", "") else path

    def _session_token(self) -> str:
        raw = self.headers.get("Cookie", "")
        if not raw:
            return ""
        try:
            morsel = SimpleCookie(raw).get(AuthManager.COOKIE)
        except Exception:
            return ""
        return morsel.value if morsel else ""

    def _from_this_host(self) -> bool:
        ip = self.client_address[0]
        try:
            if ipaddress.ip_address(ip).is_loopback:
                return True
        except ValueError:
            return False
        # Prometheus on this host scraping ntu-scc04:8080 connects from the
        # host's own address, which is also the address it connected to.
        return ip == self.connection.getsockname()[0]

    def _gate(self) -> bool:
        """Every request passes through here first. Returns True to proceed;
        otherwise the response (401 / 302 / 403) has already been sent."""
        self.user = None
        if self.auth is None:
            return True
        path = self._clean_path()
        if self.command in ("POST", "PUT", "DELETE"):
            # SameSite=Strict already keeps the cookie off cross-site
            # requests; refusing a foreign Origin is a second guard.
            origin = self.headers.get("Origin")
            if origin and urlsplit(origin).netloc != self.headers.get("Host", ""):
                self._json({"error": "cross-origin request refused"}, status=HTTPStatus.FORBIDDEN)
                return False
        if path in ("/api/login", "/api/logout"):
            return True
        if self.command in ("GET", "HEAD") and (
                path in self.PUBLIC_PATHS or path.startswith(self.PUBLIC_PREFIXES)):
            return True
        if path == "/metrics" and self._from_this_host():
            return True
        self.user = self.auth.session_user(self._session_token())
        if self.user:
            return True
        if path.startswith("/api/") or path == "/metrics":
            self._json({"error": "login required"}, status=HTTPStatus.UNAUTHORIZED)
        elif self.command in ("GET", "HEAD") and (path == "/" or path.endswith(".html")):
            target = urlsplit(self.path)
            nxt = target.path + (f"?{target.query}" if target.query else "")
            self.send_response(HTTPStatus.FOUND.value)
            self.send_header("Location", "/login.html?next=" + quote(nxt, safe=""))
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self.send_response(HTTPStatus.UNAUTHORIZED.value)
            self.send_header("Content-Length", "0")
            self.end_headers()
        return False

    def _set_session_cookie(self, token: str, max_age: int) -> None:
        parts = [f"{AuthManager.COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Strict",
                 f"Max-Age={max_age}"]
        if self.tls:
            parts.append("Secure")
        self.send_header("Set-Cookie", "; ".join(parts))

    def _handle_login(self) -> None:
        body = self._read_json_body()
        if body is None:
            return
        if not isinstance(body, dict):
            self._json({"error": "body must be an object"}, status=HTTPStatus.BAD_REQUEST)
            return
        token, err = self.auth.login(body.get("username"), body.get("password"),
                                     self.client_address[0])
        if err == "throttled":
            self._json({"error": "too many failed logins, try again in 10 minutes"},
                       status=HTTPStatus.TOO_MANY_REQUESTS)
            return
        if err:
            self._json({"error": "wrong username or password"}, status=HTTPStatus.UNAUTHORIZED)
            return
        encoded = json.dumps({"user": body.get("username")}).encode("utf-8")
        self.send_response(HTTPStatus.OK.value)
        self._set_session_cookie(token, int(self.auth.session_s))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _handle_logout(self) -> None:
        if self.auth is not None:
            self.auth.logout(self._session_token())
        encoded = b'{"ok": true}'
        self.send_response(HTTPStatus.OK.value)
        self._set_session_cookie("", 0)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_HEAD(self) -> None:
        if not self._gate():
            return
        super().do_HEAD()

    def __init__(self, *args, **kwargs):
        web_dir = kwargs.pop("web_dir")
        super().__init__(*args, directory=web_dir, **kwargs)

    def end_headers(self) -> None:
        # Without this the browser may reuse a cached node.html after an
        # update (heuristic caching off Last-Modified), which once kept the
        # removed fan-control code running. "no-cache" still allows the
        # cache, but forces a revalidation (cheap 304) on every load.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self) -> None:
        if not self._gate():
            return

        if self.path == "/api/me":
            self._json({"user": self.user, "auth": self.auth is not None})
            return

        if self.path == "/api/config":
            self._json({"test_panel": self.test_mode})
            return

        if self.path == "/api/health":
            self._json(self.state.health())
            return

        if self.path == "/api/nodes":
            self._json({"nodes": self.state.node_summaries(),
                        "aux_power": self.state.aux_power()})
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

        if self.path.split("?", 1)[0] == "/metrics":
            encoded = self.state.prometheus_text().encode("utf-8")
            self.send_response(HTTPStatus.OK.value)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
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
        if not self._gate():
            return
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
        if not self._gate():
            return
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
        if not self._gate():
            return

        if self.path == "/api/login":
            if self.auth is None:
                self._json({"error": "login disabled (--no-auth)"}, status=HTTPStatus.NOT_FOUND)
                return
            self._handle_login()
            return

        if self.path == "/api/logout":
            self._handle_logout()
            return

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


class HttpsRedirectHandler(BaseHTTPRequestHandler):
    """Answers a plain-HTTP request that reached the HTTPS port with a
    redirect to the same URL over https, so old http:// bookmarks keep
    working. Nothing else is served without TLS."""

    def _redirect(self) -> None:
        host = self.headers.get("Host", "")
        if not host or not re.match(r"^[A-Za-z0-9.\-\[\]:]+$", host):
            self.send_error(HTTPStatus.BAD_REQUEST.value, "use https://")
            return
        self.send_response(HTTPStatus.MOVED_PERMANENTLY.value)
        self.send_header("Location", f"https://{host}{self.path}")
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = _redirect

    def log_message(self, fmt, *args) -> None:
        pass


class TlsHTTPServer(ThreadingHTTPServer):
    """HTTPS with a plain-HTTP redirect on the same port.

    TLS is set up per connection inside the request's own thread, so a slow
    or stalled client never blocks accept() for everyone else. The first byte
    tells the two apart: a TLS ClientHello starts with 0x16, an HTTP request
    with a method name."""

    tls_context: ssl.SSLContext = None

    def finish_request(self, request, client_address) -> None:
        request.settimeout(10)
        try:
            first = request.recv(1, socket.MSG_PEEK)
        except OSError:
            return
        if not first:
            return
        if first != b"\x16":
            HttpsRedirectHandler(request, client_address, self)
            return
        try:
            tls_sock = self.tls_context.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError):
            return  # failed handshake: certificate rejected, scanner, ...
        tls_sock.settimeout(None)
        try:
            self.RequestHandlerClass(tls_sock, client_address, self)
        finally:
            try:
                tls_sock.close()
            except OSError:
                pass


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
    auth: "AuthManager" = None,
    tls_context: "ssl.SSLContext" = None,
) -> ThreadingHTTPServer:
    ApiHandler.state = state
    ApiHandler.schedule = schedule
    ApiHandler.settings = settings
    ApiHandler.worker_exec_port = worker_exec_port
    ApiHandler.auth = auth
    ApiHandler.tls = tls_context is not None

    def factory(*args, **kwargs):
        return ApiHandler(*args, web_dir=web_dir, **kwargs)

    if tls_context is None:
        return ThreadingHTTPServer((bind_host, bind_port), factory)
    server = TlsHTTPServer((bind_host, bind_port), factory)
    server.tls_context = tls_context
    return server


# Where the HTTPS certificate is picked up from when no --tls-* flag is given.
# Outside the repo, so the private key can never be committed.
DEFAULT_TLS_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "hpc-cockpit", "tls")


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
        "--discord-webhook",
        default=None,
        help="Discord webhook for warn/crit alerts (default: built-in; "
             "empty string disables; env HPC_COCKPIT_DISCORD_WEBHOOK also works)",
    )
    parser.add_argument(
        "--ldap-uri", default="ldap://ntu-scc04",
        help="LDAP server checked at login, via StartTLS (default: ldap://ntu-scc04)")
    parser.add_argument(
        "--ldap-user-dn", default="uid={user},ou=people,dc=scc26,dc=ntu,dc=local",
        help="DN template a user binds as; {user} is replaced by the login name")
    parser.add_argument(
        "--login-group", default="",
        help="only members of this Unix/LDAP group may log in (default: any LDAP user)")
    parser.add_argument(
        "--session-hours", type=float, default=12.0,
        help="how long a login lasts (default: 12)")
    parser.add_argument(
        "--no-auth", action="store_true",
        help="serve everything without a login (local testing only)")
    parser.add_argument(
        "--tls-cert", default=None,
        help=f"PEM certificate (default: {DEFAULT_TLS_DIR}/cockpit.crt if it exists)")
    parser.add_argument(
        "--tls-key", default=None,
        help=f"PEM private key (default: {DEFAULT_TLS_DIR}/cockpit.key if it exists)")
    parser.add_argument("--no-tls", action="store_true", help="serve plain HTTP even if a certificate exists")
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

    auth = None
    if not args.no_auth:
        auth = AuthManager(args.ldap_uri, args.ldap_user_dn, args.session_hours,
                           args.login_group)
    tls_context = None
    # HTTPS turns on by itself when the certificate and key sit in the default
    # place, so the server needs no arguments; flags override, --no-tls opts out.
    if not args.no_tls and not args.tls_cert and not args.tls_key:
        cert = os.path.join(DEFAULT_TLS_DIR, "cockpit.crt")
        key = os.path.join(DEFAULT_TLS_DIR, "cockpit.key")
        if os.path.isfile(cert) and os.path.isfile(key):
            args.tls_cert, args.tls_key = cert, key
    if args.no_tls:
        args.tls_cert = args.tls_key = None
    if args.tls_cert or args.tls_key:
        if not (args.tls_cert and args.tls_key):
            print("error: --tls-cert and --tls-key go together")
            return 2
        tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_context.minimum_version = ssl.TLSVersion.TLSv1_2
        tls_context.load_cert_chain(args.tls_cert, args.tls_key)

    udp_server = start_udp_server(args.udp_host, args.udp_port, state)
    http_server = start_http_server(
        args.http_host,
        args.http_port,
        state,
        schedule,
        settings,
        web_dir,
        args.worker_exec_port,
        auth,
        tls_context,
    )

    udp_thread = threading.Thread(target=udp_server.serve_forever, daemon=True)
    udp_thread.start()

    # Precedence: --discord-webhook, then the env var, then the built-in URL.
    webhook = args.discord_webhook
    if webhook is None:
        webhook = os.environ.get("HPC_COCKPIT_DISCORD_WEBHOOK", DISCORD_WEBHOOK_URL)
    notifier = None
    if webhook.strip():
        notifier = AlertNotifier(webhook.strip(), state, settings)
        notifier.start()
    # Never print the URL itself.
    print(f"discord_alerts={'on' if notifier else 'off'}")

    if auth is None:
        print("auth=OFF (--no-auth): every endpoint is open")
    else:
        print(f"auth=ldap uri={args.ldap_uri} group={args.login_group or '(any)'} "
              f"session_hours={args.session_hours:g} "
              f"tls={'on cert=' + args.tls_cert if tls_context else 'off'}")
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
        if notifier is not None:
            notifier.stop()
        udp_server.shutdown()
        http_server.shutdown()
        udp_server.server_close()
        http_server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
