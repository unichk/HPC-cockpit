#pragma once

#include <atomic>
#include <string>
#include <thread>

struct WorkerConfig;

// Emergency-maintenance command channel: one TCP connection per command,
// line-delimited JSON in, JSON out. See plan for wire format. Listener thread
// is boosted to SCHED_FIFO so the machine stays reachable under load.
class CommandServer {
 public:
  CommandServer() = default;
  ~CommandServer();
  CommandServer(const CommandServer&) = delete;
  CommandServer& operator=(const CommandServer&) = delete;

  bool Start(const WorkerConfig& config, std::string& error);
  void Stop();

 private:
  void AcceptLoop();
  void HandleClient(int client_fd);

  std::string token_;
  std::size_t max_output_bytes_ = 256 * 1024;
  int default_timeout_s_ = 30;
  int listen_fd_ = -1;
  std::atomic<bool> running_{false};
  std::thread accept_thread_;
};
