#include "collector.h"

#include <array>
#include <vector>
#include <cstdio>
#include <fstream>
#include <regex>
#include <string>

namespace {

// Total DIMM power, summed from AMD's E-SMI per-DIMM telemetry.
//
// e_smi_tool takes a socket and an encoded DIMM address, and the encoding is
// not documented in --help. Determined empirically on a dual EPYC 9965:
// addresses below 0x20 are rejected, and the valid space is 8 high-nibble
// groups x 12 low nibbles = 96 per socket -- far more than the 12 DIMMs a
// socket actually has. The low nibble is the memory channel (12 per socket,
// matching the CPU's channel count); the high-nibble groups alias onto that
// same set, verified by every group returning a consistent per-DIMM average
// (0x20 -> 64.6 W, 0x30 -> 62.5 W for socket 0).
//
// So one group of 12 is read per socket. Summing all 96 instead would
// over-count by ~8x and report ~28 W per DDR5 RDIMM, which is impossible.
//
// 24 invocations cost ~160 ms, against a default 5 s interval.
constexpr int kDimmAddrBase = 0x20;
constexpr int kDimmChannels[] = {0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13};
constexpr int kMaxSockets = 8;

bool ReadDimmWatts(int socket, int addr, double& watts) {
  char command[160];
  std::snprintf(command, sizeof(command),
                "timeout 3s e_smi_tool --showdimmpower %d %d 2>/dev/null", socket, addr);
  std::array<char, 2048> buffer{};
  std::string payload;
  FILE* pipe = popen(command, "r");
  if (pipe == nullptr) {
    return false;
  }
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    payload.append(buffer.data());
  }
  if (pclose(pipe) != 0 || payload.empty()) {
    return false;
  }
  static const std::regex power_row(R"(Power\(Watts\)\s*\|\s*([0-9]+(?:\.[0-9]+)?))");
  std::smatch match;
  if (!std::regex_search(payload, match, power_row)) {
    return false;
  }
  try {
    watts = std::stod(match[1].str());
  } catch (...) {
    return false;
  }
  return true;
}

void CollectDimmPower(std::vector<Metric>& out, int socket_count) {
  double total = 0.0;
  int counted = 0;
  for (int socket = 0; socket < socket_count; ++socket) {
    for (const int channel : kDimmChannels) {
      double watts = 0.0;
      if (ReadDimmWatts(socket, kDimmAddrBase + channel, watts)) {
        total += watts;
        ++counted;
      }
    }
  }
  if (counted == 0) {
    return;
  }
  out.push_back(Metric{"memory", "dimm_power_w", total, "watt"});
  out.push_back(Metric{"memory", "dimm_count", static_cast<double>(counted), "count"});
}

class MemoryCollector : public Collector {
 public:
  std::string Name() const override { return "memory"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
    std::ifstream in("/proc/meminfo");
    if (!in.is_open()) {
      error = "failed to open /proc/meminfo";
      return false;
    }

    long long mem_total_kb = -1;
    long long mem_available_kb = -1;
    long long swap_total_kb = -1;
    long long swap_free_kb = -1;

    std::string key;
    long long value = 0;
    std::string unit;
    while (in >> key >> value >> unit) {
      if (key == "MemTotal:") {
        mem_total_kb = value;
      } else if (key == "MemAvailable:") {
        mem_available_kb = value;
      } else if (key == "SwapTotal:") {
        swap_total_kb = value;
      } else if (key == "SwapFree:") {
        swap_free_kb = value;
      }
    }

    if (mem_total_kb <= 0 || mem_available_kb < 0) {
      error = "required memory fields missing";
      return false;
    }

    const long long mem_used_kb = mem_total_kb - mem_available_kb;
    const double mem_used_pct = 100.0 * static_cast<double>(mem_used_kb) / static_cast<double>(mem_total_kb);
    out.push_back(Metric{"memory", "used", static_cast<double>(mem_used_kb), "kb"});
    out.push_back(Metric{"memory", "total", static_cast<double>(mem_total_kb), "kb"});
    out.push_back(Metric{"memory", "used_pct", mem_used_pct, "percent"});

    const long long swap_used_kb = (swap_total_kb > 0 && swap_free_kb >= 0)
                                       ? (swap_total_kb - swap_free_kb)
                                       : 0;
    const long long safe_swap_total_kb = swap_total_kb > 0 ? swap_total_kb : 0;
    out.push_back(Metric{"memory", "swap_used", static_cast<double>(swap_used_kb), "kb"});
    out.push_back(Metric{"memory", "swap_total", static_cast<double>(safe_swap_total_kb), "kb"});

    // Socket count is discovered once: probing a socket that does not exist
    // just fails, but there is no point paying for the attempt every tick.
    if (socket_count_ < 0) {
      socket_count_ = 0;
      for (int socket = 0; socket < kMaxSockets; ++socket) {
        double watts = 0.0;
        if (!ReadDimmWatts(socket, kDimmAddrBase, watts)) {
          break;
        }
        socket_count_ = socket + 1;
      }
    }
    if (socket_count_ > 0) {
      CollectDimmPower(out, socket_count_);
    }

    return true;
  }

 private:
  int socket_count_ = -1;
};

}  // namespace

CollectorPtr CreateMemoryCollector() {
  return std::make_unique<MemoryCollector>();
}
