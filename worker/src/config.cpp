#include "config.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>
#include <unistd.h>

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

std::string DetectHostname() {
  char hostname[256];
  if (gethostname(hostname, sizeof(hostname)) != 0) {
    return "unknown-node";
  }
  hostname[sizeof(hostname) - 1] = '\0';
  if (hostname[0] == '\0') {
    return "unknown-node";
  }
  return std::string(hostname);
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
    } else if (key == "transport_udp_host") {
      config.transport_udp_host = value;
    } else if (key == "transport_udp_port") {
      try {
        config.transport_udp_port = std::stoi(value);
      } catch (...) {
        error = "invalid transport_udp_port at line " + std::to_string(line_no);
        return false;
      }
    } else if (key == "modules") {
      config.modules = SplitCsv(value);
    } else if (key == "exec_enabled") {
      std::string v = value;
      std::transform(v.begin(), v.end(), v.begin(), [](unsigned char c) { return std::tolower(c); });
      config.exec_enabled = (v == "1" || v == "true" || v == "yes" || v == "on");
    } else if (key == "exec_bind_host") {
      config.exec_bind_host = value;
    } else if (key == "exec_port") {
      try {
        config.exec_port = std::stoi(value);
      } catch (...) {
        error = "invalid exec_port at line " + std::to_string(line_no);
        return false;
      }
    } else if (key == "exec_token") {
      config.exec_token = value;
    } else if (key == "exec_max_output_kb") {
      try {
        config.exec_max_output_kb = std::stoi(value);
      } catch (...) {
        error = "invalid exec_max_output_kb at line " + std::to_string(line_no);
        return false;
      }
    } else if (key == "exec_default_timeout_s") {
      try {
        config.exec_default_timeout_s = std::stoi(value);
      } catch (...) {
        error = "invalid exec_default_timeout_s at line " + std::to_string(line_no);
        return false;
      }
    } else if (key == "bmc_user") {
      config.bmc_user = value;
    } else if (key == "bmc_password") {
      config.bmc_password = value;
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
  if (config.transport_udp_port <= 0 || config.transport_udp_port > 65535) {
    error = "transport_udp_port must be between 1 and 65535";
    return false;
  }
  if (config.exec_port <= 0 || config.exec_port > 65535) {
    error = "exec_port must be between 1 and 65535";
    return false;
  }
  if (config.exec_max_output_kb < 1 || config.exec_max_output_kb > 4096) {
    error = "exec_max_output_kb must be between 1 and 4096";
    return false;
  }
  if (config.exec_default_timeout_s < 1 || config.exec_default_timeout_s > 300) {
    error = "exec_default_timeout_s must be between 1 and 300";
    return false;
  }
  if (config.node_id.empty()) {
    config.node_id = DetectHostname();
  }
  return true;
}
