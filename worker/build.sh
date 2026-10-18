#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
BIN_PATH="${BUILD_DIR}/hpc_worker"

# Post-build sanity check. CMake's incremental cache occasionally believes a
# stale 0-byte linker output is up-to-date — `cmake --build` exits 0 but the
# artifact is unusable. The installer relies on this script's exit code as
# the gate for replacing the systemd binary, so a silent zero-byte build
# becomes a deploy-time outage. Catch that here.
verify_binary() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "error: build did not produce ${path}" >&2
    return 1
  fi
  if [[ ! -s "$path" ]]; then
    echo "error: build produced an empty (0-byte) binary at ${path}" >&2
    echo "       wipe the build dir and retry: rm -rf '${BUILD_DIR}' && '${BASH_SOURCE[0]}'" >&2
    return 1
  fi
  if ! file -b "$path" 2>/dev/null | grep -q 'ELF.*executable'; then
    echo "error: ${path} is not a valid ELF executable" >&2
    file -b "$path" >&2 || true
    return 1
  fi
}

mkdir -p "${BUILD_DIR}"

if command -v cmake >/dev/null 2>&1; then
  cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}"
  cmake --build "${BUILD_DIR}" -j
  verify_binary "${BIN_PATH}"
  echo "Built with cmake: ${BIN_PATH}"
  echo "Service installer: ${ROOT_DIR}/systemd/install-service.sh"
  exit 0
fi

echo "cmake not found, using g++ fallback"
g++ -std=c++17 -Wall -Wextra -Wpedantic \
  "${ROOT_DIR}/src/main.cpp" \
  "${ROOT_DIR}/src/config.cpp" \
  "${ROOT_DIR}/src/worker.cpp" \
  "${ROOT_DIR}/src/command_server.cpp" \
  "${ROOT_DIR}/src/collector_registry.cpp" \
  "${ROOT_DIR}/src/transport_registry.cpp" \
  "${ROOT_DIR}/src/collectors/cpu_collector.cpp" \
  "${ROOT_DIR}/src/collectors/memory_collector.cpp" \
  "${ROOT_DIR}/src/collectors/load_collector.cpp" \
  "${ROOT_DIR}/src/collectors/thermal_collector.cpp" \
  "${ROOT_DIR}/src/collectors/power_collector.cpp" \
  "${ROOT_DIR}/src/collectors/fan_collector.cpp" \
  "${ROOT_DIR}/src/collectors/gpu_collector.cpp" \
  "${ROOT_DIR}/src/collectors/health_collector.cpp" \
  "${ROOT_DIR}/src/transports/stdout_transport.cpp" \
  "${ROOT_DIR}/src/transports/udp_transport.cpp" \
  -I"${ROOT_DIR}/src" \
  -pthread \
  -lz \
  -o "${BIN_PATH}"

verify_binary "${BIN_PATH}"
echo "Built with g++: ${BIN_PATH}"
echo "Service installer: ${ROOT_DIR}/systemd/install-service.sh"
