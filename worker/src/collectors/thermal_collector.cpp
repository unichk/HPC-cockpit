#include "collector.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <dirent.h>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <utility>
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

std::string ReadFileTrimmed(const std::string& path) {
  std::ifstream in(path);
  if (!in.is_open()) {
    return "";
  }
  std::string line;
  std::getline(in, line);
  return Trim(line);
}

// Millidegree sysfs attribute -> degrees, or `fallback` when absent/unparseable.
double ReadHwmonMilliC(const std::string& path, double fallback) {
  const std::string raw = ReadFileTrimmed(path);
  if (raw.empty()) {
    return fallback;
  }
  try {
    const double value = std::stod(raw) / 1000.0;
    return (value > 0.0 && value <= 250.0) ? value : fallback;
  } catch (...) {
    return fallback;
  }
}

// One sensor: its reading and the warn/crit limits that apply to *it*.
// Limits are per-sensor because sensors inside a single domain can differ
// enormously -- on this chassis BPB_TEMP trips at 55/60 while HIC_TEMP_0 is
// specified to 105/110, both of which are "board" temperatures.
struct Reading {
  double celsius;
  double warn_c;
  double crit_c;
};

// A temperature domain and the fallback limits used for any sensor in it whose
// own limits the hardware does not publish.
struct Domain {
  const char* prefix;
  double default_warn_c;
  double default_crit_c;
  std::vector<Reading> readings;
};

int AlertLevel(const Reading& reading) {
  if (reading.celsius >= reading.crit_c) {
    return 2;
  }
  if (reading.celsius >= reading.warn_c) {
    return 1;
  }
  return 0;
}

// Per-sensor warn/crit as published by the BMC, keyed by upper-cased sensor
// name. `ipmitool sdr -v type Temperature` reports these as "Upper
// non-critical" and "Upper critical"; they are the board vendor's own limits
// and are preferred over any value we could invent.
//
// Read once and cached: thresholds are static for the life of the machine, and
// the verbose SDR walk is far too slow to repeat every interval.
using ThresholdMap = std::map<std::string, std::pair<double, double>>;

ThresholdMap LoadIpmiThresholds() {
  ThresholdMap out;
  std::string payload;
  if (!RunCommand("timeout 60s ipmitool sdr -v type Temperature 2>/dev/null", payload)) {
    return out;
  }

  std::istringstream stream(payload);
  std::string line;
  std::string current;
  double warn = -1.0;
  double crit = -1.0;

  const auto flush = [&out, &current, &warn, &crit]() {
    if (!current.empty() && (warn > 0.0 || crit > 0.0)) {
      // A sensor may publish only one of the two; fill the other in relative to
      // it so we never compare a reading against a zero limit. Order the pair
      // defensively -- a warn above crit would make the warn level
      // unreachable and every crossing read as critical.
      const double w = warn > 0.0 ? warn : crit;
      const double c = crit > 0.0 ? crit : warn;
      out[current] = {std::min(w, c), std::max(w, c)};
    }
    current.clear();
    warn = -1.0;
    crit = -1.0;
  };

  const auto value_after_colon = [](const std::string& text, double& value) {
    const auto colon = text.find(':');
    if (colon == std::string::npos) {
      return false;
    }
    try {
      value = std::stod(Trim(text.substr(colon + 1)));
    } catch (...) {
      return false;
    }
    return true;
  };

  while (std::getline(stream, line)) {
    const std::string trimmed = Trim(line);
    if (trimmed.rfind("Sensor ID", 0) == 0) {
      flush();
      const auto colon = trimmed.find(':');
      if (colon == std::string::npos) {
        continue;
      }
      std::string name = Trim(trimmed.substr(colon + 1));
      // "CPU0_TEMP (0x1)" -> "CPU0_TEMP"
      const auto paren = name.find(" (");
      if (paren != std::string::npos) {
        name = Trim(name.substr(0, paren));
      }
      current = ToUpper(name);
      continue;
    }
    if (trimmed.rfind("Upper non-critical", 0) == 0) {
      value_after_colon(trimmed, warn);
    } else if (trimmed.rfind("Upper critical", 0) == 0) {
      value_after_colon(trimmed, crit);
    }
  }
  flush();
  return out;
}

class ThermalCollector : public Collector {
 public:
  std::string Name() const override { return "thermal"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
    // Fallback limits, used only for sensors whose own limits the hardware
    // does not publish. Kept at the values the previous lm-sensors
    // implementation used so behaviour is unchanged where nothing better
    // is available.
    Domain cpu{"cpu", 80.0, 90.0, {}};
    Domain dimm{"dimm", 80.0, 90.0, {}};
    Domain nvme{"nvme", 70.0, 80.0, {}};
    Domain nic{"nic", 85.0, 95.0, {}};
    Domain chipset{"chipset", 75.0, 85.0, {}};
    Domain psu{"psu", 90.0, 100.0, {}};
    Domain vr{"vr", 95.0, 105.0, {}};
    Domain board{"board", 80.0, 90.0, {}};

    // GPU limits only: warn/crit with no reading of its own.
    Reading gpu_limits{0.0, 0.0, 0.0};
    const bool ipmi_ok = CollectIpmi(cpu, dimm, nvme, psu, vr, board, gpu_limits);
    // The BMC on this class of board exposes no NIC or chipset sensor, and its
    // NVMe rows are per-group aggregates. sysfs hwmon fills those gaps and
    // needs no lm-sensors package -- we read the kernel nodes directly.
    CollectHwmon(cpu, nvme, nic, chipset);

    Domain* domains[] = {&cpu, &dimm, &nvme, &nic, &chipset, &psu, &vr, &board};

    bool any = false;
    for (const Domain* domain : domains) {
      if (!domain->readings.empty()) {
        any = true;
        break;
      }
    }
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

    // Published without a matching gpu_max_c: there is deliberately no "gpu"
    // thermal domain, since the gpu module carries the actual temperatures.
    if (gpu_limits.warn_c > 0.0 && gpu_limits.crit_c > 0.0) {
      out.push_back(Metric{"thermal", "gpu_warn_c", gpu_limits.warn_c, "celsius"});
      out.push_back(Metric{"thermal", "gpu_crit_c", gpu_limits.crit_c, "celsius"});
    }

    if (!cpu.readings.empty()) {
      out.push_back(Metric{"thermal", "cpu_package_max_c", Hottest(cpu).celsius, "celsius"});
    }

    for (const Domain* domain : domains) {
      const std::string prefix(domain->prefix);
      // Per-sensor metric stem. CPU keeps "cpu_package<N>" because the
      // dashboard, live-data.js and the detail page already read those names;
      // every other domain is just "<prefix><N>".
      const std::string stem = (prefix == "cpu") ? "cpu_package" : prefix;
      if (domain->readings.empty()) {
        // No sensor: emit nothing at all, so the UI can distinguish "domain
        // absent" from "domain reads 0". Publishing thresholds for a domain
        // that has no reading only invites them being rendered as data.
        continue;
      }

      const Reading& hottest = Hottest(*domain);
      if (prefix == "chipset") {
        // Single-sensor domain -- keep its historical metric name.
        out.push_back(Metric{"thermal", "chipset_c", hottest.celsius, "celsius"});
      } else {
        out.push_back(Metric{"thermal", prefix + "_max_c", hottest.celsius, "celsius"});
      }

      // The published pair belongs to the hottest sensor, so the value and the
      // limits shown beside it always describe the same physical sensor. Taking
      // the tightest limit across a mixed domain would flag the board domain as
      // critical purely because BPB_TEMP's 60 C ceiling sits below HIC_TEMP's
      // normal running temperature.
      out.push_back(Metric{"thermal", prefix + "_warn_c", hottest.warn_c, "celsius"});
      out.push_back(Metric{"thermal", prefix + "_crit_c", hottest.crit_c, "celsius"});
      out.push_back(Metric{"thermal", prefix + "_count",
                           static_cast<double>(domain->readings.size()), "count"});

      // Scored per sensor against that sensor's own limits, then reduced to the
      // worst -- a cool sensor with a low ceiling is not masked by a hot sensor
      // with a high one.
      int worst = 0;
      for (const Reading& reading : domain->readings) {
        worst = std::max(worst, AlertLevel(reading));
      }
      out.push_back(Metric{"thermal", prefix + "_alert_level", static_cast<double>(worst), "level"});

      // Every individual sensor, in the order the BMC lists them within the
      // domain, each with its own limits. Sensors inside one domain can have
      // very different ceilings, so a per-sensor reading is only interpretable
      // alongside its own pair. This is what lets the UI show a zone-by-zone
      // view instead of a single domain maximum; it costs ~2 KB of JSON, which
      // is ~200 bytes on the wire once deflated.
      for (std::size_t index = 0; index < domain->readings.size(); ++index) {
        const Reading& reading = domain->readings[index];
        const std::string base = stem + std::to_string(index);
        out.push_back(Metric{"thermal", base + "_c", reading.celsius, "celsius"});
        // Only publish a sensor's own limits when they differ from the
        // domain-level pair the consumer already has; otherwise it would be
        // the same two numbers repeated for every sensor. Homogeneous domains
        // (all 8 DIMM zones share 85/87) then cost one metric per sensor
        // instead of three, which is what keeps the snapshot inside a single
        // unfragmented datagram. Consumers fall back to <domain>_warn_c.
        if (reading.warn_c != hottest.warn_c || reading.crit_c != hottest.crit_c) {
          out.push_back(Metric{"thermal", base + "_warn_c", reading.warn_c, "celsius"});
          out.push_back(Metric{"thermal", base + "_crit_c", reading.crit_c, "celsius"});
        }
      }
    }

    return true;
  }

 private:
  static const Reading& Hottest(const Domain& domain) {
    return *std::max_element(domain.readings.begin(), domain.readings.end(),
                             [](const Reading& a, const Reading& b) { return a.celsius < b.celsius; });
  }

  // Look up a BMC sensor's published limits, falling back to the domain's
  // defaults when the hardware does not specify them.
  Reading MakeReading(const std::string& sensor_name, double celsius, const Domain& domain) const {
    const auto found = ipmi_thresholds_.find(sensor_name);
    if (found != ipmi_thresholds_.end()) {
      return Reading{celsius, found->second.first, found->second.second};
    }
    return Reading{celsius, domain.default_warn_c, domain.default_crit_c};
  }

  // Read every analogue temperature row the BMC reports and bucket it by
  // sensor name. Rows with no reading ("ns" / "No Reading") are headers for
  // hardware that is not installed and are skipped.
  //
  // GPU rows are deliberately ignored: nvidia-smi owns GPU telemetry (it is
  // faster, per-device and always in the driver's own indexing), and the BMC
  // labels its slots by physical position, so mixing the two would double-
  // report the same die under two different indices.
  bool CollectIpmi(Domain& cpu, Domain& dimm, Domain& nvme, Domain& psu, Domain& vr,
                   Domain& board, Reading& gpu_limits) const {
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
        // The reading is discarded -- nvidia-smi owns GPU temperature, and the
        // BMC indexes by physical slot rather than driver order. But its
        // *limits* are the board vendor's, and nvidia-smi publishes none, so
        // they are kept for consumers to score the driver's readings against.
        // The tightest across the slots wins.
        const Reading slot = MakeReading(name, celsius, board);
        if (gpu_limits.crit_c <= 0.0 || slot.crit_c < gpu_limits.crit_c) {
          gpu_limits.crit_c = slot.crit_c;
        }
        if (gpu_limits.warn_c <= 0.0 || slot.warn_c < gpu_limits.warn_c) {
          gpu_limits.warn_c = slot.warn_c;
        }
        continue;
      }
      Domain* target = nullptr;
      if (Contains(name, "VR_") || Contains(name, "VRM") || Contains(name, "VCCIN") ||
          Contains(name, "PVDD")) {
        target = &vr;
      } else if (Contains(name, "PSU") || Contains(name, "PS1_") || Contains(name, "PS2_")) {
        target = &psu;
      } else if (Contains(name, "DIMM") || Contains(name, "MEM")) {
        target = &dimm;
      } else if (Contains(name, "AMB") || Contains(name, "INLET") || Contains(name, "OUTLET") ||
                 Contains(name, "BPB") || Contains(name, "HIC") || Contains(name, "BOARD") ||
                 Contains(name, "PERIPHERAL")) {
        target = &board;
      } else if (Contains(name, "NVME") || Contains(name, "SSD") || Contains(name, "HDD")) {
        target = &nvme;
      } else if (Contains(name, "CPU") && !Contains(name, "FAN")) {
        target = &cpu;
      }
      if (target != nullptr) {
        target->readings.push_back(MakeReading(name, celsius, *target));
      }
    }
    return true;
  }

  // Walk /sys/class/hwmon for the domains the BMC does not cover. This is the
  // same data lm-sensors would print, read straight from the kernel so the
  // worker has no dependency on the lm-sensors package being installed.
  //
  // Drivers expose their own limits as tempN_max (warn) and tempN_crit, which
  // are used in preference to the domain defaults exactly as the BMC's are.
  void CollectHwmon(Domain& cpu, Domain& nvme, Domain& nic, Domain& chipset) const {
    DIR* dir = opendir("/sys/class/hwmon");
    if (dir == nullptr) {
      return;
    }

    std::vector<Reading> hwmon_cpu;
    std::vector<Reading> hwmon_nvme;

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

      // temp1_input .. temp<N>_input, scaled millidegrees -> degrees.
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

        const Domain& owner = is_nic ? nic : is_chipset ? chipset : is_cpu ? cpu : nvme;
        // tempN_crit is unambiguous, but tempN_max is not a portable "warning"
        // level: nvme reports max 76.85 below crit 84.85, while the igb/i350
        // driver reports max 120 *above* crit 110. Only trust _max as the warn
        // level when it actually sits below _crit; otherwise keep the domain
        // default, then clamp so warn can never exceed crit.
        const double crit = ReadHwmonMilliC(stem + "_crit", owner.default_crit_c);
        const double max_attr = ReadHwmonMilliC(stem + "_max", -1.0);
        double warn = (max_attr > 0.0 && max_attr < crit) ? max_attr : owner.default_warn_c;
        warn = std::min(warn, crit);
        const Reading reading{celsius, warn, crit};

        if (is_nic) {
          nic.readings.push_back(reading);
        } else if (is_chipset) {
          chipset.readings.push_back(reading);
        } else if (is_cpu) {
          // k10temp exposes Tctl plus optional Tdie/Tccd sensors; only the
          // first (control) reading represents the package.
          if (index == 1) {
            hwmon_cpu.push_back(reading);
          }
        } else {
          // temp1 is the drive's Composite; higher indices are vendor sensors
          // that run hotter and would skew the domain.
          if (index == 1) {
            hwmon_nvme.push_back(reading);
          }
        }
      }
    }
    closedir(dir);

    // In-band readings are a fallback for these two: the BMC's values are
    // authoritative when present (its NVMe rows aggregate a whole group, and
    // its CPU rows come from the same die sensor via the SMBus).
    if (cpu.readings.empty()) {
      cpu.readings = std::move(hwmon_cpu);
    }
    if (nvme.readings.empty()) {
      nvme.readings = std::move(hwmon_nvme);
    }
  }

  bool last_available_ = true;
  // Populated once, at construction: static for the life of the machine.
  ThresholdMap ipmi_thresholds_ = LoadIpmiThresholds();
};

}  // namespace

CollectorPtr CreateThermalCollector() {
  return std::make_unique<ThermalCollector>();
}
