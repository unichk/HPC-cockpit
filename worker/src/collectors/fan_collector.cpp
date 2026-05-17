#include "collector.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <numeric>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace {

// DMI chassis vendor → numeric code. Mirrors FAN_VENDOR_NAMES in
// server/web/live-data.js; the UI uses the code to pick which IPMI OEM
// opcodes to send from FAN_CMDS in node.html.
//
// Code 5 ("redfish") is special: it's not a hardware vendor but a fallback
// path for ODM whitebox boards that don't fill DMI strings (sys_vendor reads
// "NULL") but expose an AMI MegaRAC-style Redfish endpoint at
// /redfish/v1/Chassis/1/Thermal with a writable Oem.Public.FanControlMode.
// Detected by probing the BMC LAN IP for a 200/401 response (401 means
// "exists but needs auth" — exactly what we want; the UI sends auth itself).
int DetectDmiFanVendor() {
  std::ifstream in("/sys/class/dmi/id/sys_vendor");
  if (!in.is_open()) return 0;
  std::string line;
  std::getline(in, line);
  std::string lower;
  lower.reserve(line.size());
  for (char ch : line) lower.push_back(std::tolower(static_cast<unsigned char>(ch)));
  if (lower.find("supermicro") != std::string::npos) return 1;
  if (lower.find("dell") != std::string::npos) return 2;
  if (lower.find("hpe") != std::string::npos ||
      lower.find("hewlett packard") != std::string::npos) return 3;
  if (lower.find("inventec") != std::string::npos) return 4;
  return 0;
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
  pclose(pipe);
  return !output.empty();
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

bool IsAllDigits(const std::string& value) {
  if (value.empty()) {
    return false;
  }
  for (const char ch : value) {
    if (!std::isdigit(static_cast<unsigned char>(ch))) {
      return false;
    }
  }
  return true;
}

bool ParseLeadingDouble(const std::string& value, double& out_value) {
  std::stringstream stream(value);
  stream >> out_value;
  if (!stream.good() && !stream.eof()) {
    return false;
  }
  return true;
}

std::string SanitizeName(const std::string& value) {
  std::string clean;
  clean.reserve(value.size());
  for (const char ch : value) {
    if (std::isalnum(static_cast<unsigned char>(ch))) {
      clean.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
    } else if (ch == ' ' || ch == '-' || ch == '_') {
      clean.push_back('_');
    }
  }
  while (!clean.empty() && clean.front() == '_') {
    clean.erase(clean.begin());
  }
  while (!clean.empty() && clean.back() == '_') {
    clean.pop_back();
  }
  if (clean.empty()) {
    clean = "fan";
  }
  return clean;
}

// Run `ipmitool lan print <ch>` and return the first non-zero IPv4 address it
// reports. AMI MegaRAC BMCs typically expose the dedicated management port as
// channel 1 (static IP) and a shared NCSI port as channel 8 (DHCP) — we walk
// both and prefer the first reachable one. Returns "" on failure.
std::string DiscoverBmcIp() {
  for (int ch : {1, 8, 2, 3}) {
    std::string output;
    const std::string cmd = "ipmitool lan print " + std::to_string(ch) + " 2>/dev/null";
    if (!RunCommand(cmd.c_str(), output)) continue;
    std::istringstream stream(output);
    std::string line;
    while (std::getline(stream, line)) {
      // The line we want is "IP Address              : 10.16.120.101"
      // with several spaces between "Address" and ":". The "Source" line
      // ("IP Address Source : DHCP Address") is *not* what we want — match
      // on "IP Address " followed by enough spaces to distinguish.
      const auto pos = line.find("IP Address ");
      if (pos == std::string::npos) continue;
      // Reject "IP Address Source:" line (contains "Source" before colon).
      if (line.find("Source") != std::string::npos &&
          line.find("Source") < line.find(':')) continue;
      const auto colon = line.find(':');
      if (colon == std::string::npos) continue;
      const std::string addr = Trim(line.substr(colon + 1));
      // Accept anything that parses as a non-zero IPv4.
      unsigned a = 0, b = 0, c = 0, d = 0;
      if (std::sscanf(addr.c_str(), "%u.%u.%u.%u", &a, &b, &c, &d) == 4 &&
          (a | b | c | d) != 0 && a < 256 && b < 256 && c < 256 && d < 256) {
        return addr;
      }
    }
  }
  return "";
}

// Pack dotted IPv4 into a single 32-bit integer (10.16.120.101 → 0x0A107865).
// JS decodes via [(n>>>24)&255, (n>>>16)&255, (n>>>8)&255, n&255].join('.').
double Ipv4ToPacked(const std::string& addr) {
  unsigned a = 0, b = 0, c = 0, d = 0;
  if (std::sscanf(addr.c_str(), "%u.%u.%u.%u", &a, &b, &c, &d) != 4) return 0.0;
  // Use unsigned long long arithmetic to avoid the high bit of a*2^24 going
  // negative on signed int multiplication.
  const unsigned long long packed = (static_cast<unsigned long long>(a) << 24) |
                                    (static_cast<unsigned long long>(b) << 16) |
                                    (static_cast<unsigned long long>(c) << 8)  |
                                     static_cast<unsigned long long>(d);
  return static_cast<double>(packed);
}

// Probe whether the BMC at `ip` exposes an AMI MegaRAC-style Redfish Thermal
// resource. We don't authenticate — the goal is just to confirm reachability.
// HTTP 401 ("unauthorized") is the success signal: the endpoint exists and
// expects credentials, which the UI supplies at PATCH time. HTTP 200 (some
// firmware leaves it unauth-readable) also counts. Any other response or a
// curl failure means "no Redfish here".
bool ProbeRedfish(const std::string& ip) {
  if (ip.empty()) return false;
  std::string output;
  const std::string cmd =
      "curl --connect-timeout 3 --max-time 5 -sk -o /dev/null "
      "-w '%{http_code}' https://" + ip + "/redfish/v1/Chassis/1/Thermal "
      "2>/dev/null";
  if (!RunCommand(cmd.c_str(), output)) return false;
  const std::string code = Trim(output);
  return code == "401" || code == "200";
}

class FanCollector : public Collector {
 public:
  std::string Name() const override { return "fan"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
    out.push_back(Metric{"fan", "vendor_code", static_cast<double>(vendor_code_), "enum"});
    if (bmc_ipv4_packed_ > 0.0) {
      // 32-bit packed IPv4 (big-endian). UI decodes:
      //   const a = (n>>>24)&255, b = (n>>>16)&255, c = (n>>>8)&255, d = n&255
      // and uses it as the Redfish base URL.
      out.push_back(Metric{"fan", "bmc_ipv4_packed", bmc_ipv4_packed_, "uint32"});
    }

    std::string payload;
    if (!RunCommand("ipmi-sensors --sensor-type=Fan 2>&1", payload)) {
      out.push_back(Metric{"fan", "available", 0.0, "bool"});
      if (last_available_) {
        error = "ipmi-sensors fan query failed (missing tool/permission). cmd='ipmi-sensors --sensor-type=Fan'";
        last_available_ = false;
        return false;
      }
      return true;
    }

    std::istringstream stream(payload);
    std::string line;
    std::vector<double> rpms;
    int ok_count = 0;
    const std::regex rpm_regex(R"(([0-9]+(?:\.[0-9]+)?)\s*RPM)");
    int fallback_index = 0;

    while (std::getline(stream, line)) {
      std::string sensor_raw_name;
      const auto fields = SplitPipe(line);
      double rpm = 0.0;

      if (fields.size() >= 5) {
        if (!(IsAllDigits(fields[0]) && fields[4] == "RPM" && ParseLeadingDouble(fields[3], rpm))) {
          continue;
        }
        sensor_raw_name = fields[1];
      } else {
        if (line.find("RPM") == std::string::npos) {
          continue;
        }
        std::smatch match;
        if (!std::regex_search(line, match, rpm_regex)) {
          continue;
        }
        rpm = std::stod(match[1].str());
        if (!fields.empty()) {
          sensor_raw_name = fields[0];
        } else {
          sensor_raw_name = "fan_" + std::to_string(++fallback_index);
        }
      }

      const std::string sensor_name = SanitizeName(sensor_raw_name);
      out.push_back(Metric{"fan", sensor_name + "_rpm", rpm, "rpm"});
      rpms.push_back(rpm);
      if (line.find("Nominal") != std::string::npos || line.find("Normal") != std::string::npos ||
          line.find("Good") != std::string::npos || line.find("OK") != std::string::npos ||
          line.find("| ok |") != std::string::npos) {
        ++ok_count;
      }
    }

    if (rpms.empty()) {
      out.push_back(Metric{"fan", "available", 0.0, "bool"});
      if (last_available_) {
        error = "ipmi-sensors returned no RPM fan sensors";
        last_available_ = false;
        return false;
      }
      return true;
    }

    const double sum = std::accumulate(rpms.begin(), rpms.end(), 0.0);
    const double min_rpm = *std::min_element(rpms.begin(), rpms.end());
    const double max_rpm = *std::max_element(rpms.begin(), rpms.end());
    const double avg_rpm = sum / static_cast<double>(rpms.size());

    out.push_back(Metric{"fan", "available", 1.0, "bool"});
    out.push_back(Metric{"fan", "count", static_cast<double>(rpms.size()), "count"});
    out.push_back(Metric{"fan", "ok_count", static_cast<double>(ok_count), "count"});
    out.push_back(Metric{"fan", "min_rpm", min_rpm, "rpm"});
    out.push_back(Metric{"fan", "max_rpm", max_rpm, "rpm"});
    out.push_back(Metric{"fan", "avg_rpm", avg_rpm, "rpm"});
    last_available_ = true;
    return true;
  }

 private:
  // Run BMC discovery once at construction (each call shells out to ipmitool +
  // curl, so we don't want to repeat on every collect). The result is reported
  // verbatim in every Collect() so the UI always has it.
  static int DetectVendor(const std::string& bmc_ip) {
    const int dmi = DetectDmiFanVendor();
    if (dmi != 0) return dmi;
    if (ProbeRedfish(bmc_ip)) return 5;  // redfish fallback
    return 0;
  }

  bool last_available_ = true;
  std::string bmc_ip_ = DiscoverBmcIp();
  double bmc_ipv4_packed_ = Ipv4ToPacked(bmc_ip_);
  int vendor_code_ = DetectVendor(bmc_ip_);
};

}  // namespace

CollectorPtr CreateFanCollector() {
  return std::make_unique<FanCollector>();
}
