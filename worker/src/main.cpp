#include "collector_registry.h"
#include "command_server.h"
#include "config.h"
#include "transport_registry.h"
#include "worker.h"

#include <sys/mman.h>

#include <cerrno>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

int main(int argc, char** argv) {
  std::string config_path = "config/worker.conf";
  if (argc > 1) {
    config_path = argv[1];
  }

  WorkerConfig config;
  std::string config_error;
  if (!LoadConfig(config_path, config, config_error)) {
    std::cerr << "config_error " << config_error << "\n";
    return 1;
  }

  // Pin all worker pages so we stay responsive when the machine is under
  // heavy memory pressure. Non-fatal if it fails (e.g. no CAP_IPC_LOCK).
  if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
    std::cout << "mlockall_failed errno=" << errno << " (" << std::strerror(errno)
              << ") — running with pages swappable" << std::endl;
  } else {
    std::cout << "mlockall_ok" << std::endl;
  }

  std::string transport_error;
  auto transport = CreateTransport(config, transport_error);
  if (!transport) {
    std::cerr << "transport_error " << transport_error << "\n";
    return 1;
  }

  std::vector<CollectorPtr> collectors;
  collectors.reserve(config.modules.size());
  for (const auto& module_name : config.modules) {
    auto collector = CreateCollector(module_name, config);
    if (!collector) {
      std::cerr << "unknown module: " << module_name << "\n";
      return 1;
    }
    collectors.push_back(std::move(collector));
  }

  CommandServer command_server;
  if (config.exec_enabled) {
    std::string cmd_err;
    if (!command_server.Start(config, cmd_err)) {
      std::cout << "command_server_start_failed " << cmd_err << std::endl;
    } else {
      std::cout << "command_server_listen port=" << config.exec_port << std::endl;
    }
  }

  if (config.transport == "udp") {
    std::cout << "transport_start udp destination=" << config.transport_udp_host << ":"
              << config.transport_udp_port << std::endl;
  } else {
    std::cout << "transport_start " << config.transport << std::endl;
  }

  Worker worker(std::move(config), std::move(collectors), std::move(transport));
  int rc = worker.Run();
  command_server.Stop();
  return rc;
}
