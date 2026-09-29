#!/usr/bin/env python3
"""Build the 'SCC26v1' fan profile for each node from that node's own stock
'default' profile. Writes JSON only -- nothing is sent to any BMC.

    export BMC_PASSWORD=...         # credentials come from the environment
    ./fanpolicy_scc26.py            # build: -> worker/fan/SCC26v1-<node>.json + a diff table
    ./fanpolicy_scc26.py apply      # back up, upload SCC26v1, activate, verify (all 4 nodes)
    ./fanpolicy_scc26.py status     # active profile + live fan/HIC per node
    ./fanpolicy_scc26.py revert     # activate stock 'default' again (never edited)

Design basis (all measured on ntu-scc03, 2026-09-25, GPUs idle):
  * fan power ~ rpm^3; SYS 1375 W, REAR 1050 W, EXT <25 W, CPU <15 W at 100%.
  * At idle, SYS is set by the HIC policy alone (GPU/CPU sensors sit below 55 C).
    A fixed-point model of that loop, built from the measured HIC-vs-duty curve,
    reproduces the stock operating point (predicted 73% / 76 C, observed 72% /
    76-77 C), so the HIC ramp below is chosen from the model: [75,100] C settles
    at ~52% SYS duty, HIC ~83 C, ~330 W/node less than stock at idle.
  * Every other temperature ramp keeps the stock 30% floor and stock maximum,
    and moves so that 100% duty is reached a fixed margin under that sensor's
    own BMC warn level, instead of the stock one-size 55 C knee.
  * Non-temperature policies (P12V current, iSensorCode 3) are left EXACTLY as
    stock until measured under load -- see LOAD_UNKNOWN below.
"""
import json, os, re, subprocess, time

HERE = os.path.dirname(os.path.abspath(__file__))
NODES = {"scc01": "172.16.67.11", "scc02": "172.16.67.12",
         "scc03": "172.16.67.13", "scc04": "172.16.67.14"}
NAME = "SCC26v1"
# BMC credentials come from the environment, never from the repo:
#   BMC_USER (default "admin"), BMC_PASSWORD (required)
USER = os.environ.get("BMC_USER", "admin")
PW = os.environ.get("BMC_PASSWORD", "")
HYST = 2            # degC; stock is 0 on every policy, which lets fans hunt
H200 = "0x233b"

# (group, match on first sensor name, new [knee, full] degC, BMC warn, why)
RULES = [
    ("HIC",     r"^HIC_",          (80, 100), 105, "model: ~48% / 85 C idle (v1 had [75,100]: ran 58% / 85 C)"),
    ("GPU",     r"_GPU\d+_TEMP$",  (76,  90),  91, "under HPL at [70,86]: 78-80 C, no slowdown, fans 66-74%"),
    ("CPU",     r"^CPU\d_TEMP$",   (75,  92),  97, "5 C under CPU warn"),
    ("DIMM",    r"^DIMM",          (70,  82),  85, "3 C under DIMM warn"),
    ("VR",      r"^VR_",           (90, 108), 115, "7 C under VR warn"),
    ("NIC",     r"^SLOT\d+_TEMP$", (80,  95), 100, "5 C under NIC warn"),
    ("STORAGE", r"^(M2_AMB|NVMe)", (58,  70),  75, "5 C under NVMe warn"),
    ("PSU",     r"^PSU\d_HOTSPOT", (85, 100), 105, "5 C under PSU warn"),
]
LOAD_UNKNOWN = "P12V GPU 12V-aux current policy: left stock ([4,14] A) until measured under load"


def sh(*a, t=60):
    return subprocess.run(a, capture_output=True, text=True, timeout=t).stdout


def sensor_names(ip):
    names = {}
    out = sh("ipmitool", "-I", "lanplus", "-H", ip, "-U", USER, "-P", PW, "sdr", "-v", t=120)
    for m in re.finditer(r"Sensor ID\s*:\s*(\S+)\s*\((0x[0-9a-fA-F]+)\)", out):
        names[int(m.group(2), 16)] = m.group(1)
    return names


class Bmc:
    """One session per node, always handed back (a leaked session per call
    exhausts the BMC table and makes every later write silently 401)."""
    def __init__(self, ip):
        self.ip, self.jar, self.csrf = ip, f"/tmp/scc26-{ip}.jar", None

    def __enter__(self):
        for _ in range(20):
            out = sh("curl", "-sk", "--max-time", "15", "-c", self.jar, "-X", "POST",
                     f"https://{self.ip}/api/session",
                     "-H", "Content-Type: application/x-www-form-urlencoded",
                     "--data-urlencode", f"username={USER}", "--data-urlencode", f"password={PW}")
            try:
                self.csrf = json.loads(out).get("CSRFToken")
            except Exception:
                self.csrf = None
            if self.csrf:
                return self
            time.sleep(15)
        raise RuntimeError(f"{self.ip}: no BMC session")

    def __exit__(self, *e):
        sh("curl", "-sk", "--max-time", "10", "-b", self.jar, "-H", f"X-CSRFTOKEN: {self.csrf}",
           "-X", "DELETE", f"https://{self.ip}/api/session", "-o", "/dev/null")

    def call(self, method, path, body=None):
        cmd = ["curl", "-sk", "--compressed", "--max-time", "40", "-b", self.jar,
               "-H", f"X-CSRFTOKEN: {self.csrf}", "-H", "Content-Type: application/json",
               "-X", method, "-o", "/tmp/scc26-resp.json", "-w", "%{http_code}",
               f"https://{self.ip}{path}"]
        if body is not None:
            cmd[-1:-1] = ["--data-binary", body]
        code = sh(*cmd).strip()
        try:
            return code, open("/tmp/scc26-resp.json").read()
        except Exception:
            return code, ""


def read_default(ip):
    with Bmc(ip) as b:
        _, col = b.call("GET", "/api/settings/fanprofile/collection")
    return [p for p in json.loads(col) if p["strName"] == "default"][0]


def build(default, names):
    p = json.loads(json.dumps(default))
    p["strName"] = NAME
    rows = []
    for i, q in enumerate(p["arrPolicy"]):
        first = names.get(q["arrSensor"][0], f"#{q['arrSensor'][0]}") if q["arrSensor"] else "?"
        ref0, duty0 = list(q["arrRef"]), list(q["arrDuty"])
        group, note = "-", "stock (unchanged)"
        gated_other = (q.get("iPCIEDeviceEnable") == 1 and H200 not in q.get("arrHexDeviceID", []))
        if q.get("iSensorCode") != 1:
            note = LOAD_UNKNOWN if first.startswith("P12V") else "non-temperature: stock"
        elif len(q["arrRef"]) != 2:
            note = "single-point backstop: stock"
        elif gated_other:
            group, note = "GPU", "gated to another GPU SKU, inactive here: stock"
        else:
            for g, pat, ref, warn, why in RULES:
                if re.search(pat, first):
                    q["arrRef"] = list(ref)
                    q["iHysteresis"] = HYST
                    group, note = g, why
                    break
        rows.append((i, group, first, ref0, q["arrRef"], duty0, q["arrDuty"], note))
    return p, rows


def build_all():
    names = sensor_names(NODES["scc03"])       # same firmware, same sensor numbering
    for node, ip in NODES.items():
        default = read_default(ip)
        prof, rows = build(default, names)
        path = os.path.join(HERE, f"{NAME}-{node}.json")
        json.dump(prof, open(path, "w"), indent=1)
        changed = sum(1 for r in rows if r[3] != r[4])
        print(f"\n===== {node}: {len(rows)} policies, {changed} changed -> {os.path.basename(path)}")
        for i, g, first, r0, r1, d0, d1, note in rows:
            mark = "*" if r0 != r1 else " "
            print(f" {mark}{i:>3} {g:<8}{first:<17}{str(r0):>10} -> {str(r1):<10}{note}")


def apply_all():
    names = sensor_names(NODES["scc03"])
    os.makedirs(os.path.join(HERE, "backup"), exist_ok=True)
    for node, ip in NODES.items():
        print(f"\n===== {node} ({ip})")
        with Bmc(ip) as b:
            _, raw = b.call("GET", "/api/settings/fanprofile/collection")
            col = json.loads(raw)
            _, mode = b.call("GET", "/api/settings/fanprofile/mode")
            stamp = time.strftime("%Y%m%d-%H%M%S")
            bpath = os.path.join(HERE, "backup", f"{node}-collection-{stamp}.json")
            json.dump({"mode": json.loads(mode), "collection": col}, open(bpath, "w"), indent=1)
            print(f"   was active: {mode.strip()}   backup -> backup/{os.path.basename(bpath)}")
            default = [p for p in col if p["strName"] == "default"][0]
            # rebuild from the node's CURRENT default, so a stale JSON can't be pushed
            prof, _ = build(default, names)
            path = f"/tmp/scc26-{node}.json"
            json.dump(prof, open(path, "w"))
            exists = NAME in [p["strName"] for p in col]
            if exists:
                code, _ = b.call("PUT", f"/api/settings/fanprofile/collection/{NAME}", f"@{path}")
            else:
                code, _ = b.call("POST", "/api/settings/fanprofile/collection", f"@{path}")
            print(f"   {'update' if exists else 'create'} {NAME}: http {code}")
            if code != "200":
                print("   !! upload failed -- NOT activating; node left as it was")
                continue
            code, txt = b.call("POST", "/api/settings/fanprofile/mode", json.dumps({"strMode": NAME}))
            print(f"   activate: http {code} {txt.strip()}")
            _, raw2 = b.call("GET", "/api/settings/fanprofile/collection")
            col2 = json.loads(raw2)
            stored = [p for p in col2 if p["strName"] == NAME]
            ok_store = bool(stored) and stored[0]["arrPolicy"] == prof["arrPolicy"]
            ok_def = [p for p in col2 if p["strName"] == "default"][0] == default
            _, m = b.call("GET", "/api/settings/fanprofile/mode")
            ok_mode = NAME in m
            print(f"   verify: active={ok_mode}  stored-as-built={ok_store}  stock-default-untouched={ok_def}")
            if not (ok_mode and ok_store and ok_def):
                print("   !! VERIFY FAILED -- reverting this node to default")
                b.call("POST", "/api/settings/fanprofile/mode", '{"strMode":"default"}')


def revert_all():
    for node, ip in NODES.items():
        with Bmc(ip) as b:
            code, txt = b.call("POST", "/api/settings/fanprofile/mode", '{"strMode":"default"}')
            _, m = b.call("GET", "/api/settings/fanprofile/mode")
        print(f"{node}: activate default http {code} -> now {m.strip()}")


def status_all():
    for node, ip in NODES.items():
        with Bmc(ip) as b:
            _, m = b.call("GET", "/api/settings/fanprofile/mode")
        fans = sh("ipmitool", "-I", "lanplus", "-H", ip, "-U", USER, "-P", PW, "sdr", "type", "Fan")
        temps = sh("ipmitool", "-I", "lanplus", "-H", ip, "-U", USER, "-P", PW, "sdr", "type", "Temperature")
        def val(txt, pre):
            vs = []
            for line in txt.splitlines():
                f = [x.strip() for x in line.split("|")]
                if len(f) >= 5 and f[0].startswith(pre) and f[4][:1].isdigit():
                    vs.append(float(f[4].split()[0]))
            return vs
        mean = lambda v: f"{sum(v)/len(v):.0f}" if v else "-"
        mx = lambda v: f"{max(v):.0f}" if v else "-"
        print(f"{node}: {m.strip():<24} SYS {mean(val(fans,'SYS_FAN')):>6}  REAR {mean(val(fans,'REAR')):>5}"
              f"  HIC {mx(val(temps,'HIC')):>3}C  CPU {mx(val(temps,'CPU')):>3}C  GPU {mx([v for v in val(temps,'SLOT') if False]+[float(l.split('|')[4].split()[0]) for l in temps.splitlines() if '_GPU' in l.split('|')[0] and l.split('|')[4].strip()[:1].isdigit()]):>3}C  NIC {mx([float(l.split('|')[4].split()[0]) for l in temps.splitlines() if re.match(r'SLOT\d+_TEMP', l.split('|')[0].strip()) and l.split('|')[4].strip()[:1].isdigit()]):>3}C")


def main():
    import sys
    if not PW:
        sys.exit("set BMC_PASSWORD (and BMC_USER if not 'admin') in the environment first")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    {"build": build_all, "apply": apply_all, "revert": revert_all, "status": status_all}[cmd]()


if __name__ == "__main__":
    main()
