#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
BIN_PATH="${BUILD_DIR}/hpc_worker"

mkdir -p "${BUILD_DIR}"

if command -v cmake >/dev/null 2>&1; then
  cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}"
  cmake --build "${BUILD_DIR}" -j
  echo "Built with cmake: ${BIN_PATH}"
  echo "Service installer: ${ROOT_DIR}/systemd/install-service.sh"
  exit 0
fi

echo "cmake not found, using g++ fallback"
g++ -std=c++17 -Wall -Wextra -Wpedantic \
  "${ROOT_DIR}/src/main.cpp" \
  "${ROOT_DIR}/src/config.cpp" \
  "${ROOT_DIR}/src/worker.cpp" \
  "${ROOT_DIR}/src/collector_registry.cpp" \
  "${ROOT_DIR}/src/transport_registry.cpp" \
  "${ROOT_DIR}/src/collectors/cpu_collector.cpp" \
  "${ROOT_DIR}/src/collectors/memory_collector.cpp" \
  "${ROOT_DIR}/src/collectors/load_collector.cpp" \
  "${ROOT_DIR}/src/collectors/thermal_collector.cpp" \
  "${ROOT_DIR}/src/collectors/power_collector.cpp" \
  "${ROOT_DIR}/src/collectors/fan_collector.cpp" \
  "${ROOT_DIR}/src/transports/stdout_transport.cpp" \
  "${ROOT_DIR}/src/transports/udp_transport.cpp" \
  -I"${ROOT_DIR}/src" \
  -o "${BIN_PATH}"

echo "Built with g++: ${BIN_PATH}"
echo "Service installer: ${ROOT_DIR}/systemd/install-service.sh"
