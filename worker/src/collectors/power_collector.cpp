#include "collector.h"

#include <algorithm>
#include <array>
#include <cstdio>
#include <numeric>
#include <regex>
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

class PowerCollector : public Collector {
 public:
  std::string Name() const override { return "power"; }

  bool Collect(std::vector<Metric>& out, std::string& /*error*/) override {
    std::string payload;
    if (!RunCommand("timeout 2s sensors 2>/dev/null", payload)) {
      out.push_back(Metric{"power", "available", 0.0, "bool"});
      return true;
    }

    const std::regex watts_regex(R"(power[0-9]+:\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s*W)");
    std::istringstream stream(payload);
    std::string line;
    std::vector<double> readings;
    while (std::getline(stream, line)) {
      std::smatch match;
      if (!std::regex_search(line, match, watts_regex)) {
        continue;
      }
      readings.push_back(std::stod(match[1].str()));
    }

    if (readings.empty()) {
      out.push_back(Metric{"power", "available", 0.0, "bool"});
      return true;
    }

    const double sum = std::accumulate(readings.begin(), readings.end(), 0.0);
    const double max = *std::max_element(readings.begin(), readings.end());
    const double avg = sum / static_cast<double>(readings.size());

    out.push_back(Metric{"power", "available", 1.0, "bool"});
    out.push_back(Metric{"power", "watts", sum, "watt"});
    out.push_back(Metric{"power", "max_watts", max, "watt"});
    out.push_back(Metric{"power", "avg_watts", avg, "watt"});
    out.push_back(Metric{"power", "sensor_count", static_cast<double>(readings.size()), "count"});
    return true;
  }
};

}  // namespace

CollectorPtr CreatePowerCollector() {
  return std::make_unique<PowerCollector>();
}
