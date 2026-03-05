#include "worker.h"

#include "types.h"

#include <chrono>
#include <cstdint>
#include <iostream>
#include <thread>

namespace {

std::int64_t NowMs() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

}  // namespace

Worker::Worker(WorkerConfig config, std::vector<CollectorPtr> collectors, TransportPtr transport)
    : config_(std::move(config)), collectors_(std::move(collectors)), transport_(std::move(transport)) {}

int Worker::Run() {
  auto next_tick = std::chrono::steady_clock::now();
  while (true) {
    next_tick += std::chrono::milliseconds(config_.interval_ms);

    Snapshot snapshot;
    snapshot.node_id = config_.node_id;
    snapshot.timestamp_ms = NowMs();

    for (auto& collector : collectors_) {
      std::string collect_error;
      if (!collector->Collect(snapshot.metrics, collect_error)) {
        std::cerr << "collector_error module=" << collector->Name() << " msg=" << collect_error << "\n";
      }
    }

    std::string send_error;
    if (!transport_->Send(snapshot, send_error)) {
      std::cerr << "transport_error transport=" << transport_->Name() << " msg=" << send_error << "\n";
    }

    std::this_thread::sleep_until(next_tick);
  }
}
