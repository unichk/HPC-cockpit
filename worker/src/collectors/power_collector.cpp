#include "collector.h"
#include "config.h"

#include <array>
#include <cctype>
#include <cstdio>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

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
constexpr double kSourceRedfish = 3.0;

// Wall draw / PSU output. Measured 2026-10-14 on the G494-ZB4 nodes from
// hours of paired readings: 1.02 at idle .. 1.055 under GPU load (PSU
// efficiency 0.95-0.98). Only the starting point: the collector learns the
// live ratio from SYS_POWER, see CollectRedfish().
constexpr double kInitialInputRatio = 1.035;
// Per-sample weight of the ratio's moving average. At 5 s intervals the time
// constant is ~4 min: long enough for SYS_POWER's 75 W steps to average out,
// short enough to follow the efficiency shift between idle and load.
constexpr double kRatioAlpha = 0.02;

// Run argv with `input` on its stdin and capture stdout. Used to hand curl
// its login as a config on stdin (-K -): a password on the command line would
// be readable by every user through ps / /proc/<pid>/cmdline.
bool RunWithStdin(const std::vector<std::string>& argv, const std::string& input,
                  std::string& output) {
  output.clear();
  int in_pipe[2];
  int out_pipe[2];
  if (pipe2(in_pipe, O_CLOEXEC) < 0) return false;
  if (pipe2(out_pipe, O_CLOEXEC) < 0) {
    close(in_pipe[0]); close(in_pipe[1]);
    return false;
  }
  const pid_t pid = fork();
  if (pid < 0) {
    close(in_pipe[0]); close(in_pipe[1]); close(out_pipe[0]); close(out_pipe[1]);
    return false;
  }
  if (pid == 0) {
    dup2(in_pipe[0], STDIN_FILENO);
    dup2(out_pipe[1], STDOUT_FILENO);
    const int devnull = open("/dev/null", O_WRONLY);
    if (devnull >= 0) dup2(devnull, STDERR_FILENO);
    std::vector<char*> args;
    for (const auto& a : argv) args.push_back(const_cast<char*>(a.c_str()));
    args.push_back(nullptr);
    execvp(args[0], args.data());
    _exit(127);
  }
  close(in_pipe[0]);
  close(out_pipe[1]);
  // A few dozen bytes: fits the pipe buffer, so this cannot block on curl.
  const ssize_t written = write(in_pipe[1], input.data(), input.size());
  close(in_pipe[1]);
  std::array<char, 4096> buffer{};
  ssize_t n;
  while ((n = read(out_pipe[0], buffer.data(), buffer.size())) > 0) {
    output.append(buffer.data(), static_cast<std::size_t>(n));
  }
  close(out_pipe[0]);
  int status = 0;
  waitpid(pid, &status, 0);
  return written == static_cast<ssize_t>(input.size()) && WIFEXITED(status) &&
         WEXITSTATUS(status) == 0 && !output.empty();
}

// curl config-file string syntax: backslash-escape \ and ".
std::string CurlQuote(const std::string& value) {
  std::string out = "\"";
  for (char ch : value) {
    if (ch == '\\' || ch == '"') out.push_back('\\');
    out.push_back(ch);
  }
  out.push_back('"');
  return out;
}

// Run `ipmitool lan print <ch>` and return the first non-zero IPv4 address it
// reports (same walk as the fan collector). Returns "" on failure.
std::string DiscoverBmcIp() {
  for (int ch : {1, 8, 2, 3}) {
    std::string output;
    const std::string cmd = "ipmitool lan print " + std::to_string(ch) + " 2>/dev/null";
    if (!RunCommand(cmd.c_str(), output)) continue;
    std::istringstream stream(output);
    std::string line;
    while (std::getline(stream, line)) {
      // "IP Address              : 172.16.67.11", not "IP Address Source : ..."
      const auto colon = line.find(':');
      if (line.find("IP Address ") != 0 || colon == std::string::npos) continue;
      if (line.find("Source") != std::string::npos && line.find("Source") < colon) continue;
      const std::string addr = Trim(line.substr(colon + 1));
      unsigned a = 0, b = 0, c = 0, d = 0;
      if (std::sscanf(addr.c_str(), "%u.%u.%u.%u", &a, &b, &c, &d) == 4 &&
          (a | b | c | d) != 0 && a < 256 && b < 256 && c < 256 && d < 256) {
        return addr;
      }
    }
  }
  return "";
}

// Sum every numeric "LastPowerOutputWatts" in a Redfish Power document.
// Absent PSUs report null or 0 and add nothing. Returns -1 if none parsed.
double SumPsuOutputWatts(const std::string& json) {
  const std::string key = "\"LastPowerOutputWatts\"";
  double sum = -1.0;
  std::size_t pos = 0;
  while ((pos = json.find(key, pos)) != std::string::npos) {
    pos += key.size();
    const auto colon = json.find(':', pos);
    if (colon == std::string::npos) break;
    std::size_t p = colon + 1;
    while (p < json.size() && std::isspace(static_cast<unsigned char>(json[p]))) ++p;
    const std::size_t start = p;
    while (p < json.size() &&
           (std::isdigit(static_cast<unsigned char>(json[p])) || json[p] == '.')) {
      ++p;
    }
    if (p == start) continue;  // null
    try {
      const double w = std::stod(json.substr(start, p - start));
      sum = (sum < 0.0 ? 0.0 : sum) + w;
    } catch (...) {
    }
  }
  return sum;
}

// One PSU's Redfish status, for the status wall.
struct PsuStatus {
  std::string name;
  std::string state;   // Enabled, Disabled, Absent, StandbyOffline, ...
  std::string health;  // OK, Warning, Critical, or empty when not reported
};

// Walk the "PowerSupplies" array object by object (brace depth) and pull each
// member's Name and Status.State / Status.Health.
std::vector<PsuStatus> ParsePsuStatus(const std::string& json) {
  std::vector<PsuStatus> psus;
  const auto key = json.find("\"PowerSupplies\"");
  if (key == std::string::npos) return psus;
  auto pos = json.find('[', key);
  if (pos == std::string::npos) return psus;
  static const std::regex name_re(R"re("Name"\s*:\s*"([^"]*)")re");
  static const std::regex state_re(R"re("State"\s*:\s*"([^"]*)")re");
  static const std::regex health_re(R"re("Health"\s*:\s*"([^"]*)")re");
  int depth = 0;
  std::size_t start = 0;
  bool in_string = false;
  for (std::size_t i = pos + 1; i < json.size(); ++i) {
    const char c = json[i];
    if (in_string) {
      if (c == '\\') ++i;
      else if (c == '"') in_string = false;
      continue;
    }
    if (c == '"') {
      in_string = true;
    } else if (c == '{') {
      if (depth++ == 0) start = i;
    } else if (c == '}') {
      if (--depth == 0) {
        const std::string obj = json.substr(start, i - start + 1);
        PsuStatus p;
        std::smatch m;
        if (std::regex_search(obj, m, name_re)) p.name = m[1].str();
        if (std::regex_search(obj, m, state_re)) p.state = m[1].str();
        if (std::regex_search(obj, m, health_re)) p.health = m[1].str();
        if (p.name.empty()) p.name = "PSU" + std::to_string(psus.size());
        psus.push_back(p);
      }
    } else if (c == ']' && depth == 0) {
      break;
    }
  }
  return psus;
}

class PowerCollector : public Collector {
 public:
  explicit PowerCollector(const WorkerConfig& config)
      : bmc_user_(config.bmc_user), bmc_password_(config.bmc_password) {}

  std::string Name() const override { return "power"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
    std::vector<Metric> dcmi;
    const bool have_dcmi = CollectDcmi(dcmi);
    if (CollectRedfish(have_dcmi, out)) {
      last_available_ = true;
      return true;
    }
    if (have_dcmi) {
      out.insert(out.end(), dcmi.begin(), dcmi.end());
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
  // Preferred source when a BMC login is configured. SYS_POWER/DCMI is an
  // 8-bit IPMI sensor scaled by 75 W (255 x 75 W spans the four 3.7 kW PSUs),
  // so it moves in 75 W steps. Redfish meters each PSU's output to the watt.
  // Output is not wall draw, though: it is short by the PSU loss, 2-5%, i.e.
  // 35-220 W per node. So the reported power is output x (input/output),
  // with that ratio learned from SYS_POWER: one sample is +-37 W of rounding,
  // but averaged over minutes the steps cancel and the ratio is accurate.
  // The result is SYS_POWER's level with Redfish's resolution.
  bool CollectRedfish(bool have_dcmi, std::vector<Metric>& out) {
    if (bmc_password_.empty()) {
      return false;
    }
    if (bmc_ip_.empty()) {
      bmc_ip_ = DiscoverBmcIp();
      if (bmc_ip_.empty()) {
        return false;
      }
    }
    // AMI MegaRAC names its one chassis "Self".
    std::string payload;
    if (!RunWithStdin({"curl", "-sk", "--connect-timeout", "2", "--max-time", "4", "-K", "-",
                       "https://" + bmc_ip_ + "/redfish/v1/Chassis/Self/Power"},
                      "user = " + CurlQuote(bmc_user_ + ":" + bmc_password_) + "\n", payload)) {
      out.push_back(Metric{"health", "bmc:redfish", 1.0, "status",
                           "BMC " + bmc_ip_ + ": Redfish not responding; power falls back to DCMI"});
      return false;
    }
    const double out_w = SumPsuOutputWatts(payload);
    if (out_w <= 0.0) {
      out.push_back(Metric{"health", "bmc:redfish", 1.0, "status",
                           "BMC " + bmc_ip_ + ": Redfish answered without PSU readings"});
      return false;
    }
    EmitPsuHealth(payload, out);

    // last_watts_ is the DCMI reading CollectDcmi() just accepted. The two
    // readings are not taken at the same instant, so a ratio outside 0.9-1.2
    // is a glitch and is dropped; smaller mismatches during a load step
    // average out like the rounding does.
    if (have_dcmi && last_watts_ > 100.0) {
      const double r = last_watts_ / out_w;
      if (r > 0.9 && r < 1.2) {
        input_ratio_ += (r - input_ratio_) * kRatioAlpha;
      }
    }
    const double watts = out_w * input_ratio_;

    out.push_back(Metric{"power", "available", 1.0, "bool"});
    out.push_back(Metric{"power", "source_code", kSourceRedfish, "enum"});
    out.push_back(Metric{"power", "watts", watts, "watt"});
    out.push_back(Metric{"power", "min_watts", watts, "watt"});
    out.push_back(Metric{"power", "avg_watts", watts, "watt"});
    out.push_back(Metric{"power", "max_watts", watts, "watt"});
    out.push_back(Metric{"power", "psu_output_watts", out_w, "watt"});
    out.push_back(Metric{"power", "input_ratio", input_ratio_, "ratio"});
    if (have_dcmi) {
      out.push_back(Metric{"power", "sensor_watts", last_watts_, "watt"});
    }
    return true;
  }

  // Status-wall lights for the BMC and each PSU. A PSU that is switched off
  // (scc01-04 all run PSU1 Disabled, two nodes with only two PSUs) is shown
  // as OK with its state spelled out: it is the configured layout, not a
  // fault. Only the PSU's own Health marks it warning or failed.
  void EmitPsuHealth(const std::string& payload, std::vector<Metric>& out) const {
    out.push_back(Metric{"health", "bmc:redfish", 0.0, "status",
                         "BMC " + bmc_ip_ + ": Redfish OK"});
    for (const PsuStatus& p : ParsePsuStatus(payload)) {
      double status = 0.0;
      if (p.health == "Warning") status = 1.0;
      else if (p.health == "Critical") status = 2.0;
      std::string text = p.name + ": " + (p.state.empty() ? "state unknown" : p.state);
      if (!p.health.empty()) text += ", health " + p.health;
      out.push_back(Metric{"health", "bmc:" + p.name, status, "status", text});
    }
  }

  // DCMI reports true whole-system input power along with
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

    // The instantaneous register can glitch too, not just the min/max/avg
    // window below. A reading that jumps several-fold in one interval is
    // almost certainly bad -- a chassis already drawing hundreds of watts
    // cannot multiply its draw between two ticks -- so cross-check it against
    // the SYS_POWER analogue sensor, which is measured independently of DCMI.
    // The extra IPMI call only happens on suspicion, so it costs nothing in
    // the normal case.
    if (last_watts_ > 100.0 && watts > last_watts_ * 4.0 && watts - last_watts_ > 1500.0) {
      double sensor_watts = 0.0;
      if (ReadSysPowerSensor(sensor_watts) && sensor_watts > 0.0) {
        const double diff = watts > sensor_watts ? watts - sensor_watts : sensor_watts - watts;
        if (diff > sensor_watts * 0.25) {
          // The two disagree by more than a quarter: trust the sensor.
          out.push_back(Metric{"power", "reading_rejected", 1.0, "bool"});
          watts = sensor_watts;
        }
      }
    }
    last_watts_ = watts;

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

  // Read the whole-system wattage from the analogue sensor rows. Used only to
  // arbitrate a suspicious DCMI reading; it is a different measurement path
  // inside the BMC, so the two agreeing is meaningful.
  static bool ReadSysPowerSensor(double& watts) {
    std::string payload;
    if (!RunCommand("timeout 5s ipmitool sdr type Current 2>/dev/null", payload)) {
      return false;
    }
    std::istringstream stream(payload);
    std::string line;
    while (std::getline(stream, line)) {
      const auto fields = SplitPipe(line);
      if (fields.size() < 5) {
        continue;
      }
      if (ToUpper(fields[4]).find("WATT") == std::string::npos) {
        continue;
      }
      try {
        watts = std::stod(fields[4]);
      } catch (...) {
        continue;
      }
      return true;
    }
    return false;
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
  // Last accepted instantaneous reading, for the jump check above.
  double last_watts_ = 0.0;
  std::string bmc_user_;
  std::string bmc_password_;
  std::string bmc_ip_;
  double input_ratio_ = kInitialInputRatio;
};

}  // namespace

CollectorPtr CreatePowerCollector(const WorkerConfig& config) {
  return std::make_unique<PowerCollector>(config);
}
