#include "collector_registry.h"

#include <algorithm>
#include <memory>

CollectorPtr CreateCpuCollector();
CollectorPtr CreateMemoryCollector();
CollectorPtr CreateLoadCollector();
CollectorPtr CreateThermalCollector();
CollectorPtr CreatePowerCollector();
CollectorPtr CreateFanCollector();

CollectorPtr CreateCollector(const std::string& name) {
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
    return CreatePowerCollector();
  }
  if (name == "fan") {
    return CreateFanCollector();
  }
  return nullptr;
}

std::vector<std::string> BuiltinCollectors() {
  return {"cpu", "memory", "load", "thermal", "power", "fan"};
}
