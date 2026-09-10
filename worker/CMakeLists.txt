cmake_minimum_required(VERSION 3.16)
project(hpc_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(hpc_worker
  src/main.cpp
  src/config.cpp
  src/worker.cpp
  src/command_server.cpp
  src/collector_registry.cpp
  src/transport_registry.cpp
  src/collectors/cpu_collector.cpp
  src/collectors/memory_collector.cpp
  src/collectors/load_collector.cpp
  src/collectors/thermal_collector.cpp
  src/collectors/power_collector.cpp
  src/collectors/fan_collector.cpp
  src/collectors/gpu_collector.cpp
  src/transports/stdout_transport.cpp
  src/transports/udp_transport.cpp
)

find_package(ZLIB REQUIRED)
target_link_libraries(hpc_worker PRIVATE ZLIB::ZLIB)

target_include_directories(hpc_worker PRIVATE src)
target_compile_options(hpc_worker PRIVATE -Wall -Wextra -Wpedantic -pthread)
target_link_options(hpc_worker PRIVATE -pthread)
