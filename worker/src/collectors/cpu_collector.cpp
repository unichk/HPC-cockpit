#include "collector.h"

#include <fstream>
#include <sstream>
#include <string>

namespace {

// Governor name <-> small integer code. The Metric wire format is numeric-only,
// so we encode the kernel's governor string as a code (0=unknown), and
// scaling_available_governors as a bitmask over the same codes.
// UI (live-data.js) maps back to the string name.
int GovernorCode(const std::string& name) {
  if (name == "performance")  return 1;
  if (name == "powersave")    return 2;
  if (name == "schedutil")    return 3;
  if (name == "ondemand")     return 4;
  if (name == "conservative") return 5;
  if (name == "userspace")    return 6;
  return 0;
}

bool ReadSysfsFirstToken(const std::string& path, std::string& out) {
  std::ifstream in(path);
  if (!in.is_open()) return false;
  in >> out;
  return !out.empty();
}

bool ReadSysfsLong(const std::string& path, long& out) {
  std::ifstream in(path);
  if (!in.is_open()) return false;
  in >> out;
  return !in.fail();
}

bool ReadSysfsLine(const std::string& path, std::string& out) {
  std::ifstream in(path);
  if (!in.is_open()) return false;
  std::getline(in, out);
  return !out.empty();
}

void CollectCpufreq(std::vector<Metric>& out) {
  const std::string base = "/sys/devices/system/cpu/cpu0/cpufreq/";

  // The "cap" is the current scaling_max_freq — what the governor is allowed
  // to run up to. We report that instead of scaling_cur_freq (instantaneous,
  // load-dependent) so the UI reflects the configured ceiling.
  long cap_khz = 0, min_khz = 0, max_khz = 0;
  const bool have_cap = ReadSysfsLong(base + "scaling_max_freq", cap_khz);
  const bool have_min = ReadSysfsLong(base + "cpuinfo_min_freq", min_khz);
  const bool have_max = ReadSysfsLong(base + "cpuinfo_max_freq", max_khz);

  if (have_cap) out.push_back(Metric{"cpu", "freq_cap_khz", static_cast<double>(cap_khz), "khz"});
  if (have_min) out.push_back(Metric{"cpu", "freq_min_khz", static_cast<double>(min_khz), "khz"});
  if (have_max) out.push_back(Metric{"cpu", "freq_max_khz", static_cast<double>(max_khz), "khz"});

  std::string gov;
  if (ReadSysfsFirstToken(base + "scaling_governor", gov)) {
    out.push_back(Metric{"cpu", "governor_code", static_cast<double>(GovernorCode(gov)), "enum"});
  }

  std::string avail;
  if (ReadSysfsLine(base + "scaling_available_governors", avail)) {
    int mask = 0;
    std::istringstream iss(avail);
    std::string tok;
    while (iss >> tok) {
      const int code = GovernorCode(tok);
      if (code > 0) mask |= (1 << (code - 1));
    }
    out.push_back(Metric{"cpu", "governors_mask", static_cast<double>(mask), "bitmask"});
  }
}

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

    // cpufreq state is independent of the prev-sample usage calc, always emit.
    CollectCpufreq(out);

    if (!has_prev_) {
      prev_total_ = total;
      prev_idle_ = idle_all;
      has_prev_ = true;
      return true;
    }

    const unsigned long long total_delta = total - prev_total_;
    const unsigned long long idle_delta = idle_all - prev_idle_;
    prev_total_ = total;
    prev_idle_ = idle_all;

    if (total_delta == 0) {
      return true;
    }

    const double usage_pct = 100.0 * static_cast<double>(total_delta - idle_delta) /
                             static_cast<double>(total_delta);
    out.push_back(Metric{"cpu", "usage", usage_pct, "percent"});
    return true;
  }

 private:
  bool has_prev_ = false;
  unsigned long long prev_total_ = 0;
  unsigned long long prev_idle_ = 0;
};

}  // namespace

CollectorPtr CreateCpuCollector() {
  return std::make_unique<CpuCollector>();
}
