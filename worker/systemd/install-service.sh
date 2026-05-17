#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_BIN="${WORKER_DIR}/build/hpc_worker"
DEFAULT_CONFIG="${WORKER_DIR}/config/worker.conf"
SERVICE_SRC="${SCRIPT_DIR}/hpc-worker.service"
BUILD_SCRIPT="${WORKER_DIR}/build.sh"

BIN_DST="/usr/local/bin/hpc_worker"
CONFIG_DIR="/etc/hpc-worker"
CONFIG_DST="${CONFIG_DIR}/worker.conf"
STATE_DIR="/var/lib/hpc-worker"
UNIT_DST="/etc/systemd/system/hpc-worker.service"

BIN_SRC="${DEFAULT_BIN}"
CONFIG_SRC="${DEFAULT_CONFIG}"
ENABLE=true
START=true
DRY_RUN=false
SKIP_BUILD=false
CLEAN_REINSTALL=true

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --binary <path>       Source worker binary (default: ${DEFAULT_BIN})
  --config <path>       Source config file (default: ${DEFAULT_CONFIG})
  --clean-reinstall     Purge old install before install (default: enabled)
  --no-clean-reinstall  Keep old config/state during install
  --skip-build          Skip rebuild step before install
  --enable              Enable service after install (default: enabled)
  --start               Start service after install (default: started)
  --no-enable           Do not enable service after install
  --no-start            Do not start service after install
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

# Validate that a binary on disk is actually a usable worker binary. We saw an
# incident where build.sh exited 0 but left a 0-byte file at build/hpc_worker;
# the previous installer happily copied it over /usr/local/bin/hpc_worker
# (which had been deleted by clean-reinstall a moment earlier), leaving the
# service permanently in 203/EXEC restart-loop. Three layers of check:
#   1. file exists (-f)
#   2. file is non-empty (-s) — catches truncated/interrupted linker output
#   3. file is an ELF executable — catches scripts/text/wrong-arch copies
# Caller is expected to abort on non-zero return.
validate_binary() {
  local path="$1" label="${2:-binary}"
  if [[ ! -f "$path" ]]; then
    echo "error: ${label} not found: $path" >&2
    return 1
  fi
  if [[ ! -s "$path" ]]; then
    echo "error: ${label} is empty (0 bytes): $path" >&2
    echo "       this usually means a stale CMake cache; rerun:" >&2
    echo "         rm -rf '$(dirname "$path")' && '${BUILD_SCRIPT}'" >&2
    return 1
  fi
  if ! file -b "$path" 2>/dev/null | grep -q 'ELF.*executable'; then
    echo "error: ${label} at $path is not a valid ELF executable" >&2
    file -b "$path" >&2 || true
    return 1
  fi
  if [[ ! -x "$path" ]]; then
    echo "error: ${label} at $path is not marked executable" >&2
    return 1
  fi
}

refresh_ipmi_cache() {
  local cache_dir="/root/.freeipmi/sdr-cache"
  if ${DRY_RUN}; then
    echo "[dry-run] rm -rf ${cache_dir}"
    echo "[dry-run] ipmi-sensors --sensor-type=Fan >/dev/null 2>&1 || true"
    return
  fi

  rm -rf "${cache_dir}"
  if command -v ipmi-sensors >/dev/null 2>&1; then
    ipmi-sensors --sensor-type=Fan >/dev/null 2>&1 || true
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
    --clean-reinstall)
      CLEAN_REINSTALL=true
      shift
      ;;
    --no-clean-reinstall)
      CLEAN_REINSTALL=false
      shift
      ;;
    --no-enable)
      ENABLE=false
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --start)
      START=true
      shift
      ;;
    --no-start)
      START=false
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

if ! ${SKIP_BUILD}; then
  if [[ ! -x "${BUILD_SCRIPT}" ]]; then
    echo "error: build script not found or not executable: ${BUILD_SCRIPT}"
    exit 2
  fi
  if ${DRY_RUN}; then
    echo "[dry-run] ${BUILD_SCRIPT}"
  else
    "${BUILD_SCRIPT}"
  fi
fi

# Validate the source binary BEFORE doing anything destructive. If the binary
# is bad we want to abort while the current install is still working — never
# stop/remove the running service until we know the replacement is usable.
if ! ${DRY_RUN}; then
  validate_binary "${BIN_SRC}" "source worker binary" || exit 2
fi

if [[ ! -f "${CONFIG_SRC}" ]]; then
  echo "error: config file not found: ${CONFIG_SRC}"
  exit 2
fi

if ${CLEAN_REINSTALL}; then
  if run_cmd systemctl is-active hpc-worker >/dev/null 2>&1; then
    run_cmd systemctl stop hpc-worker
  fi
  if run_cmd systemctl is-enabled hpc-worker >/dev/null 2>&1; then
    run_cmd systemctl disable hpc-worker
  fi
  if [[ -f "${UNIT_DST}" ]]; then
    run_cmd rm -f "${UNIT_DST}"
  fi
  if [[ -f "${BIN_DST}" ]]; then
    run_cmd rm -f "${BIN_DST}"
  fi
  run_cmd rm -rf "${CONFIG_DIR}" "${STATE_DIR}"
  run_cmd systemctl daemon-reload
fi

run_cmd mkdir -p "${CONFIG_DIR}" "${STATE_DIR}"
# Two-step atomic binary install: write the new file to a sibling .new path
# (same filesystem, so rename is atomic), validate it, then mv into place.
# This means a partial copy or a fault between bytes never leaves the system
# with a half-written /usr/local/bin/hpc_worker.
if ${DRY_RUN}; then
  echo "[dry-run] install -m 0755 ${BIN_SRC} ${BIN_DST}.new && mv ${BIN_DST}.new ${BIN_DST}"
else
  install -m 0755 "${BIN_SRC}" "${BIN_DST}.new"
  validate_binary "${BIN_DST}.new" "newly-installed worker binary" || {
    rm -f "${BIN_DST}.new"
    echo "error: post-copy validation failed; leaving ${BIN_DST} untouched" >&2
    exit 3
  }
  mv -f "${BIN_DST}.new" "${BIN_DST}"
fi
run_cmd install -m 0644 "${SERVICE_SRC}" "${UNIT_DST}"
run_cmd install -m 0644 "${CONFIG_SRC}" "${CONFIG_DST}"
refresh_ipmi_cache

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
if ${CLEAN_REINSTALL}; then
  echo "install mode: clean reinstall (old config/state purged)"
else
  echo "install mode: in-place install (config/state preserved)"
fi
