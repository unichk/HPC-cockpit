#include "collector_registry.h"
#include "config.h"
#include "transport_registry.h"
#include "worker.h"

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

  auto transport = CreateTransport(config.transport);
  if (!transport) {
    std::cerr << "unknown transport: " << config.transport << "\n";
    return 1;
  }

  std::vector<CollectorPtr> collectors;
  collectors.reserve(config.modules.size());
  for (const auto& module_name : config.modules) {
    auto collector = CreateCollector(module_name);
    if (!collector) {
      std::cerr << "unknown module: " << module_name << "\n";
      return 1;
    }
    collectors.push_back(std::move(collector));
  }

  Worker worker(std::move(config), std::move(collectors), std::move(transport));
  return worker.Run();
}
