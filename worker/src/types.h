#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct Metric {
  std::string module;
  std::string name;
  double value;
  std::string unit;
};

struct Snapshot {
  std::string node_id;
  std::int64_t timestamp_ms;
  std::vector<Metric> metrics;
};
