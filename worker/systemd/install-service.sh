#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_BIN="${WORKER_DIR}/build/hpc_worker"
DEFAULT_CONFIG="${WORKER_DIR}/config/worker.conf"
SERVICE_SRC="${SCRIPT_DIR}/hpc-worker.service"

BIN_DST="/usr/local/bin/hpc_worker"
CONFIG_DIR="/etc/hpc-worker"
CONFIG_DST="${CONFIG_DIR}/worker.conf"
STATE_DIR="/var/lib/hpc-worker"
UNIT_DST="/etc/systemd/system/hpc-worker.service"

BIN_SRC="${DEFAULT_BIN}"
CONFIG_SRC="${DEFAULT_CONFIG}"
ENABLE=false
START=false
DRY_RUN=false

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --binary <path>       Source worker binary (default: ${DEFAULT_BIN})
  --config <path>       Source config file (default: ${DEFAULT_CONFIG})
  --enable              Run: systemctl enable hpc-worker
  --start               Run: systemctl start hpc-worker
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
    --binary)
      BIN_SRC="${2:-}"
      shift 2
      ;;
    --config)
      CONFIG_SRC="${2:-}"
      shift 2
      ;;
    --enable)
      ENABLE=true
      shift
      ;;
    --start)
      START=true
      shift
      ;;
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

if [[ ! -f "${SERVICE_SRC}" ]]; then
  echo "error: missing service unit template: ${SERVICE_SRC}"
  exit 2
fi

if [[ ! -x "${BIN_SRC}" ]]; then
  echo "error: worker binary not found or not executable: ${BIN_SRC}"
  exit 2
fi

if [[ ! -f "${CONFIG_SRC}" ]]; then
  echo "error: config file not found: ${CONFIG_SRC}"
  exit 2
fi

run_cmd mkdir -p "${CONFIG_DIR}" "${STATE_DIR}"
run_cmd install -m 0755 "${BIN_SRC}" "${BIN_DST}"
run_cmd install -m 0644 "${SERVICE_SRC}" "${UNIT_DST}"

if [[ -f "${CONFIG_DST}" ]]; then
  echo "config exists, leaving as-is: ${CONFIG_DST}"
else
  run_cmd install -m 0644 "${CONFIG_SRC}" "${CONFIG_DST}"
fi

run_cmd systemctl daemon-reload

if ${ENABLE}; then
  run_cmd systemctl enable hpc-worker
fi

if ${START}; then
  run_cmd systemctl start hpc-worker
fi

echo "service installed: ${UNIT_DST}"
echo "binary installed: ${BIN_DST}"
echo "config path: ${CONFIG_DST}"
echo "state dir: ${STATE_DIR}"
