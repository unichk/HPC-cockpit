#pragma once

#include "types.h"

#include <memory>
#include <string>
#include <vector>

class Collector {
 public:
  virtual ~Collector() = default;
  virtual std::string Name() const = 0;
  virtual bool Collect(std::vector<Metric>& out, std::string& error) = 0;
};

using CollectorPtr = std::unique_ptr<Collector>;
