#pragma once

#include "collector.h"
#include "config.h"
#include "transport.h"

#include <vector>

class Worker {
 public:
  Worker(WorkerConfig config, std::vector<CollectorPtr> collectors, TransportPtr transport);
  int Run();

 private:
  WorkerConfig config_;
  std::vector<CollectorPtr> collectors_;
  TransportPtr transport_;
};
