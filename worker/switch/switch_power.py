#!/usr/bin/env python3
"""Poll the InfiniBand switch's power draw and send it to the cockpit.

The switch is not a node: it is reported as an auxiliary power source, so it
adds to the dashboard's Total Power and appears in /metrics as
cockpit_aux_power_watts{source="ib-qm8700"}, and nothing else.

It runs a CLI command on the switch over ssh (key-based login, BatchMode, so
no password is ever stored or passed on a command line) and takes the first
number matched by --regex. Check the parse once by hand before running it as
a service:

    ./switch_power.py --once --dry-run

Standard library + the system ssh client only.
"""
import argparse
import json
import re
import socket
import subprocess
import sys
import time


# The switch's SSH server only offers legacy algorithms, which current
# OpenSSH clients disable by default.
LEGACY_SSH = ["KexAlgorithms=+diffie-hellman-group14-sha1", "HostKeyAlgorithms=+ssh-rsa",
              "PubkeyAcceptedAlgorithms=+ssh-rsa"]


def read_watts(target, command, pattern, timeout, ssh_opts):
    opts = [x for o in ssh_opts for x in ("-o", o)]
    p = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={timeout}", *opts, target, command],
        capture_output=True, text=True, timeout=timeout + 15)
    if "UNIX shell commands cannot be executed" in p.stdout + p.stderr:
        raise RuntimeError(f"switch refused {command!r} as a shell command; use cli -h")
    if p.returncode != 0:
        raise RuntimeError(f"ssh exit {p.returncode}: {(p.stderr or p.stdout).strip()[:200]}")
    m = re.search(pattern, p.stdout, re.IGNORECASE | re.MULTILINE)
    if not m:
        raise RuntimeError(f"no match for {pattern!r} in:\n{p.stdout.strip()[:800]}")
    return float(m.group(1)), p.stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    # Hostnames, not IPs: their addresses live in /etc/hosts, the one place to
    # change when the cluster is renumbered (e.g. at the competition venue).
    ap.add_argument("--switch", default="admin@ib-switch", help="ssh target (default: admin@ib-switch)")
    ap.add_argument("--ssh-option", action="append", default=None, metavar="OPT",
                    help="extra ssh -o option (repeatable); replaces the legacy defaults")
    ap.add_argument("--source", default="ib-qm8700", help="name shown in the cockpit")
    # MLNX-OS refuses a plain remote command ("UNIX shell commands cannot be
    # executed using this account"); its `cli -h` runs CLI commands in batch.
    # The string reaches the switch CLI unparsed by any shell: double quotes
    # only (single quotes arrive literally: % Unrecognized command "'enable").
    ap.add_argument("--command", default='cli -h "enable" "show power"',
                    help="remote command whose output contains the total watts")
    ap.add_argument("--regex", default=r"total\s+power\s+used\D*?([\d.]+)",
                    help="regex; group 1 = watts (verify against your firmware's output)")
    ap.add_argument("--cockpit", default="ntu-scc04:9000", help="cockpit UDP host:port (default: ntu-scc04:9000)")
    ap.add_argument("--interval", type=float, default=10.0, help="seconds between polls")
    ap.add_argument("--once", action="store_true", help="poll once and exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the switch output and parsed watts; send nothing")
    a = ap.parse_args()

    host, port = a.cockpit.rsplit(":", 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    failures = 0
    while True:
        t0 = time.monotonic()
        try:
            watts, raw = read_watts(a.switch, a.command, a.regex, timeout=10,
                                    ssh_opts=a.ssh_option or LEGACY_SSH)
            failures = 0
            if a.dry_run:
                print(raw.rstrip())
                print(f"--> parsed {watts} W for source {a.source!r} (dry run, nothing sent)")
            else:
                msg = {"kind": "aux_power", "source": a.source, "watts": watts,
                       "timestamp_ms": int(time.time() * 1000)}
                sock.sendto(json.dumps(msg).encode(), (host, int(port)))
        except Exception as e:  # noqa: BLE001 - keep polling; the cockpit drops stale values
            failures += 1
            if failures <= 3 or failures % 60 == 0:
                print(f"poll failed ({failures}): {e}", file=sys.stderr, flush=True)
            if a.once:
                sys.exit(1)
        if a.once:
            return
        time.sleep(max(0.0, a.interval - (time.monotonic() - t0)))


if __name__ == "__main__":
    main()
