# Node-side fan control for Gigabyte / AMI MegaRAC BMCs, via the fan-PROFILE
# API recovered from the BMC web UI's own code (source.min.js):
#
#   list     GET    /api/settings/fanprofile/collection
#   create   POST   /api/settings/fanprofile/collection        {profile}
#   edit     PUT    /api/settings/fanprofile/collection/<name> {profile}
#   delete   DELETE /api/settings/fanprofile/collection/<name>
#   active   GET    /api/settings/fanprofile/mode
#   activate POST   /api/settings/fanprofile/mode              {"strMode": <name>}
#
# node.html embeds this file after an ARGS = {...} line and runs it through the
# worker exec channel. It needs only python3's standard library, so the BMC
# password never appears on a process command line.
#
# ARGS: host, user, pass, op ("status" | "activate" | "manual"),
#       name (activate), pct + kind ("floor" | "pin") + base (manual),
#       groups (manual, optional): {"SYS": 40, "REAR": null, ...} - per fan
#       group duty instead of one pct for all; null keeps that group on the
#       base profile's own behaviour.
#
# Manual duty is a temporary profile called MANUAL, built from `base`:
#   floor : every policy's minimum SET to pct (can go below the base profile's
#           own floor); all thermal ramps kept, so the BMC still speeds fans up
#           as anything heats. The safe way to run fans low.
#   pin   : every policy fixed at pct; NO thermal ramp.
# Range 0-100%. Measured on scc04: Floor 20% -> SYS 4,481 rpm, CPU fans 2,700 rpm,
# no alarms. Extrapolated, CPU fans cross the BMC's 1,500 rpm warning at ~9% and
# 1,200 rpm critical at ~6%. The UI warns below 30% and confirms Pin < 30%.
# Activating any other profile deletes MANUAL, so nothing is left behind.
#
# Per group (floor or pin): a fan runs at the MAX of every policy that lists it.
# Policies cannot be split into new fan lists: this BMC silently ignores a
# whole profile that contains a fan list the stock profile does not (tested
# on scc04, 2026-10-14: the profile stores and activates, but no fan moves).
# So each policy keeps its fans and its floor becomes the LOWEST target among
# the groups it drives (a group left blank counts at that policy's own
# floor). For pin, the policy's ceiling also becomes the lowest pinned target,
# so a policy shared with a blank group ramps only up to the pin. SYS has
# policies of its own, so it gets exactly its target; CPU fans only share a
# policy with SYS, so CPU can match or go below SYS but not above; EXT and
# REAR likewise against their partners. The resulting floor and ceiling of
# every group are computed and returned.
# The last stdout line is always "RESULT {json}".
import http.cookiejar
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

A = ARGS  # noqa: F821  (injected by node.html)
BASE_URL = "https://" + A["host"]
MANUAL = "MANUAL"
MIN_PCT = 0

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE
_opener = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=_ctx),
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
_csrf = None


def req(method, path, body=None, form=False):
    data, hdr = None, {}
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            hdr["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            hdr["Content-Type"] = "application/json"
    if _csrf:
        hdr["X-CSRFTOKEN"] = _csrf
    r = urllib.request.Request(BASE_URL + path, data=data, headers=hdr, method=method)
    try:
        with _opener.open(r, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def result(ok, msg, **kw):
    print("RESULT " + json.dumps(dict(ok=ok, msg=msg, **kw)))


def login():
    global _csrf
    last = ""
    # The BMC holds a small session table; tools that never log out fill it
    # ("Could not login", code 15000). Wait for a slot rather than failing.
    for _ in range(6):
        code, txt = req("POST", "/api/session",
                        {"username": A["user"], "password": A["pass"]}, form=True)
        try:
            tok = json.loads(txt).get("CSRFToken")
        except ValueError:
            tok = None
        if code == 200 and tok:
            _csrf = tok
            return
        last = txt.strip()[:120]
        time.sleep(5)
    raise RuntimeError("BMC login failed: " + last)


def logout():
    if _csrf:
        req("DELETE", "/api/session")


def profiles():
    code, txt = req("GET", "/api/settings/fanprofile/collection")
    if code != 200:
        raise RuntimeError("cannot read fan profiles (HTTP %s)" % code)
    return json.loads(txt)


def active():
    code, txt = req("GET", "/api/settings/fanprofile/mode")
    if code != 200:
        raise RuntimeError("cannot read active profile (HTTP %s)" % code)
    return json.loads(txt).get("strMode")


def activate(name):
    req("POST", "/api/settings/fanprofile/mode", {"strMode": name})
    now = active()
    if now != name:
        raise RuntimeError("activate %s did not take (active is %s)" % (name, now))


def set_duty(q, pct, kind):
    n = len(q.get("arrRef", [0, 0]))
    if kind == "pin":
        q["arrDuty"] = [pct] * n
    else:
        d = list(q["arrDuty"])
        d[0] = pct
        if len(d) == 2:
            d[1] = max(d[1], pct)
        q["arrDuty"] = d
    q["iInitDuty"] = pct


def fan_groups():
    """-> {fan sensor number: group}, e.g. 161 -> "SYS" for SYS_FAN1."""
    code, txt = req("GET", "/api/sensors")
    if code != 200:
        raise RuntimeError("cannot read the BMC sensor list (HTTP %s)" % code)
    out = {}
    for x in json.loads(txt):
        name = str(x.get("name", ""))
        if "_FAN" in name and isinstance(x.get("sensor_number"), int):
            out[x["sensor_number"]] = name.split("_FAN")[0]
    return out


def build_manual(base, pct, kind, groups=None, fanmap=None):
    p = json.loads(json.dumps(base))
    p["strName"] = MANUAL
    if groups is None:
        for q in p["arrPolicy"]:
            set_duty(q, pct, kind)
        return p
    for q in p["arrPolicy"]:
        gs = {fanmap.get(f, "?") for f in q.get("arrFanSensor", [])}
        targets = [groups[g] for g in gs if groups.get(g) is not None]
        if not targets:
            continue                    # touches no overridden group
        low = min(targets)
        blank = any(groups.get(g) is None for g in gs)
        d = list(q["arrDuty"])
        if kind == "pin" and not blank:
            d = [low] * len(d)
        elif kind == "pin":             # shared with a blank group: ramp only up to the pin
            d = [min(d[0], low)] + [low] * (len(d) - 1) if len(d) > 1 else [min(d[0], low)]
        else:
            d[0] = min(low, d[0]) if blank else low
            if len(d) == 2:
                d[1] = max(d[1], d[0])
        q["arrDuty"] = d
        q["iInitDuty"] = d[0]
    return p


def effective_range(prof, fanmap):
    """-> {group: [floor, ceiling]}: a fan runs at the max over its policies,
    so its floor is the max policy floor and its ceiling the max policy ceiling."""
    eff = {}
    for q in prof["arrPolicy"]:
        lo, hi = q["arrDuty"][0], q["arrDuty"][-1]
        for f in q.get("arrFanSensor", []):
            g = fanmap.get(f, "?")
            a, b = eff.get(g, (0, 0))
            eff[g] = [max(a, lo), max(b, hi)]
    return eff


def group_counts(fanmap):
    c = {}
    for g in fanmap.values():
        c[g] = c.get(g, 0) + 1
    return c


def op_status():
    cols = profiles()
    result(True, "ok", mode=active(), profiles=[p["strName"] for p in cols],
           fan_groups=group_counts(fan_groups()))


def op_activate():
    name = A.get("name")
    names = [p["strName"] for p in profiles()]
    if name not in names:
        raise RuntimeError("no profile named %r (have %s)" % (name, names))
    activate(name)
    cleaned = False
    if name != MANUAL and MANUAL in names:
        code, _ = req("DELETE", "/api/settings/fanprofile/collection/" + MANUAL)
        cleaned = code == 200
    result(True, "activated %s" % name, mode=active(),
           profiles=[p["strName"] for p in profiles()], removed_manual=cleaned)


def op_manual():
    kind = A.get("kind", "floor")
    base_name = A.get("base")
    if kind not in ("floor", "pin"):
        raise RuntimeError("kind must be floor or pin")
    groups, fanmap = A.get("groups"), None
    if groups is not None:
        fanmap = fan_groups()
        have = set(fanmap.values())
        groups = {str(g).upper(): (None if v is None else int(v)) for g, v in groups.items()}
        bad = [g for g in groups if g not in have]
        if bad:
            raise RuntimeError("no fan group %s on this node (have %s)" % (bad, sorted(have)))
        set_pcts = [v for v in groups.values() if v is not None]
        if not set_pcts:
            raise RuntimeError("set a duty for at least one fan group")
        if not all(MIN_PCT <= v <= 100 for v in set_pcts):
            raise RuntimeError("duty must be %d-100%%" % MIN_PCT)
        pct = min(set_pcts)
    else:
        pct = int(A.get("pct"))
        if not MIN_PCT <= pct <= 100:
            raise RuntimeError("duty must be %d-100%%" % MIN_PCT)
    cols = profiles()
    by = {p["strName"]: p for p in cols}
    if base_name == MANUAL or base_name not in by:
        raise RuntimeError("base profile %r not usable (have %s)" % (base_name, list(by)))
    was = active()
    prof = build_manual(by[base_name], pct, kind, groups, fanmap)
    if MANUAL in by:
        req("PUT", "/api/settings/fanprofile/collection/" + MANUAL, prof)
    else:
        req("POST", "/api/settings/fanprofile/collection", prof)
    # Verify by readback, not by status code: this firmware has answered a
    # successful create with HTTP 403.
    stored = {p["strName"]: p for p in profiles()}.get(MANUAL)
    if not stored or stored["arrPolicy"] != prof["arrPolicy"]:
        raise RuntimeError("MANUAL profile did not store correctly; nothing activated")
    try:
        activate(MANUAL)
    except Exception:
        activate(was)          # roll back to what was running
        raise
    verb = "pinned" if kind == "pin" else "floored"
    if groups is not None:
        what = ", ".join("%s %s" % (g, "profile" if v is None else "%d%%" % v)
                         for g, v in sorted(groups.items()))
        eff = effective_range(prof, fanmap)
        got = ", ".join("%s %s" % (g, "%d%%" % lo if lo == hi else
                                   ("%d-%d%%" % (lo, hi) if kind == "pin" else "floor %d%%" % lo))
                        for g, (lo, hi) in sorted(eff.items()) if g in groups)
        msg = "fans %s per group: asked %s -> now %s (base %s)" % (verb, what, got, base_name)
    else:
        msg = "fans %s at %d%% (base %s)" % (verb, pct, base_name)
    result(True, msg, mode=MANUAL, base=base_name, previous=was, pct=pct, kind=kind,
           groups=groups, ranges=effective_range(prof, fanmap) if groups is not None else None,
           profiles=[p["strName"] for p in profiles()])


try:
    login()
    try:
        {"status": op_status, "activate": op_activate, "manual": op_manual}[A["op"]]()
    finally:
        logout()
except Exception as e:  # noqa: BLE001 - reported to the UI, never swallowed
    result(False, str(e))
