#include "collector.h"

#include <array>
#include <cctype>
#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

namespace {

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

class PowerCollector : public Collector {
 public:
  std::string Name() const override { return "power"; }

  bool Collect(std::vector<Metric>& out, std::string& /*error*/) override {
    // Query every sensor row (no --sensor-type filter) and pick the best
    // input-power reading from the result. Different BMC vendors expose PSU
    // input wattage under different sensor types and names:
    //   Supermicro  "PSU PIN TOTAL"          under "Power Supply"
    //   Dell/iDRAC  "Pwr Consumption"        under "Current"
    //   HPE iLO     "Power Meter" / "System Power"
    //   Inventec    "PSU1 PIN" + "PSU2 PIN"  (per-PSU, no total)
    //   ASRock/AMI  "Total_Power"            under "Other Units Based"
    // We scan all rows reporting "W" and apply this priority:
    //   1. Explicit total: name contains TOTAL + (PIN|POWER|WATT|PWR), or
    //      Pwr Consumption / System Power / Power Meter / Total Power.
    //   2. Sum of per-PSU PIN sensors (PSU input power).
    //   3. Sum of per-PSU POUT sensors (PSU output power, fallback).
    //   4. The single W reading on the box, if there's exactly one.
    std::string payload;
    if (!RunCommand("timeout 3s ipmi-sensors --no-header-output 2>/dev/null", payload)) {
      out.push_back(Metric{"power", "available", 0.0, "bool"});
      return true;
    }

    double total_explicit = -1.0;
    double sum_pin = 0.0;
    int n_pin = 0;
    double sum_pout = 0.0;
    int n_pout = 0;
    double single_watt = -1.0;
    int n_w = 0;

    std::istringstream stream(payload);
    std::string line;
    while (std::getline(stream, line)) {
      const auto fields = SplitPipe(line);
      if (fields.size() < 5) {
        continue;
      }
      // Layout: "ID | name | type | value | unit | event..."
      const std::string& unit = fields[4];
      if (unit != "W" && unit != "Watts" && unit != "watt") {
        continue;
      }
      double watts = 0.0;
      try {
        watts = std::stod(fields[3]);
      } catch (...) {
        continue;
      }
      if (watts < 0.0) {
        continue;
      }

      const std::string upper = ToUpper(fields[1]);
      ++n_w;
      single_watt = watts;

      const bool has_total = upper.find("TOTAL") != std::string::npos;
      const bool has_pin = upper.find("PIN") != std::string::npos;
      const bool has_pout = upper.find("POUT") != std::string::npos;
      const bool has_power_word =
          upper.find("POWER") != std::string::npos || upper.find("WATT") != std::string::npos ||
          upper.find("PWR") != std::string::npos;

      const bool is_explicit_total =
          (has_total && (has_pin || has_power_word)) ||
          upper.find("PWR CONSUMPTION") != std::string::npos ||
          upper.find("SYSTEM POWER") != std::string::npos ||
          upper.find("SYS POWER") != std::string::npos ||
          upper.find("SYS_POWER") != std::string::npos ||
          upper.find("POWER METER") != std::string::npos ||
          upper.find("TOTAL_POWER") != std::string::npos;

      if (is_explicit_total) {
        if (watts > total_explicit) total_explicit = watts;
        continue;
      }
      if (has_pin) {
        sum_pin += watts;
        ++n_pin;
        continue;
      }
      if (has_pout) {
        sum_pout += watts;
        ++n_pout;
      }
    }

    double watts_total = -1.0;
    if (total_explicit >= 0.0) {
      watts_total = total_explicit;
    } else if (n_pin > 0) {
      watts_total = sum_pin;
    } else if (n_pout > 0) {
      watts_total = sum_pout;
    } else if (n_w == 1) {
      watts_total = single_watt;
    }

    if (watts_total < 0.0) {
      out.push_back(Metric{"power", "available", 0.0, "bool"});
      return true;
    }

    out.push_back(Metric{"power", "available", 1.0, "bool"});
    out.push_back(Metric{"power", "watts", watts_total, "watt"});
    out.push_back(Metric{"power", "avg_watts", watts_total, "watt"});
    out.push_back(Metric{"power", "max_watts", watts_total, "watt"});
    return true;
  }
};

}  // namespace

CollectorPtr CreatePowerCollector() {
  return std::make_unique<PowerCollector>();
}
