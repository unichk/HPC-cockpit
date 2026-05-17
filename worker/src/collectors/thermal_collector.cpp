#include "collector.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <regex>
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

bool StartsWith(const std::string& value, const std::string& prefix) {
  return value.size() >= prefix.size() && value.compare(0, prefix.size(), prefix) == 0;
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

int AlertLevel(double value, double warn, double crit) {
  if (value >= crit) {
    return 2;
  }
  if (value >= warn) {
    return 1;
  }
  return 0;
}

class ThermalCollector : public Collector {
 public:
  std::string Name() const override { return "thermal"; }

  bool Collect(std::vector<Metric>& out, std::string& /*error*/) override {
    std::string payload;
    if (!RunCommand("timeout 2s sensors 2>/dev/null", payload)) {
      out.push_back(Metric{"thermal", "available", 0.0, "bool"});
      return true;
    }

    const std::regex temp_regex(R"(([+-]?[0-9]+(?:\.[0-9]+)?)°C)");
    std::vector<double> cpu_packages;
    std::vector<double> nvme_composite;
    std::vector<double> nic_temps;
    double chipset_temp = -1.0;

    std::istringstream stream(payload);
    std::string line;
    std::string section;
    while (std::getline(stream, line)) {
      if (line.empty()) {
        continue;
      }

      const bool is_header = line.find(':') == std::string::npos &&
                             !std::isspace(static_cast<unsigned char>(line[0]));
      if (is_header) {
        section = Trim(line);
        continue;
      }

      // Intel CPU: coretemp-*  ->  "Package id 0:  +52.0°C"
      if (StartsWith(section, "coretemp-") && line.find("Package id ") != std::string::npos) {
        std::smatch match;
        if (std::regex_search(line, match, temp_regex)) {
          cpu_packages.push_back(std::stod(match[1].str()));
        }
        continue;
      }

      // AMD CPU: k10temp-* (in-tree) or zenpower-* (out-of-tree). Both expose
      // Tctl (control temp, what the firmware uses for fan curves) and on
      // newer kernels Tdie (the actual die temp, slightly lower). Prefer Tdie
      // when present; fall back to Tctl. One package reading per socket.
      if (StartsWith(section, "k10temp-") || StartsWith(section, "zenpower-")) {
        const std::string trimmed = Trim(line);
        const bool is_tdie = StartsWith(trimmed, "Tdie:");
        const bool is_tctl = StartsWith(trimmed, "Tctl:");
        if (is_tdie || is_tctl) {
          std::smatch match;
          if (std::regex_search(line, match, temp_regex)) {
            const double value = std::stod(match[1].str());
            // Prefer Tdie if both appear for the same section: replace any
            // Tctl we already pushed for this section when Tdie arrives next.
            if (is_tdie && !cpu_packages.empty()) {
              cpu_packages.back() = value;
            } else {
              cpu_packages.push_back(value);
            }
          }
        }
        continue;
      }

      if (StartsWith(section, "nvme-") && line.find("Composite:") != std::string::npos) {
        std::smatch match;
        if (std::regex_search(line, match, temp_regex)) {
          nvme_composite.push_back(std::stod(match[1].str()));
        }
        continue;
      }

      // NIC temp sensors. Common section prefixes:
      //   mlx4-/mlx5-       Mellanox/NVIDIA ConnectX
      //   i350bb-, igb-     Intel i350/igb-driver NICs
      //   ixgbe-, ice-      Intel 10G/100G NICs
      //   bnxt-, bnx2x-     Broadcom NetXtreme
      // We also match generic "nic" / "ethernet" sections and any section
      // containing "-nic-" for whitebox boards.
      const bool is_nic_section =
          StartsWith(section, "mlx") || StartsWith(section, "nic") ||
          StartsWith(section, "ethernet") || section.find("-nic-") != std::string::npos ||
          StartsWith(section, "i350") || StartsWith(section, "igb-") ||
          StartsWith(section, "ixgbe-") || StartsWith(section, "ice-") ||
          StartsWith(section, "bnxt") || StartsWith(section, "bnx2x");
      if (is_nic_section && line.find(':') != std::string::npos) {
        std::smatch match;
        if (std::regex_search(line, match, temp_regex)) {
          nic_temps.push_back(std::stod(match[1].str()));
        }
        continue;
      }

      if (section.find("pch") != std::string::npos && line.find(':') != std::string::npos) {
        std::smatch match;
        if (std::regex_search(line, match, temp_regex)) {
          const double value = std::stod(match[1].str());
          if (chipset_temp < 0.0 || value > chipset_temp) {
            chipset_temp = value;
          }
        }
      }
    }

    out.push_back(Metric{"thermal", "available", 1.0, "bool"});

    constexpr double cpu_warn_c = 80.0;
    constexpr double cpu_crit_c = 90.0;
    constexpr double nvme_warn_c = 70.0;
    constexpr double nvme_crit_c = 80.0;
    constexpr double nic_warn_c = 85.0;
    constexpr double nic_crit_c = 95.0;
    constexpr double chipset_warn_c = 75.0;
    constexpr double chipset_crit_c = 85.0;

    out.push_back(Metric{"thermal", "cpu_warn_c", cpu_warn_c, "celsius"});
    out.push_back(Metric{"thermal", "cpu_crit_c", cpu_crit_c, "celsius"});
    out.push_back(Metric{"thermal", "nvme_warn_c", nvme_warn_c, "celsius"});
    out.push_back(Metric{"thermal", "nvme_crit_c", nvme_crit_c, "celsius"});
    out.push_back(Metric{"thermal", "nic_warn_c", nic_warn_c, "celsius"});
    out.push_back(Metric{"thermal", "nic_crit_c", nic_crit_c, "celsius"});
    out.push_back(Metric{"thermal", "chipset_warn_c", chipset_warn_c, "celsius"});
    out.push_back(Metric{"thermal", "chipset_crit_c", chipset_crit_c, "celsius"});

    if (!cpu_packages.empty()) {
      for (std::size_t index = 0; index < cpu_packages.size(); ++index) {
        out.push_back(Metric{"thermal", "cpu_package" + std::to_string(index) + "_c", cpu_packages[index],
                             "celsius"});
      }
      const double cpu_max = *std::max_element(cpu_packages.begin(), cpu_packages.end());
      out.push_back(Metric{"thermal", "cpu_package_max_c", cpu_max, "celsius"});
      out.push_back(Metric{"thermal", "cpu_alert_level", static_cast<double>(AlertLevel(cpu_max, cpu_warn_c, cpu_crit_c)),
                           "level"});
    }

    if (!nvme_composite.empty()) {
      const double nvme_max = *std::max_element(nvme_composite.begin(), nvme_composite.end());
      out.push_back(Metric{"thermal", "nvme_max_c", nvme_max, "celsius"});
      out.push_back(Metric{"thermal", "nvme_count", static_cast<double>(nvme_composite.size()), "count"});
      out.push_back(
          Metric{"thermal", "nvme_alert_level", static_cast<double>(AlertLevel(nvme_max, nvme_warn_c, nvme_crit_c)),
                 "level"});
    }

    if (!nic_temps.empty()) {
      const double nic_max = *std::max_element(nic_temps.begin(), nic_temps.end());
      out.push_back(Metric{"thermal", "nic_max_c", nic_max, "celsius"});
      out.push_back(Metric{"thermal", "nic_count", static_cast<double>(nic_temps.size()), "count"});
      out.push_back(Metric{"thermal", "nic_alert_level", static_cast<double>(AlertLevel(nic_max, nic_warn_c, nic_crit_c)),
                           "level"});
    }

    if (chipset_temp >= 0.0) {
      out.push_back(Metric{"thermal", "chipset_c", chipset_temp, "celsius"});
      out.push_back(Metric{"thermal", "chipset_alert_level",
                           static_cast<double>(AlertLevel(chipset_temp, chipset_warn_c, chipset_crit_c)), "level"});
    }

    return true;
  }
};

}  // namespace

CollectorPtr CreateThermalCollector() {
  return std::make_unique<ThermalCollector>();
}
