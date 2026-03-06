#pragma once

#include <string>
#include <vector>

struct WorkerConfig {
  std::string node_id;
  int interval_ms = 5000;
  std::string transport = "stdout";
  std::string transport_udp_host;
  int transport_udp_port = 9000;
  std::vector<std::string> modules = {"cpu", "memory", "load"};
};

bool LoadConfig(const std::string& path, WorkerConfig& config, std::string& error);
