#include "collector.h"

#include <dirent.h>

#include <array>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

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
  long cap_khz = 0, min_khz = 0, max_khz = 0, bios_khz = 0;
  const bool have_cap = ReadSysfsLong(base + "scaling_max_freq", cap_khz);
  const bool have_min = ReadSysfsLong(base + "cpuinfo_min_freq", min_khz);
  const bool have_max = ReadSysfsLong(base + "cpuinfo_max_freq", max_khz);
  // bios_limit reflects firmware/BMC-imposed clamps that the kernel honors
  // when writing scaling_max_freq. On HPC nodes it's often well below
  // cpuinfo_max_freq (e.g. base clock with boost disabled in BIOS), and
  // attempts to scale above it get silently clipped. The UI uses this to
  // bound the freq-control input and to label clamps clearly.
  const bool have_bios = ReadSysfsLong(base + "bios_limit", bios_khz);

  if (have_cap) out.push_back(Metric{"cpu", "freq_cap_khz", static_cast<double>(cap_khz), "khz"});
  if (have_min) out.push_back(Metric{"cpu", "freq_min_khz", static_cast<double>(min_khz), "khz"});
  if (have_max) out.push_back(Metric{"cpu", "freq_max_khz", static_cast<double>(max_khz), "khz"});
  if (have_bios) out.push_back(Metric{"cpu", "freq_bios_limit_khz", static_cast<double>(bios_khz), "khz"});

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

// Walk /sys/devices/system/cpu/ once to count total logical CPUs (cpuN dirs)
// and how many are currently online. cpu0 has no `online` file on most kernels
// — it's always online, so absence counts as 1.
void CollectCores(std::vector<Metric>& out) {
  DIR* dir = opendir("/sys/devices/system/cpu");
  if (!dir) return;

  int total = 0;
  int online = 0;
  struct dirent* ent;
  while ((ent = readdir(dir)) != nullptr) {
    const std::string name = ent->d_name;
    if (name.size() < 4 || name.compare(0, 3, "cpu") != 0) continue;
    bool all_digits = true;
    for (size_t i = 3; i < name.size(); ++i) {
      if (!std::isdigit(static_cast<unsigned char>(name[i]))) {
        all_digits = false;
        break;
      }
    }
    if (!all_digits) continue;

    ++total;
    long online_val = 1;
    if (!ReadSysfsLong("/sys/devices/system/cpu/" + name + "/online", online_val)) {
      online_val = 1;
    }
    if (online_val == 1) ++online;
  }
  closedir(dir);

  if (total > 0) {
    out.push_back(Metric{"cpu", "core_count", static_cast<double>(total), "count"});
    out.push_back(Metric{"cpu", "cores_online", static_cast<double>(online), "count"});
  }
}

// Per-socket CPU package power, read from AMD's E-SMI tool. Nothing in
// /proc or /sys exposes this on EPYC without root: the RAPL energy counters
// under /sys/class/powercap are 0400 (the Platypus side-channel mitigation),
// and the amd_energy driver is not loaded. e_smi_tool talks to the SMU
// directly, needs no privileges and returns in ~10 ms, so it is cheap enough
// to call every interval.
//
// Output is a fixed-width table, one column per socket:
//   | Power (Watts)      | 285.471    | 105.564    |
//   | PowerLimit (Watts) | 500.000    | 500.000    |
void CollectSocketPower(std::vector<Metric>& out) {
  std::array<char, 4096> buffer{};
  std::string payload;
  FILE* pipe = popen("timeout 3s e_smi_tool --showsockpower 2>/dev/null", "r");
  if (pipe == nullptr) {
    return;
  }
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    payload.append(buffer.data());
  }
  if (pclose(pipe) != 0 || payload.empty()) {
    return;
  }

  // Pull every numeric cell out of the row whose label matches, so the same
  // parse works for 1, 2 or 4 sockets.
  const auto row_values = [&payload](const std::string& label) {
    std::vector<double> values;
    std::istringstream stream(payload);
    std::string line;
    while (std::getline(stream, line)) {
      if (line.find(label) == std::string::npos) {
        continue;
      }
      const std::regex number(R"(([0-9]+\.[0-9]+|[0-9]+))");
      for (auto it = std::sregex_iterator(line.begin(), line.end(), number);
           it != std::sregex_iterator(); ++it) {
        try {
          values.push_back(std::stod(it->str()));
        } catch (...) {
        }
      }
      break;
    }
    return values;
  };

  const std::vector<double> watts = row_values("Power (Watts)");
  if (watts.empty()) {
    return;
  }
  double total = 0.0;
  for (std::size_t index = 0; index < watts.size(); ++index) {
    out.push_back(Metric{"cpu", "socket" + std::to_string(index) + "_power_w", watts[index], "watt"});
    total += watts[index];
  }
  out.push_back(Metric{"cpu", "package_power_w", total, "watt"});
  out.push_back(Metric{"cpu", "socket_count", static_cast<double>(watts.size()), "count"});

  const std::vector<double> limits = row_values("PowerLimit (Watts)");
  if (!limits.empty()) {
    double limit_total = 0.0;
    for (const double value : limits) {
      limit_total += value;
    }
    out.push_back(Metric{"cpu", "package_power_limit_w", limit_total, "watt"});
  }
}

class CpuCollector : public Collector {
 public:
  std::string Name() const override { return "cpu"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
    // Before the usage calculation: that needs two samples for a delta and
    // returns early on the first tick, whereas socket power is a point read
    // and should be reported from the very first snapshot.
    CollectSocketPower(out);

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
    CollectCores(out);

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
