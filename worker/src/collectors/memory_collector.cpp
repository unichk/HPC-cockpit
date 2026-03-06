#include "collector.h"

#include <fstream>
#include <string>

namespace {

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

    return true;
  }
};

}  // namespace

CollectorPtr CreateMemoryCollector() {
  return std::make_unique<MemoryCollector>();
}
