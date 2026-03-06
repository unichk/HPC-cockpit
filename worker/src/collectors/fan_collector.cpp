#include "collector.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <numeric>
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

class FanCollector : public Collector {
 public:
  std::string Name() const override { return "fan"; }

  bool Collect(std::vector<Metric>& out, std::string& error) override {
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
      if (line.find("RPM") == std::string::npos) {
        continue;
      }

      std::smatch match;
      if (!std::regex_search(line, match, rpm_regex)) {
        continue;
      }
      const double rpm = std::stod(match[1].str());

      std::string sensor_raw_name;
      const auto fields = SplitPipe(line);
      if (fields.size() >= 2 && IsAllDigits(fields[0])) {
        sensor_raw_name = fields[1];
      } else if (!fields.empty()) {
        sensor_raw_name = fields[0];
      } else {
        sensor_raw_name = "fan_" + std::to_string(++fallback_index);
      }

      const std::string sensor_name = SanitizeName(sensor_raw_name);
      out.push_back(Metric{"fan", sensor_name + "_rpm", rpm, "rpm"});
      rpms.push_back(rpm);
      if (line.find("Nominal") != std::string::npos || line.find("OK") != std::string::npos ||
          line.find("| ok |") != std::string::npos) {
        ++ok_count;
      }
    }

    if (rpms.empty()) {
      out.push_back(Metric{"fan", "available", 0.0, "bool"});
      if (last_available_) {
        error = "ipmitool returned no RPM fan sensors";
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
  bool last_available_ = true;
};

}  // namespace

CollectorPtr CreateFanCollector() {
  return std::make_unique<FanCollector>();
}
