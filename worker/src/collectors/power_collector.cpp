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

// Find `key` in `payload`, then parse the first number appearing after the
// following ':'. DCMI output is not reliably one-field-per-line — ipmitool
// prints the timestamp and sampling period on the same physical line — so we
// scan the whole payload by key rather than iterating lines.
bool ValueAfterKey(const std::string& payload, const std::string& key, double& out) {
  const auto key_pos = payload.find(key);
  if (key_pos == std::string::npos) {
    return false;
  }
  const auto colon = payload.find(':', key_pos + key.size());
  if (colon == std::string::npos) {
    return false;
  }
  std::size_t pos = colon + 1;
  while (pos < payload.size() && std::isspace(static_cast<unsigned char>(payload[pos]))) {
    ++pos;
  }
  const std::size_t start = pos;
  while (pos < payload.size() &&
         (std::isdigit(static_cast<unsigned char>(payload[pos])) || payload[pos] == '.')) {
    ++pos;
  }
  if (pos == start) {
    return false;
  }
  try {
    out = std::stod(payload.substr(start, pos - start));
  } catch (...) {
    return false;
  }
  return out >= 0.0;
}

// Source of the reading, reported as power.source_code so the UI can tell a
// true whole-system DCMI reading from a scraped sensor row.
constexpr double kSourceDcmi = 1.0;
constexpr double kSourceSdr = 2.0;

class PowerCollector : public Collector {
 public:
  std::string Name() const override { return "power"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
    if (CollectDcmi(out)) {
      last_available_ = true;
      return true;
    }
    if (CollectSdr(out)) {
      last_available_ = true;
      return true;
    }

    out.push_back(Metric{"power", "available", 0.0, "bool"});
    if (last_available_) {
      error =
          "no IPMI power reading (tried 'ipmitool dcmi power reading' and "
          "'ipmitool sdr type Current'); check ipmitool is installed and the "
          "worker can open /dev/ipmi0";
      last_available_ = false;
      return false;
    }
    return true;
  }

 private:
  // Preferred source. DCMI reports true whole-system input power along with
  // the BMC's own min/max/average over its rolling sampling window, which is
  // strictly better than differentiating a single instantaneous sensor row.
  bool CollectDcmi(std::vector<Metric>& out) {
    std::string payload;
    if (!RunCommand("timeout 5s ipmitool dcmi power reading 2>/dev/null", payload)) {
      return false;
    }
    // A BMC that supports the command but has metering switched off still
    // exits 0, printing a zeroed block with "Power reading state is: deactivated".
    if (payload.find("deactivated") != std::string::npos) {
      return false;
    }

    double watts = 0.0;
    if (!ValueAfterKey(payload, "Instantaneous power reading", watts)) {
      return false;
    }

    double min_watts = watts;
    double max_watts = watts;
    double avg_watts = watts;
    ValueAfterKey(payload, "Minimum during sampling period", min_watts);
    ValueAfterKey(payload, "Maximum during sampling period", max_watts);
    ValueAfterKey(payload, "Average power reading over sample period", avg_watts);

    // The BMC's rolling statistics registers are not always trustworthy. On a
    // Giga Computing G494-ZB4 they were seen reporting max = avg = 19125 W
    // while the instantaneous reading and the SYS_POWER sensor both said
    // 2325 W -- 8x the real draw, and more than the chassis could physically
    // pull. `avg` exactly equalling `max` while `min` exactly equalled the
    // instantaneous reading is the signature of registers that never updated,
    // so the values are self-consistent and an ordering check alone will not
    // catch it.
    //
    // Reject the window instead when it is implausible against the
    // instantaneous reading. Over a 5-second window a server already drawing
    // hundreds of watts cannot swing by 4x, and requiring an absolute gap too
    // avoids over-rejecting a genuine burst on a near-idle node.
    const double reference = watts > 100.0 ? watts : 100.0;
    const bool ordered = min_watts <= avg_watts && avg_watts <= max_watts;
    const bool plausible = max_watts <= reference * 4.0 || max_watts - watts <= 1500.0;
    if (!ordered || !plausible) {
      min_watts = watts;
      avg_watts = watts;
      max_watts = watts;
      out.push_back(Metric{"power", "window_rejected", 1.0, "bool"});
    }

    out.push_back(Metric{"power", "available", 1.0, "bool"});
    out.push_back(Metric{"power", "source_code", kSourceDcmi, "enum"});
    out.push_back(Metric{"power", "watts", watts, "watt"});
    out.push_back(Metric{"power", "min_watts", min_watts, "watt"});
    out.push_back(Metric{"power", "avg_watts", avg_watts, "watt"});
    out.push_back(Metric{"power", "max_watts", max_watts, "watt"});

    double period_s = 0.0;
    if (ValueAfterKey(payload, "Sampling period", period_s)) {
      out.push_back(Metric{"power", "sample_period_s", period_s, "second"});
    }
    return true;
  }

  // Fallback for BMCs without DCMI. Scan the analogue sensor rows for a
  // wattage reading. `sdr type Current` is where whole-system power lands on
  // the boards we've seen (Gigabyte "SYS_POWER", ASRock/AMI "Total_Power",
  // Dell "Pwr Consumption"); "Power Supply" carries per-PSU PIN/POUT rows.
  // Priority: explicit system total > sum of per-PSU input > sum of per-PSU
  // output > the single wattage row on the box.
  bool CollectSdr(std::vector<Metric>& out) {
    std::string payload;
    std::string chunk;
    if (RunCommand("timeout 5s ipmitool sdr type Current 2>/dev/null", chunk)) {
      payload += chunk;
    }
    if (RunCommand("timeout 5s ipmitool sdr type 'Power Supply' 2>/dev/null", chunk)) {
      payload += chunk;
    }
    if (payload.empty()) {
      return false;
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
      // Layout: "NAME | 08h | ok | 19.1 | 1200 Watts"
      const auto fields = SplitPipe(line);
      if (fields.size() < 5) {
        continue;
      }
      const std::string reading = ToUpper(fields[4]);
      if (reading.find("WATT") == std::string::npos) {
        continue;
      }
      double watts = 0.0;
      try {
        watts = std::stod(fields[4]);
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
      const bool has_power_word = upper.find("POWER") != std::string::npos ||
                                  upper.find("WATT") != std::string::npos ||
                                  upper.find("PWR") != std::string::npos;

      const bool is_explicit_total =
          (has_total && (has_pin || has_power_word)) ||
          upper.find("SYS_POWER") != std::string::npos ||
          upper.find("SYS POWER") != std::string::npos ||
          upper.find("SYSTEM POWER") != std::string::npos ||
          upper.find("PWR CONSUMPTION") != std::string::npos ||
          upper.find("POWER METER") != std::string::npos;

      if (is_explicit_total) {
        if (watts > total_explicit) {
          total_explicit = watts;
        }
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
      return false;
    }

    // A sensor row is a point sample: there is no window to take min/max over,
    // so all three carry the same value.
    out.push_back(Metric{"power", "available", 1.0, "bool"});
    out.push_back(Metric{"power", "source_code", kSourceSdr, "enum"});
    out.push_back(Metric{"power", "watts", watts_total, "watt"});
    out.push_back(Metric{"power", "min_watts", watts_total, "watt"});
    out.push_back(Metric{"power", "avg_watts", watts_total, "watt"});
    out.push_back(Metric{"power", "max_watts", watts_total, "watt"});
    return true;
  }

  bool last_available_ = true;
};

}  // namespace

CollectorPtr CreatePowerCollector() {
  return std::make_unique<PowerCollector>();
}
