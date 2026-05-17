// GPU collector — AMD via sysfs (amdgpu kernel driver), NVIDIA via nvidia-smi.
//
// The AMD path reads directly from /sys/class/drm/cardN/device/ rather than
// shelling out to rocm-smi. Reasons:
//   - rocm-smi's CSV output format varies wildly across ROCm releases.
//   - Some deployments saw rocm-smi --csv emit rows for only a subset of
//     visible GPUs (cgroup/visibility edge cases), so an 8-GPU node would
//     show full data for only 2 cards. sysfs always reflects every card the
//     amdgpu driver bound to, with no external dependency.
//   - sysfs values are documented and stable since Linux 4.x.
//
// The NVIDIA path still uses nvidia-smi (no equivalent sysfs surface).
//
// The collector stays completely silent when no GPU is present: gpu.count=0
// and gpu.vendor_code=0, and no per-GPU rows.

#include "collector.h"

#include <dirent.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr int kMaxGpus = 8;

enum GpuVendor {
  kVendorNone = 0,
  kVendorAmd = 1,
  kVendorNvidia = 2,
  kVendorMixed = 3,
};

bool RunCommand(const char* command, std::string& output) {
  std::array<char, 4096> buffer{};
  output.clear();
  FILE* pipe = popen(command, "r");
  if (!pipe) return false;
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    output.append(buffer.data());
  }
  const int status = pclose(pipe);
  return status == 0 && !output.empty();
}

// Quiet variant: some tools print to stderr on missing-device conditions.
// We already redirect 2>/dev/null at the call site; this helper doesn't
// demand the command to exit 0, because rocm-smi sometimes returns
// nonzero on partial queries but still prints usable rows.
bool RunCommandSoft(const char* command, std::string& output) {
  std::array<char, 4096> buffer{};
  output.clear();
  FILE* pipe = popen(command, "r");
  if (!pipe) return false;
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    output.append(buffer.data());
  }
  pclose(pipe);
  return !output.empty();
}

std::string Trim(const std::string& value) {
  std::size_t start = 0;
  while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) ++start;
  std::size_t end = value.size();
  while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) --end;
  return value.substr(start, end - start);
}

std::vector<std::string> SplitChar(const std::string& value, char sep) {
  std::vector<std::string> out;
  std::stringstream stream(value);
  std::string part;
  while (std::getline(stream, part, sep)) out.push_back(Trim(part));
  return out;
}

// Try to parse a leading double. "[N/A]", "N/A", "not available", empty → false.
bool ParseNumber(const std::string& raw, double& out) {
  const std::string s = Trim(raw);
  if (s.empty()) return false;
  if (s.find("N/A") != std::string::npos) return false;
  if (s.find("not") != std::string::npos) return false;
  std::stringstream ss(s);
  ss >> out;
  return !ss.fail();
}

// Enumerate AMD GPU card indices from sysfs. A "card" is any
// /sys/class/drm/cardN entry whose device/vendor file reads "0x1002" (AMD).
// Returned indices are the kernel's PCI-enumeration order, sorted ascending.
std::vector<int> ListAmdCards() {
  std::vector<int> out;
  DIR* dir = opendir("/sys/class/drm");
  if (!dir) return out;
  struct dirent* ent;
  while ((ent = readdir(dir)) != nullptr) {
    const std::string name = ent->d_name;
    // Match cardN strictly — exclude renderD*, controlD*, etc.
    if (name.size() < 5 || name.compare(0, 4, "card") != 0) continue;
    bool all_digits = true;
    for (std::size_t i = 4; i < name.size(); ++i) {
      if (!std::isdigit(static_cast<unsigned char>(name[i]))) { all_digits = false; break; }
    }
    if (!all_digits) continue;

    std::string vendor;
    std::ifstream vin("/sys/class/drm/" + name + "/device/vendor");
    if (vin.is_open()) std::getline(vin, vendor);
    if (vendor != "0x1002") continue;

    try { out.push_back(std::stoi(name.substr(4))); } catch (...) {}
  }
  closedir(dir);
  std::sort(out.begin(), out.end());
  if (static_cast<int>(out.size()) > kMaxGpus) out.resize(kMaxGpus);
  return out;
}

int CountAmdGpus() { return static_cast<int>(ListAmdCards().size()); }

// Find the hwmon subdir under /sys/class/drm/cardN/device/hwmon/. The amdgpu
// driver creates exactly one hwmonM directory per card, but the M is
// system-wide, so we have to scan.
std::string FindHwmonDir(const std::string& card_path) {
  const std::string base = card_path + "/device/hwmon";
  DIR* dir = opendir(base.c_str());
  if (!dir) return "";
  struct dirent* ent;
  std::string found;
  while ((ent = readdir(dir)) != nullptr) {
    const std::string name = ent->d_name;
    if (name.compare(0, 5, "hwmon") == 0 && name.size() > 5) {
      found = base + "/" + name;
      break;
    }
  }
  closedir(dir);
  return found;
}

bool ReadSysfsDouble(const std::string& path, double& out) {
  std::ifstream in(path);
  if (!in.is_open()) return false;
  in >> out;
  return !in.fail();
}

// Parse pp_dpm_sclk for the currently-active DPM level. Format:
//   0: 200Mhz
//   1: 700Mhz
//   2: 1500Mhz *      <- "*" marks the active level
bool ReadActiveSclkMhz(const std::string& card_path, double& out_mhz) {
  std::ifstream in(card_path + "/device/pp_dpm_sclk");
  if (!in.is_open()) return false;
  std::string line;
  while (std::getline(in, line)) {
    if (line.find('*') == std::string::npos) continue;
    const std::size_t mhz_pos = line.find("Mhz");
    if (mhz_pos == std::string::npos) continue;
    std::size_t start = mhz_pos;
    while (start > 0 && std::isdigit(static_cast<unsigned char>(line[start - 1]))) --start;
    if (start >= mhz_pos) continue;
    try {
      out_mhz = std::stod(line.substr(start, mhz_pos - start));
      return true;
    } catch (...) {
      return false;
    }
  }
  return false;
}

// NOTE: UNTESTED — `nvidia-smi -L` prints one "GPU 0: <name> (UUID...)" per card.
int CountNvidiaGpus() {
  std::string out;
  if (!RunCommandSoft("nvidia-smi -L 2>/dev/null", out)) return 0;
  int count = 0;
  std::istringstream ss(out);
  std::string line;
  while (std::getline(ss, line)) {
    if (line.rfind("GPU ", 0) == 0) ++count;
  }
  return std::min(count, kMaxGpus);
}

struct GpuSample {
  int index = -1;
  int vendor = kVendorNone;
  double temp_c = 0.0;
  double util_percent = 0.0;
  double power_w = 0.0;
  double power_cap_w = 0.0;
  double mem_used_mb = 0.0;
  double mem_total_mb = 0.0;
  double clock_mhz = 0.0;
  bool has_temp = false;
  bool has_util = false;
  bool has_power = false;
  bool has_cap = false;
  bool has_mem = false;
  bool has_clock = false;
};

// NOTE: UNTESTED — nvidia-smi --query-gpu with --format=csv,noheader,nounits
// produces one comma-separated line per GPU. Expected columns (order matters):
//   0: index
//   1: temperature.gpu (°C)
//   2: utilization.gpu (%)
//   3: power.draw (W)
//   4: power.limit (W)  — current cap, not hardware max
//   5: memory.used (MiB)
//   6: memory.total (MiB)
//   7: clocks.gr (MHz)
void QueryNvidia(std::vector<GpuSample>& samples) {
  std::string out;
  const char* cmd =
      "nvidia-smi --query-gpu=index,temperature.gpu,utilization.gpu,"
      "power.draw,power.limit,memory.used,memory.total,clocks.gr "
      "--format=csv,noheader,nounits 2>/dev/null";
  if (!RunCommand(cmd, out)) return;

  std::istringstream ss(out);
  std::string line;
  while (std::getline(ss, line)) {
    if (Trim(line).empty()) continue;
    const auto f = SplitChar(line, ',');
    if (f.size() < 8) continue;

    GpuSample g;
    g.vendor = kVendorNvidia;
    double tmp;
    if (!ParseNumber(f[0], tmp)) continue;
    g.index = static_cast<int>(tmp);
    if (g.index < 0 || g.index >= kMaxGpus) continue;
    if (ParseNumber(f[1], g.temp_c))       g.has_temp = true;
    if (ParseNumber(f[2], g.util_percent)) g.has_util = true;
    if (ParseNumber(f[3], g.power_w))      g.has_power = true;
    if (ParseNumber(f[4], g.power_cap_w))  g.has_cap = true;
    const bool used_ok = ParseNumber(f[5], g.mem_used_mb);
    const bool total_ok = ParseNumber(f[6], g.mem_total_mb);
    g.has_mem = used_ok && total_ok;
    if (ParseNumber(f[7], g.clock_mhz))    g.has_clock = true;
    samples.push_back(g);
  }
}

// Read every AMD GPU's metrics directly from sysfs. Each field is per-card
// independent: missing files just leave that field unset (has_X stays false)
// so partial data still gets reported.
//
// sysfs surface (provided by the in-tree amdgpu driver):
//   /sys/class/drm/cardN/device/hwmon/hwmonM/temp1_input    millidegree C
//   /sys/class/drm/cardN/device/hwmon/hwmonM/power1_average microwatts (avg)
//   /sys/class/drm/cardN/device/hwmon/hwmonM/power1_input   microwatts (alt)
//   /sys/class/drm/cardN/device/hwmon/hwmonM/power1_cap     microwatts
//   /sys/class/drm/cardN/device/gpu_busy_percent            0..100
//   /sys/class/drm/cardN/device/mem_info_vram_total         bytes
//   /sys/class/drm/cardN/device/mem_info_vram_used          bytes
//   /sys/class/drm/cardN/device/pp_dpm_sclk                 active level "*"
void QueryAmd(std::vector<GpuSample>& samples) {
  const auto cards = ListAmdCards();
  for (std::size_t logical = 0; logical < cards.size(); ++logical) {
    const int card_id = cards[logical];
    const std::string card_path = "/sys/class/drm/card" + std::to_string(card_id);
    const std::string hwmon = FindHwmonDir(card_path);

    GpuSample g;
    g.index = static_cast<int>(logical);
    g.vendor = kVendorAmd;

    double v = 0.0;
    if (!hwmon.empty()) {
      if (ReadSysfsDouble(hwmon + "/temp1_input", v)) {
        g.temp_c = v / 1000.0;
        g.has_temp = true;
      }
      if (ReadSysfsDouble(hwmon + "/power1_average", v) ||
          ReadSysfsDouble(hwmon + "/power1_input", v)) {
        g.power_w = v / 1000000.0;
        g.has_power = true;
      }
      if (ReadSysfsDouble(hwmon + "/power1_cap", v)) {
        g.power_cap_w = v / 1000000.0;
        g.has_cap = true;
      }
    }
    if (ReadSysfsDouble(card_path + "/device/gpu_busy_percent", v)) {
      g.util_percent = v;
      g.has_util = true;
    }
    double mem_total = 0.0, mem_used = 0.0;
    if (ReadSysfsDouble(card_path + "/device/mem_info_vram_total", mem_total) &&
        ReadSysfsDouble(card_path + "/device/mem_info_vram_used", mem_used)) {
      g.mem_total_mb = mem_total / (1024.0 * 1024.0);
      g.mem_used_mb = mem_used / (1024.0 * 1024.0);
      g.has_mem = true;
    }
    double mhz = 0.0;
    if (ReadActiveSclkMhz(card_path, mhz)) {
      g.clock_mhz = mhz;
      g.has_clock = true;
    }

    samples.push_back(g);
  }
}

class GpuCollector : public Collector {
 public:
  std::string Name() const override { return "gpu"; }

  bool Collect(std::vector<Metric>& out, std::string& /*error*/) override {
    const int count = amd_count_ + nvidia_count_;
    int fleet_vendor = kVendorNone;
    if (amd_count_ > 0 && nvidia_count_ > 0) fleet_vendor = kVendorMixed;
    else if (amd_count_ > 0) fleet_vendor = kVendorAmd;
    else if (nvidia_count_ > 0) fleet_vendor = kVendorNvidia;

    out.push_back(Metric{"gpu", "count", static_cast<double>(count), "count"});
    out.push_back(Metric{"gpu", "vendor_code", static_cast<double>(fleet_vendor), "enum"});

    if (count == 0) return true;  // GPU-less host: stay silent beyond headers.

    std::vector<GpuSample> samples;
    samples.reserve(count);
    if (amd_count_ > 0) QueryAmd(samples);
    if (nvidia_count_ > 0) QueryNvidia(samples);

    // Emit per-GPU metrics. Per-collect re-indexing isn't needed because both
    // rocm-smi and nvidia-smi number their devices 0..N-1 within each vendor;
    // on mixed hosts the UI would need a joint namespace, but mixed hosts are
    // vanishingly rare so we just emit AMDs as 0..amd_count-1 and NVs as
    // (amd_count)..(amd_count+nvidia_count-1). Renumber NV samples here.
    for (auto& s : samples) {
      if (s.vendor == kVendorNvidia) s.index += amd_count_;
    }

    double max_temp = 0.0, sum_power = 0.0, sum_util = 0.0;
    int util_n = 0;

    for (const auto& s : samples) {
      if (s.index < 0 || s.index >= kMaxGpus) continue;
      out.push_back(Metric{"gpu", std::to_string(s.index) + ".vendor_code",
                           static_cast<double>(s.vendor), "enum"});
      if (s.has_temp) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".temp_c", s.temp_c, "celsius"});
        if (s.temp_c > max_temp) max_temp = s.temp_c;
      }
      if (s.has_util) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".util_percent",
                             s.util_percent, "percent"});
        sum_util += s.util_percent; ++util_n;
      }
      if (s.has_power) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".power_w", s.power_w, "watt"});
        sum_power += s.power_w;
      }
      if (s.has_cap) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".power_cap_w",
                             s.power_cap_w, "watt"});
      }
      if (s.has_mem) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".mem_used_mb",
                             s.mem_used_mb, "mebibyte"});
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".mem_total_mb",
                             s.mem_total_mb, "mebibyte"});
      }
      if (s.has_clock) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".clock_mhz",
                             s.clock_mhz, "megahertz"});
      }
    }

    if (max_temp > 0.0) out.push_back(Metric{"gpu", "temp_max_c", max_temp, "celsius"});
    if (sum_power > 0.0) out.push_back(Metric{"gpu", "power_sum_w", sum_power, "watt"});
    if (util_n > 0) {
      out.push_back(Metric{"gpu", "util_avg_percent", sum_util / util_n, "percent"});
    }
    return true;
  }

 private:
  int amd_count_ = CountAmdGpus();
  int nvidia_count_ = CountNvidiaGpus();
};

}  // namespace

CollectorPtr CreateGpuCollector() {
  return std::make_unique<GpuCollector>();
}
