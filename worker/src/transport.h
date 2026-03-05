#pragma once

#include "types.h"

#include <memory>
#include <string>

class Transport {
 public:
  virtual ~Transport() = default;
  virtual std::string Name() const = 0;
  virtual bool Send(const Snapshot& snapshot, std::string& error) = 0;
};

using TransportPtr = std::unique_ptr<Transport>;
