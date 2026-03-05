#include "config.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>

namespace {

std::string Trim(const std::string& input) {
  std::size_t start = 0;
  while (start < input.size() && std::isspace(static_cast<unsigned char>(input[start]))) {
    ++start;
  }
  std::size_t end = input.size();
  while (end > start && std::isspace(static_cast<unsigned char>(input[end - 1]))) {
    --end;
  }
  return input.substr(start, end - start);
}

std::vector<std::string> SplitCsv(const std::string& csv) {
  std::vector<std::string> values;
  std::stringstream ss(csv);
  std::string item;
  while (std::getline(ss, item, ',')) {
    std::string trimmed = Trim(item);
    if (!trimmed.empty()) {
      values.push_back(trimmed);
    }
  }
  return values;
}

}  // namespace

bool LoadConfig(const std::string& path, WorkerConfig& config, std::string& error) {
  std::ifstream in(path);
  if (!in.is_open()) {
    error = "unable to open config file: " + path;
    return false;
  }

  std::string line;
  int line_no = 0;
  while (std::getline(in, line)) {
    ++line_no;
    std::string trimmed = Trim(line);
    if (trimmed.empty() || trimmed[0] == '#') {
      continue;
    }

    const auto eq = trimmed.find('=');
    if (eq == std::string::npos) {
      error = "invalid config line " + std::to_string(line_no) + ": " + trimmed;
      return false;
    }

    const std::string key = Trim(trimmed.substr(0, eq));
    const std::string value = Trim(trimmed.substr(eq + 1));

    if (key == "node_id") {
      config.node_id = value;
    } else if (key == "interval_ms") {
      try {
        config.interval_ms = std::stoi(value);
      } catch (...) {
        error = "invalid interval_ms at line " + std::to_string(line_no);
        return false;
      }
    } else if (key == "transport") {
      config.transport = value;
    } else if (key == "modules") {
      config.modules = SplitCsv(value);
    } else {
      error = "unknown config key at line " + std::to_string(line_no) + ": " + key;
      return false;
    }
  }

  if (config.interval_ms <= 0) {
    error = "interval_ms must be > 0";
    return false;
  }
  if (config.modules.empty()) {
    error = "modules cannot be empty";
    return false;
  }
  return true;
}
