#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

struct Metric {
  Metric() = default;
  Metric(std::string module_, std::string name_, double value_, std::string unit_,
         std::string text_ = "")
      : module(std::move(module_)),
        name(std::move(name_)),
        value(value_),
        unit(std::move(unit_)),
        text(std::move(text_)) {}

  std::string module;
  std::string name;
  double value = 0.0;
  std::string unit;
  // Optional human-readable detail, e.g. "/mnt/home 93% used". Sent only when
  // non-empty; the health module uses it for the status wall's drill-down.
  std::string text;
};

struct Snapshot {
  std::string node_id;
  std::int64_t timestamp_ms;
  std::vector<Metric> metrics;
};
