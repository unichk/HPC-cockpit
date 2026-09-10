#include "collector.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <dirent.h>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

std::string Trim(const std::string& value) {
  std::size_t start = 0;
  while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) {
    ++start;
  }
  std::size_t end = value.size();
  while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) {
    --end;
  }
  return value.substr(start, end - start);
}

bool RunCommand(const char* command, std::string& output) {
  std::array<char, 4096> buffer{};
  output.clear();
  FILE* pipe = popen(command, "r");
  if (!pipe) {
    return false;
  }
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    output.append(buffer.data());
  }
  const int status = pclose(pipe);
  return status == 0 && !output.empty();
}

std::vector<std::string> SplitPipe(const std::string& value) {
  std::vector<std::string> parts;
  std::stringstream stream(value);
  std::string part;
  while (std::getline(stream, part, '|')) {
    parts.push_back(Trim(part));
  }
  return parts;
}

std::string ToUpper(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  for (char ch : value) {
    out.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(ch))));
  }
  return out;
}

bool Contains(const std::string& haystack, const char* needle) {
  return haystack.find(needle) != std::string::npos;
}

int AlertLevel(double value, double warn, double crit) {
  if (value >= crit) {
    return 2;
  }
  if (value >= warn) {
    return 1;
  }
  return 0;
}

std::string ReadFileTrimmed(const std::string& path) {
  std::ifstream in(path);
  if (!in.is_open()) {
    return "";
  }
  std::string line;
  std::getline(in, line);
  return Trim(line);
}

// One temperature domain: the readings collected for it plus the thresholds
// used to score them. Emitted as <prefix>_max_c / <prefix>_count /
// <prefix>_alert_level, alongside the <prefix>_warn_c / <prefix>_crit_c pair.
struct Domain {
  const char* prefix;
  double warn_c;
  double crit_c;
  std::vector<double> values;
};

class ThermalCollector : public Collector {
 public:
  std::string Name() const override { return "thermal"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
    // Domain thresholds. CPU/NVMe/NIC/chipset keep the values the previous
    // lm-sensors implementation used so existing dashboard thresholds and
    // saved settings keep their meaning.
    Domain cpu{"cpu", 80.0, 90.0, {}};
    Domain dimm{"dimm", 80.0, 90.0, {}};
    Domain nvme{"nvme", 70.0, 80.0, {}};
    Domain nic{"nic", 85.0, 95.0, {}};
    Domain chipset{"chipset", 75.0, 85.0, {}};
    Domain psu{"psu", 90.0, 100.0, {}};
    Domain vr{"vr", 95.0, 105.0, {}};
    Domain board{"board", 80.0, 90.0, {}};

    const bool ipmi_ok = CollectIpmi(cpu, dimm, nvme, psu, vr, board);
    // The BMC on this class of board exposes no NIC or chipset sensor, and
    // its NVMe rows are per-group aggregates. sysfs hwmon fills those gaps
    // and needs no lm-sensors package — we read the kernel nodes directly.
    CollectHwmon(cpu, nvme, nic, chipset);

    const bool any = !cpu.values.empty() || !dimm.values.empty() || !nvme.values.empty() ||
                     !nic.values.empty() || !chipset.values.empty() || !psu.values.empty() ||
                     !vr.values.empty() || !board.values.empty();
    if (!any) {
      out.push_back(Metric{"thermal", "available", 0.0, "bool"});
      if (last_available_) {
        error = ipmi_ok ? "no usable temperature sensors found in IPMI SDR or sysfs hwmon"
                        : "temperature query failed; cmd='ipmitool sdr type Temperature' "
                          "(check ipmitool is installed and the worker can open /dev/ipmi0)";
        last_available_ = false;
        return false;
      }
      return true;
    }

    out.push_back(Metric{"thermal", "available", 1.0, "bool"});
    last_available_ = true;

    // Per-socket CPU packages stay individually addressable; the dashboard
    // reads cpu_package0_c and cpu_package_max_c.
    for (std::size_t index = 0; index < cpu.values.size(); ++index) {
      out.push_back(Metric{"thermal", "cpu_package" + std::to_string(index) + "_c",
                           cpu.values[index], "celsius"});
    }
    if (!cpu.values.empty()) {
      const double cpu_max = *std::max_element(cpu.values.begin(), cpu.values.end());
      out.push_back(Metric{"thermal", "cpu_package_max_c", cpu_max, "celsius"});
    }

    for (const Domain* domain : {&cpu, &dimm, &nvme, &nic, &chipset, &psu, &vr, &board}) {
      const std::string prefix(domain->prefix);
      out.push_back(Metric{"thermal", prefix + "_warn_c", domain->warn_c, "celsius"});
      out.push_back(Metric{"thermal", prefix + "_crit_c", domain->crit_c, "celsius"});
      if (domain->values.empty()) {
        continue;
      }
      const double max_c = *std::max_element(domain->values.begin(), domain->values.end());
      // chipset is a single-sensor domain — keep its historical metric name.
      if (prefix == "chipset") {
        out.push_back(Metric{"thermal", "chipset_c", max_c, "celsius"});
      } else {
        out.push_back(Metric{"thermal", prefix + "_max_c", max_c, "celsius"});
      }
      out.push_back(Metric{"thermal", prefix + "_count",
                           static_cast<double>(domain->values.size()), "count"});
      out.push_back(Metric{"thermal", prefix + "_alert_level",
                           static_cast<double>(AlertLevel(max_c, domain->warn_c, domain->crit_c)),
                           "level"});
    }

    return true;
  }

 private:
  // Read every analogue temperature row the BMC reports and bucket it by
  // sensor name. Rows with no reading ("ns" / "No Reading") are headers for
  // hardware that isn't installed and are skipped.
  //
  // GPU rows are deliberately ignored: nvidia-smi owns GPU telemetry (it is
  // faster, per-device and always in the driver's own indexing), and the BMC
  // labels its slots by physical position, so mixing the two would double-
  // report the same die under two different indices.
  static bool CollectIpmi(Domain& cpu, Domain& dimm, Domain& nvme, Domain& psu, Domain& vr,
                          Domain& board) {
    std::string payload;
    if (!RunCommand("timeout 5s ipmitool sdr type Temperature 2>/dev/null", payload)) {
      return false;
    }

    std::istringstream stream(payload);
    std::string line;
    while (std::getline(stream, line)) {
      // Layout: "CPU0_TEMP | 01h | ok | 65.1 | 42 degrees C"
      const auto fields = SplitPipe(line);
      if (fields.size() < 5) {
        continue;
      }
      const std::string& reading = fields[4];
      if (!Contains(reading, "degrees C")) {
        continue;
      }
      double celsius = 0.0;
      try {
        celsius = std::stod(reading);
      } catch (...) {
        continue;
      }

      const std::string name = ToUpper(fields[0]);

      // Order matters: the first match wins, so more specific prefixes are
      // tested before the generic substrings they contain. VR_P0_SOC_TEMP is
      // a regulator, not a chipset; M2_AMB_TEMP is board air, not a drive.
      if (Contains(name, "GPU")) {
        continue;
      }
      if (Contains(name, "VR_") || Contains(name, "VRM") || Contains(name, "VCCIN") ||
          Contains(name, "PVDD")) {
        vr.values.push_back(celsius);
      } else if (Contains(name, "PSU") || Contains(name, "PS1_") || Contains(name, "PS2_")) {
        psu.values.push_back(celsius);
      } else if (Contains(name, "DIMM") || Contains(name, "MEM")) {
        dimm.values.push_back(celsius);
      } else if (Contains(name, "AMB") || Contains(name, "INLET") || Contains(name, "OUTLET") ||
                 Contains(name, "BPB") || Contains(name, "HIC") || Contains(name, "BOARD") ||
                 Contains(name, "PERIPHERAL")) {
        board.values.push_back(celsius);
      } else if (Contains(name, "NVME") || Contains(name, "SSD") || Contains(name, "HDD")) {
        nvme.values.push_back(celsius);
      } else if (Contains(name, "CPU") && !Contains(name, "FAN")) {
        cpu.values.push_back(celsius);
      }
    }
    return true;
  }

  // Walk /sys/class/hwmon for the domains the BMC does not cover. This is the
  // same data lm-sensors would print, read straight from the kernel so the
  // worker has no dependency on the lm-sensors package being installed.
  static void CollectHwmon(Domain& cpu, Domain& nvme, Domain& nic, Domain& chipset) {
    DIR* dir = opendir("/sys/class/hwmon");
    if (dir == nullptr) {
      return;
    }

    std::vector<double> hwmon_cpu;
    std::vector<double> hwmon_nvme;

    while (const dirent* entry = readdir(dir)) {
      const std::string entry_name = entry->d_name;
      if (entry_name == "." || entry_name == "..") {
        continue;
      }
      const std::string base = "/sys/class/hwmon/" + entry_name;
      const std::string driver = ToUpper(ReadFileTrimmed(base + "/name"));
      if (driver.empty()) {
        continue;
      }

      const bool is_nic = driver == "I350BB" || driver == "IGB" || driver == "IXGBE" ||
                          driver == "ICE" || driver == "MLX4" || driver == "MLX5" ||
                          driver == "MLX5_CORE" || driver == "BNXT" || driver == "BNXT_EN" ||
                          driver == "BNX2X" || Contains(driver, "NIC");
      const bool is_chipset = Contains(driver, "PCH");
      const bool is_cpu = driver == "K10TEMP" || driver == "ZENPOWER" || driver == "CORETEMP";
      const bool is_nvme = driver == "NVME";
      if (!is_nic && !is_chipset && !is_cpu && !is_nvme) {
        continue;
      }

      // temp1_input .. temp<N>_input, scaled millidegrees → degrees.
      for (int index = 1; index <= 32; ++index) {
        const std::string stem = base + "/temp" + std::to_string(index);
        const std::string raw = ReadFileTrimmed(stem + "_input");
        if (raw.empty()) {
          continue;
        }
        double celsius = 0.0;
        try {
          celsius = std::stod(raw) / 1000.0;
        } catch (...) {
          continue;
        }
        if (celsius <= 0.0 || celsius > 200.0) {
          continue;
        }

        if (is_nic) {
          nic.values.push_back(celsius);
        } else if (is_chipset) {
          chipset.values.push_back(celsius);
        } else if (is_cpu) {
          // k10temp exposes Tctl plus optional Tdie/Tccd sensors; only the
          // first (control) reading represents the package.
          if (index == 1) {
            hwmon_cpu.push_back(celsius);
          }
        } else if (is_nvme) {
          // temp1 is the drive's Composite; higher indices are vendor
          // sensors that run hotter and would skew the domain max.
          if (index == 1) {
            hwmon_nvme.push_back(celsius);
          }
        }
      }
    }
    closedir(dir);

    // In-band readings are a fallback for these two: the BMC's values are
    // authoritative when present (its NVMe rows aggregate a whole group, and
    // its CPU rows come from the same die sensor via the SMBus).
    if (cpu.values.empty()) {
      cpu.values = hwmon_cpu;
    }
    if (nvme.values.empty()) {
      nvme.values = hwmon_nvme;
    }
  }

  bool last_available_ = true;
};

}  // namespace

CollectorPtr CreateThermalCollector() {
  return std::make_unique<ThermalCollector>();
}
