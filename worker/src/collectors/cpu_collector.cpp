#include "collector.h"

#include <fstream>
#include <sstream>

namespace {

class CpuCollector : public Collector {
 public:
  std::string Name() const override { return "cpu"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
    std::ifstream in("/proc/stat");
    if (!in.is_open()) {
      error = "failed to open /proc/stat";
      return false;
    }

    std::string label;
    unsigned long long user = 0;
    unsigned long long nice = 0;
    unsigned long long system = 0;
    unsigned long long idle = 0;
    unsigned long long iowait = 0;
    unsigned long long irq = 0;
    unsigned long long softirq = 0;
    unsigned long long steal = 0;

    in >> label >> user >> nice >> system >> idle >> iowait >> irq >> softirq >> steal;
    if (label != "cpu") {
      error = "unexpected /proc/stat format";
      return false;
    }

    const unsigned long long idle_all = idle + iowait;
    const unsigned long long non_idle = user + nice + system + irq + softirq + steal;
    const unsigned long long total = idle_all + non_idle;

    if (!has_prev_) {
      prev_total_ = total;
      prev_idle_ = idle_all;
      prev_iowait_ = iowait;
      has_prev_ = true;
      return true;
    }

    const unsigned long long total_delta = total - prev_total_;
    const unsigned long long idle_delta = idle_all - prev_idle_;
    const unsigned long long iowait_delta = iowait - prev_iowait_;
    prev_total_ = total;
    prev_idle_ = idle_all;
    prev_iowait_ = iowait;

    if (total_delta == 0) {
      return true;
    }

    const double usage_pct = 100.0 * static_cast<double>(total_delta - idle_delta) /
                             static_cast<double>(total_delta);
    out.push_back(Metric{"cpu", "usage", usage_pct, "percent"});
    out.push_back(Metric{"cpu", "iowait", 100.0 * static_cast<double>(iowait_delta) /
                                      static_cast<double>(total_delta),
                         "percent"});
    return true;
  }

 private:
  bool has_prev_ = false;
  unsigned long long prev_total_ = 0;
  unsigned long long prev_idle_ = 0;
  unsigned long long prev_iowait_ = 0;
};

}  // namespace

CollectorPtr CreateCpuCollector() {
  return std::make_unique<CpuCollector>();
}
