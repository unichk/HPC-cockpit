#include "collector.h"

#include <fstream>

namespace {

class LoadCollector : public Collector {
 public:
  std::string Name() const override { return "load"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
    std::ifstream in("/proc/loadavg");
    if (!in.is_open()) {
      error = "failed to open /proc/loadavg";
      return false;
    }

    double load1 = 0.0;
    double load5 = 0.0;
    double load15 = 0.0;
    in >> load1 >> load5 >> load15;
    if (!in.good() && !in.eof()) {
      error = "invalid /proc/loadavg format";
      return false;
    }

    out.push_back(Metric{"load", "avg1", load1, "ratio"});
    out.push_back(Metric{"load", "avg5", load5, "ratio"});
    out.push_back(Metric{"load", "avg15", load15, "ratio"});
    return true;
  }
};

}  // namespace

CollectorPtr CreateLoadCollector() {
  return std::make_unique<LoadCollector>();
}
