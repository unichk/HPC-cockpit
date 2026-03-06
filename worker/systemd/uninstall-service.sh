#!/usr/bin/env bash
set -euo pipefail

BIN_DST="/usr/local/bin/hpc_worker"
CONFIG_DIR="/etc/hpc-worker"
STATE_DIR="/var/lib/hpc-worker"
UNIT_DST="/etc/systemd/system/hpc-worker.service"

DRY_RUN=false

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --dry-run             Print actions without changing system files
  -h, --help            Show this help
EOF
}

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "error: must run as root"
    exit 2
  fi
}

run_cmd() {
  if ${DRY_RUN}; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

need_root

if run_cmd systemctl is-enabled hpc-worker >/dev/null 2>&1; then
  run_cmd systemctl disable hpc-worker
fi

if run_cmd systemctl is-active hpc-worker >/dev/null 2>&1; then
  run_cmd systemctl stop hpc-worker
fi

if [[ -f "${UNIT_DST}" ]]; then
  run_cmd rm -f "${UNIT_DST}"
fi

run_cmd systemctl daemon-reload

if [[ -f "${BIN_DST}" ]]; then
  run_cmd rm -f "${BIN_DST}"
fi

run_cmd rm -rf "${CONFIG_DIR}" "${STATE_DIR}"

echo "service uninstalled: ${UNIT_DST}"
echo "purged: ${CONFIG_DIR} ${STATE_DIR}"
