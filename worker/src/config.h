#pragma once

#include <string>
#include <vector>

struct WorkerConfig {
  std::string node_id;
  int interval_ms = 5000;
  std::string transport = "stdout";
  std::string transport_udp_host;
  int transport_udp_port = 9000;
  std::vector<std::string> modules = {"cpu", "memory", "load", "thermal", "power", "fan"};

  bool exec_enabled = false;
  std::string exec_bind_host = "0.0.0.0";
  int exec_port = 9100;
  std::string exec_token;
  int exec_max_output_kb = 256;
  int exec_default_timeout_s = 30;
};

bool LoadConfig(const std::string& path, WorkerConfig& config, std::string& error);
