#include "collector_registry.h"

#include <algorithm>
#include <memory>

CollectorPtr CreateCpuCollector();
CollectorPtr CreateMemoryCollector();
CollectorPtr CreateLoadCollector();
CollectorPtr CreateThermalCollector();
CollectorPtr CreatePowerCollector(const WorkerConfig& config);
CollectorPtr CreateFanCollector();
CollectorPtr CreateGpuCollector();
CollectorPtr CreateHealthCollector();

CollectorPtr CreateCollector(const std::string& name, const WorkerConfig& config) {
  if (name == "cpu") {
    return CreateCpuCollector();
  }
  if (name == "memory") {
    return CreateMemoryCollector();
  }
  if (name == "load") {
    return CreateLoadCollector();
  }
  if (name == "thermal") {
    return CreateThermalCollector();
  }
  if (name == "power") {
    return CreatePowerCollector(config);
  }
  if (name == "fan") {
    return CreateFanCollector();
  }
  if (name == "gpu") {
    return CreateGpuCollector();
  }
  if (name == "health") {
    return CreateHealthCollector();
  }
  return nullptr;
}

std::vector<std::string> BuiltinCollectors() {
  return {"cpu", "memory", "load", "thermal", "power", "fan", "gpu", "health"};
}
