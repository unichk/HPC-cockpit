# Node-side NVIDIA GPU tuning for the cockpit's GPU Tuning panel. node.html
# fetches this file, prepends an ARGS = {...} line and runs it through the
# worker exec channel (as root). Standard library + nvidia-smi only.
#
# ARGS: op    "status" | "power" | "clocks" | "reset_clocks" | "memclock"
#             | "reset_memclock" | "vboost"
#       gpus  list of GPU indices (empty or absent = all GPUs)
#       watts (power) | min, max (clocks, MHz) | mhz (memclock) | value (vboost)
#
# Every value is validated against what the GPU itself reports (power limits,
# supported clocks, boost-slider maximum) before anything is written, and the
# result is read back where the driver exposes it. The last stdout line is
# always "RESULT {json}". Clock locks, memory locks and vboost last until a
# reset, a reboot or a driver reload; the power limit persists only while
# persistence mode is on, which "power" enables.
import json
import os
import re
import subprocess
import time

A = ARGS  # noqa: F821  (injected by node.html)

# The driver has no readback for SM clock locks (neither nvidia-smi nor NVML's
# P-state min/max reflects -lgc), so locks set here are recorded on the node.
# /run is tmpfs: the record vanishes at reboot, exactly when the locks do.
STATE = "/run/cockpit-gputune.json"
IDLE_SLACK_MHZ = 30     # an idle GPU sits at its floor; more than this above it = locked


def load_state():
    try:
        with open(STATE) as f:
            return {int(k): v for k, v in json.load(f).items()}
    except (OSError, ValueError):
        return {}


def save_state(st):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({str(k): v for k, v in st.items()}, f)
    os.replace(tmp, STATE)


def smi(*args, timeout=60):
    """-> (rc, output). nvidia-smi exits 0 even when it prints "not supported"
    (e.g. -lmc on an H200), so that text is turned into a failure here."""
    p = subprocess.run(["nvidia-smi", *args], capture_output=True, text=True, timeout=timeout)
    out = (p.stdout + p.stderr).strip()
    rc = p.returncode
    if rc == 0 and "not supported" in out.lower():
        rc = 3
    return rc, out


def csv_query(fields, gpus=None):
    args = [f"--query-gpu={','.join(fields)}", "--format=csv,noheader,nounits"]
    if gpus:
        args = ["-i", ",".join(map(str, gpus))] + args
    rc, out = smi(*args)
    if rc != 0:
        raise RuntimeError(out)
    rows = []
    for line in out.splitlines():
        vals = [v.strip() for v in line.split(",")]
        rows.append(dict(zip(fields, vals)))
    return rows


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def vboost_state():
    """-> {gpu_index: (current, max)} from `nvidia-smi boost-slider -l`."""
    rc, out = smi("boost-slider", "-l")
    st = {}
    if rc != 0:
        return st
    for line in out.splitlines():
        m = re.match(r"\|\s*(\d+)\s+vboost\s+(\d+)\s+(\d+)\s*\|", line)
        if m:
            st[int(m.group(1))] = (int(m.group(3)), int(m.group(2)))
    return st


def supported_clocks(idx):
    rc, out = smi("-i", str(idx), "--query-supported-clocks=memory,graphics",
                  "--format=csv,noheader,nounits")
    if rc != 0:
        return [], []
    mem, gfx = set(), set()
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            mem.add(int(parts[0]))
            gfx.add(int(parts[1]))
    return sorted(mem), sorted(gfx)


def deferred_mem():
    """-> {pci_bus_id_lower: deferred memory MHz or None}, one nvidia-smi call."""
    rc, out = smi("-q", "-d", "CLOCK")
    res, cur, in_def = {}, None, False
    for line in out.splitlines():
        m = re.match(r"^GPU\s+([0-9A-Fa-f:.]+)\s*$", line.strip())
        if m:
            cur, in_def = m.group(1).lower(), False
            continue
        if "Deferred Clocks" in line:
            in_def = True
            continue
        if in_def and "Memory" in line and cur:
            v = line.split(":", 1)[1].strip()
            res[cur] = int(v.split()[0]) if v.split() and v.split()[0].isdigit() else None
            in_def = False
    return res


def status(gpus=None):
    # 3-4 nvidia-smi calls total (each costs 1-9 s of NVML start-up on these
    # nodes): the per-GPU query, the boost sliders, supported clocks once per
    # GPU model, and the deferred memory clocks.
    rows = csv_query(["index", "name", "pci.bus_id", "power.limit", "power.min_limit", "power.max_limit",
                      "power.default_limit", "clocks.sm", "clocks.mem", "clocks.max.sm",
                      "clocks.max.mem", "persistence_mode", "utilization.gpu"], gpus)
    vb = vboost_state()
    dm = deferred_mem()
    by_model = {}
    out = []
    for r in rows:
        i = int(r["index"])
        if r["name"] not in by_model:
            by_model[r["name"]] = supported_clocks(i)
        mem, gfx = by_model[r["name"]]
        cur, vmax = vb.get(i, (None, None))
        out.append({
            "idx": i, "name": r["name"],
            "power_limit": num(r["power.limit"]), "power_min": num(r["power.min_limit"]),
            "power_max": num(r["power.max_limit"]), "power_default": num(r["power.default_limit"]),
            "sm_mhz": num(r["clocks.sm"]), "mem_mhz": num(r["clocks.mem"]),
            "sm_max": num(r["clocks.max.sm"]), "mem_max": num(r["clocks.max.mem"]),
            "sm_min": gfx[0] if gfx else None, "mem_supported": mem,
            "vboost": cur, "vboost_max": vmax,
            "mem_deferred": dm.get(r["pci.bus_id"].lower().replace("00000000:", "0000:"),
                                   dm.get(r["pci.bus_id"].lower())),
            "persistence": r["persistence_mode"], "util": num(r["utilization.gpu"]),
        })
    rec = load_state()
    stale = []
    for g in out:
        lock = rec.get(g["idx"])
        idle = (g["util"] or 0) == 0
        above_floor = (g["sm_mhz"] or 0) > (g["sm_min"] or 0) + IDLE_SLACK_MHZ
        if lock and idle and not above_floor and lock["min"] > (g["sm_min"] or 0) + IDLE_SLACK_MHZ:
            stale.append(g["idx"])          # lock was cleared outside us (reset / reload)
            lock = None
        g["sm_lock"] = lock                  # {"min","max","t"} or None
        g["sm_lock_external"] = bool(not lock and idle and above_floor)
    if stale:
        for i in stale:
            rec.pop(i, None)
        try:
            save_state(rec)
        except OSError:
            pass
    return out


def result(ok, msg, **kw):
    print("RESULT " + json.dumps(dict(ok=ok, msg=msg, **kw)))


def targets(st):
    want = A.get("gpus") or []
    have = [g["idx"] for g in st]
    if not want:
        return have
    bad = [g for g in want if g not in have]
    if bad:
        raise RuntimeError("no such GPU index: %s (have %s)" % (bad, have))
    return list(want)


def gpu_arg(ids):
    return ["-i", ",".join(map(str, ids))]


def run():
    op = A.get("op", "status")
    st = status()
    by = {g["idx"]: g for g in st}
    if op == "status":
        return result(True, "ok", gpus=st)
    ids = targets(st)
    sel = [by[i] for i in ids]

    if op == "power":
        w = int(A["watts"])
        lo = max(g["power_min"] for g in sel)
        hi = min(g["power_max"] for g in sel)
        if not lo <= w <= hi:
            raise RuntimeError("power must be %d-%d W for these GPUs" % (lo, hi))
        smi(*gpu_arg(ids), "-pm", "1")
        rc, out = smi(*gpu_arg(ids), "-pl", str(w))
        if rc != 0:
            raise RuntimeError(out)
        now = status(ids)
        got = sorted({int(g["power_limit"]) for g in now})
        ok = got == [w]
        return result(ok, "power cap %d W on GPU %s%s" % (w, ids, "" if ok else " (read back %s)" % got),
                      gpus=now)

    if op == "clocks":
        lo_req, hi_req = int(A["min"]), int(A["max"])
        lo = max(g["sm_min"] or 0 for g in sel)
        hi = min(g["sm_max"] or 0 for g in sel)
        if not (lo <= lo_req <= hi_req <= hi):
            raise RuntimeError("SM clock range must satisfy %d <= min <= max <= %d MHz" % (lo, hi))
        rc, out = smi(*gpu_arg(ids), "-lgc", "%d,%d" % (lo_req, hi_req))
        if rc != 0:
            raise RuntimeError(out)
        rec = load_state()
        for i in ids:
            rec[i] = {"min": lo_req, "max": hi_req, "t": int(time.time())}
        save_state(rec)
        return result(True, "SM clocks locked to %d-%d MHz on GPU %s" % (lo_req, hi_req, ids),
                      detail=out.splitlines()[-1] if out else "", gpus=status(ids))

    if op == "reset_clocks":
        rc, out = smi(*gpu_arg(ids), "-rgc")
        if rc != 0:
            raise RuntimeError(out)
        rec = load_state()
        for i in ids:
            rec.pop(i, None)
        save_state(rec)
        return result(True, "SM clock lock removed on GPU %s" % ids, gpus=status(ids))

    if op == "memclock":
        mhz = int(A["mhz"])
        allowed = set.intersection(*(set(g["mem_supported"]) for g in sel)) if sel else set()
        if mhz not in allowed:
            raise RuntimeError("memory clock must be one of %s MHz" % sorted(allowed))
        rc, out = smi(*gpu_arg(ids), "-lmc", "%d,%d" % (mhz, mhz))
        if rc == 0:
            return result(True, "memory clock locked to %d MHz on GPU %s (immediate)" % (mhz, ids),
                          gpus=status(ids))
        # Hopper/H200: only a deferred lock exists; it applies at the next GPU
        # reset, driver reload or reboot.
        rc, out = smi(*gpu_arg(ids), "-lmcd", str(mhz))
        if rc != 0:
            raise RuntimeError(out)
        now = status(ids)
        pend = sorted({g["mem_deferred"] for g in now}, key=str)
        return result(True, "memory clock %d MHz set as DEFERRED on GPU %s: takes effect after a GPU "
                      "reset or reboot (pending now: %s)" % (mhz, ids, pend), gpus=now)

    if op == "reset_memclock":
        rc, out = smi(*gpu_arg(ids), "-rmc")
        rc2, out2 = smi(*gpu_arg(ids), "-rmcd")
        if rc != 0 and rc2 != 0:
            raise RuntimeError(out2 or out)
        return result(True, "memory clock lock%s cleared on GPU %s" % (
            " (deferred)" if rc != 0 else "", ids), gpus=status(ids))

    if op == "vboost":
        v = int(A["value"])
        vmax = min((g["vboost_max"] for g in sel if g["vboost_max"] is not None), default=None)
        if vmax is None:
            raise RuntimeError("boost slider not supported on these GPUs")
        if not 0 <= v <= vmax:
            raise RuntimeError("vboost must be 0-%d" % vmax)
        rc, out = smi("boost-slider", *gpu_arg(ids), "--vboost", str(v))
        if rc != 0:
            raise RuntimeError(out)
        now = status(ids)
        got = sorted({g["vboost"] for g in now})
        ok = got == [v]
        return result(ok, "vboost %d on GPU %s%s" % (v, ids, "" if ok else " (read back %s)" % got),
                      gpus=now)

    raise RuntimeError("unknown op %r" % op)


try:
    run()
except Exception as e:  # noqa: BLE001 - reported to the UI
    result(False, str(e))
