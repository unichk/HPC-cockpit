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

class PowerCollector : public Collector {
 public:
  std::string Name() const override { return "power"; }

  bool Collect(std::vector<Metric>& out, std::string& /*error*/) override {
    std::string payload;
    if (!RunCommand("ipmi-sensors --sensor-type=\"Power Supply\" 2>/dev/null", payload)) {
      out.push_back(Metric{"power", "available", 0.0, "bool"});
      return true;
    }

    // Expected line: "78 | PSU PIN TOTAL | Power Supply | 165.00 | W | 'OK'"
    double watts = -1.0;
    std::istringstream stream(payload);
    std::string line;
    while (std::getline(stream, line)) {
      const auto fields = SplitPipe(line);
      if (fields.size() < 5) {
        continue;
      }
      if (fields[1] != "PSU PIN TOTAL") {
        continue;
      }
      if (fields[4] != "W") {
        continue;
      }
      try {
        watts = std::stod(fields[3]);
        break;
      } catch (...) {
        continue;
      }
    }

    if (watts < 0.0) {
      out.push_back(Metric{"power", "available", 0.0, "bool"});
      return true;
    }

    out.push_back(Metric{"power", "available", 1.0, "bool"});
    out.push_back(Metric{"power", "watts", watts, "watt"});
    out.push_back(Metric{"power", "avg_watts", watts, "watt"});
    out.push_back(Metric{"power", "max_watts", watts, "watt"});
    return true;
  }
};

}  // namespace

CollectorPtr CreatePowerCollector() {
  return std::make_unique<PowerCollector>();
}
