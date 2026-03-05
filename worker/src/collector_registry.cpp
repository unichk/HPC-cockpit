#include "collector_registry.h"

#include <algorithm>
#include <memory>

CollectorPtr CreateCpuCollector();
CollectorPtr CreateMemoryCollector();
CollectorPtr CreateLoadCollector();

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
  return nullptr;
}

std::vector<std::string> BuiltinCollectors() {
  return {"cpu", "memory", "load"};
}
