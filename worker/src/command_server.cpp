#include "command_server.h"
#include "config.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>

namespace {

std::string EscapeJson(const std::string& input) {
  std::string out;
  out.reserve(input.size() + 16);
  for (unsigned char c : input) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b";  break;
      case '\f': out += "\\f";  break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  return out;
}

bool ParseJsonString(const std::string& json, std::size_t& pos, std::string& out) {
  if (pos >= json.size() || json[pos] != '"') return false;
  ++pos;
  out.clear();
  while (pos < json.size()) {
    char c = json[pos++];
    if (c == '"') return true;
    if (c == '\\' && pos < json.size()) {
      char esc = json[pos++];
      switch (esc) {
        case '"':  out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/':  out.push_back('/'); break;
        case 'b':  out.push_back('\b'); break;
        case 'f':  out.push_back('\f'); break;
        case 'n':  out.push_back('\n'); break;
        case 'r':  out.push_back('\r'); break;
        case 't':  out.push_back('\t'); break;
        case 'u': {
          if (pos + 4 > json.size()) return false;
          unsigned code = 0;
          for (int i = 0; i < 4; ++i) {
            char h = json[pos++];
            code <<= 4;
            if (h >= '0' && h <= '9') code |= (h - '0');
            else if (h >= 'a' && h <= 'f') code |= (h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') code |= (h - 'A' + 10);
            else return false;
          }
          if (code < 0x80) {
            out.push_back(static_cast<char>(code));
          } else if (code < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (code >> 6)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
          } else {
            out.push_back(static_cast<char>(0xE0 | (code >> 12)));
            out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
          }
          break;
        }
        default: return false;
      }
    } else {
      out.push_back(c);
    }
  }
  return false;
}

bool FindKeyValueStart(const std::string& json, const std::string& key, std::size_t& out_pos) {
  const std::string needle = "\"" + key + "\"";
  std::size_t p = 0;
  while (p < json.size()) {
    p = json.find(needle, p);
    if (p == std::string::npos) return false;
    std::size_t q = p + needle.size();
    while (q < json.size() && std::isspace(static_cast<unsigned char>(json[q]))) ++q;
    if (q < json.size() && json[q] == ':') {
      ++q;
      while (q < json.size() && std::isspace(static_cast<unsigned char>(json[q]))) ++q;
      out_pos = q;
      return true;
    }
    ++p;
  }
  return false;
}

struct ParsedRequest {
  std::string token;
  std::string cmd;
  int timeout_s = -1;
};

bool ParseRequest(const std::string& json, ParsedRequest& req, std::string& error) {
  std::size_t p = 0;
  if (FindKeyValueStart(json, "token", p)) {
    if (!ParseJsonString(json, p, req.token)) {
      error = "token_not_string";
      return false;
    }
  }
  if (!FindKeyValueStart(json, "cmd", p)) {
    error = "cmd_missing";
    return false;
  }
  if (!ParseJsonString(json, p, req.cmd)) {
    error = "cmd_not_string";
    return false;
  }
  if (FindKeyValueStart(json, "timeout_s", p)) {
    std::size_t end = p;
    if (end < json.size() && json[end] == '-') ++end;
    while (end < json.size() && std::isdigit(static_cast<unsigned char>(json[end]))) ++end;
    if (end > p) {
      try { req.timeout_s = std::stoi(json.substr(p, end - p)); } catch (...) {}
    }
  }
  return true;
}

bool ReadLine(int fd, std::size_t max_bytes, std::string& out, int timeout_ms) {
  out.clear();
  out.reserve(256);
  while (out.size() < max_bytes) {
    pollfd pfd{fd, POLLIN, 0};
    int rc = poll(&pfd, 1, timeout_ms);
    if (rc <= 0) return false;
    if (!(pfd.revents & POLLIN)) return false;
    char buf[512];
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n == 0) return !out.empty();
    if (n < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    for (ssize_t i = 0; i < n; ++i) {
      if (buf[i] == '\n') {
        out.append(buf, buf + i);
        return true;
      }
    }
    out.append(buf, buf + n);
  }
  return true;
}

void SendAll(int fd, const std::string& data) {
  const char* p = data.data();
  std::size_t remaining = data.size();
  while (remaining > 0) {
    ssize_t n = send(fd, p, remaining, MSG_NOSIGNAL);
    if (n < 0) {
      if (errno == EINTR) continue;
      return;
    }
    p += n;
    remaining -= static_cast<std::size_t>(n);
  }
}

std::string BuildResponse(int exit_code, int signal_num, bool truncated,
                          const std::string& stdout_buf,
                          const std::string& stderr_buf,
                          const std::string& error_tag) {
  std::ostringstream o;
  o << "{\"exit\":" << exit_code
    << ",\"signal\":" << signal_num
    << ",\"truncated\":" << (truncated ? "true" : "false")
    << ",\"stdout\":\"" << EscapeJson(stdout_buf) << "\""
    << ",\"stderr\":\"" << EscapeJson(stderr_buf) << "\""
    << ",\"error\":";
  if (error_tag.empty()) {
    o << "null";
  } else {
    o << "\"" << EscapeJson(error_tag) << "\"";
  }
  o << "}\n";
  return o.str();
}

void ResetChildPriority() {
  sched_param sp{};
  sp.sched_priority = 0;
  sched_setscheduler(0, SCHED_OTHER, &sp);
  setpriority(PRIO_PROCESS, 0, 0);
}

struct RunResult {
  int exit_code = -1;
  int signal_num = 0;
  bool truncated = false;
  std::string error_tag;
  std::string stdout_buf;
  std::string stderr_buf;
};

RunResult RunCommand(const std::string& cmd, int timeout_s, std::size_t max_bytes) {
  RunResult r;

  int out_pipe[2];
  int err_pipe[2];
  if (pipe2(out_pipe, O_CLOEXEC) < 0) { r.error_tag = "spawn_failed"; return r; }
  if (pipe2(err_pipe, O_CLOEXEC) < 0) {
    close(out_pipe[0]); close(out_pipe[1]);
    r.error_tag = "spawn_failed"; return r;
  }

  pid_t pid = fork();
  if (pid < 0) {
    close(out_pipe[0]); close(out_pipe[1]);
    close(err_pipe[0]); close(err_pipe[1]);
    r.error_tag = "spawn_failed";
    return r;
  }
  if (pid == 0) {
    ResetChildPriority();
    setpgid(0, 0);
    signal(SIGPIPE, SIG_DFL);
    dup2(out_pipe[1], STDOUT_FILENO);
    dup2(err_pipe[1], STDERR_FILENO);
    int devnull = open("/dev/null", O_RDONLY);
    if (devnull >= 0) {
      dup2(devnull, STDIN_FILENO);
      close(devnull);
    }
    execl("/bin/sh", "sh", "-c", cmd.c_str(), static_cast<char*>(nullptr));
    _exit(127);
  }

  close(out_pipe[1]);
  close(err_pipe[1]);
  fcntl(out_pipe[0], F_SETFL, O_NONBLOCK);
  fcntl(err_pipe[0], F_SETFL, O_NONBLOCK);

  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(timeout_s);
  bool out_open = true, err_open = true;
  bool killed = false;
  pid_t pgid = pid;
  int reaped_status = 0;
  bool reaped = false;

  while (out_open || err_open) {
    auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      if (!killed) {
        if (r.error_tag.empty()) r.error_tag = "timeout";
        killpg(pgid, SIGTERM);
        killed = true;
        deadline = now + std::chrono::seconds(1);
      } else {
        killpg(pgid, SIGKILL);
        break;
      }
    }

    pollfd pfds[2];
    int nfds = 0;
    if (out_open) { pfds[nfds++] = {out_pipe[0], POLLIN, 0}; }
    if (err_open) { pfds[nfds++] = {err_pipe[0], POLLIN, 0}; }

    int remaining_ms = static_cast<int>(
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count());
    if (remaining_ms < 0) remaining_ms = 0;
    if (remaining_ms > 200) remaining_ms = 200;

    int rc = poll(pfds, nfds, remaining_ms);
    if (rc < 0) {
      if (errno == EINTR) continue;
      break;
    }

    for (int i = 0; i < nfds; ++i) {
      int fd = pfds[i].fd;
      if (pfds[i].revents & (POLLIN | POLLHUP | POLLERR)) {
        char buf[4096];
        while (true) {
          ssize_t n = read(fd, buf, sizeof(buf));
          if (n > 0) {
            std::string& target = (fd == out_pipe[0]) ? r.stdout_buf : r.stderr_buf;
            std::size_t total = r.stdout_buf.size() + r.stderr_buf.size();
            std::size_t cap = (total < max_bytes) ? (max_bytes - total) : 0;
            std::size_t take = std::min<std::size_t>(static_cast<std::size_t>(n), cap);
            target.append(buf, buf + take);
            if (r.stdout_buf.size() + r.stderr_buf.size() >= max_bytes && !r.truncated) {
              r.truncated = true;
              if (!killed) {
                killpg(pgid, SIGTERM);
                killed = true;
                deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
              }
              char drain[4096];
              while (read(fd, drain, sizeof(drain)) > 0) {}
              break;
            }
            if (n < static_cast<ssize_t>(sizeof(buf))) break;
          } else if (n == 0) {
            if (fd == out_pipe[0]) out_open = false;
            else err_open = false;
            break;
          } else {
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            if (errno == EINTR) continue;
            if (fd == out_pipe[0]) out_open = false;
            else err_open = false;
            break;
          }
        }
      }
    }

    if (!reaped) {
      int status = 0;
      pid_t w = waitpid(pid, &status, WNOHANG);
      if (w == pid) { reaped = true; reaped_status = status; }
    }
  }

  close(out_pipe[0]);
  close(err_pipe[0]);

  if (!reaped) {
    // Give the child a brief chance to exit on its own; otherwise SIGKILL it.
    for (int i = 0; i < 20 && !reaped; ++i) {
      int status = 0;
      pid_t w = waitpid(pid, &status, WNOHANG);
      if (w == pid) { reaped = true; reaped_status = status; break; }
      if (w < 0) break;
      usleep(50 * 1000);
    }
    if (!reaped) {
      killpg(pgid, SIGKILL);
      int status = 0;
      waitpid(pid, &status, 0);
      reaped = true;
      reaped_status = status;
    }
  }

  if (WIFEXITED(reaped_status)) {
    r.exit_code = WEXITSTATUS(reaped_status);
  } else if (WIFSIGNALED(reaped_status)) {
    r.exit_code = -1;
    r.signal_num = WTERMSIG(reaped_status);
  }
  return r;
}

void RaiseThreadPriority() {
  sched_param sp{};
  sp.sched_priority = 10;
  int rc = pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);
  if (rc == 0) {
    std::cout << "command_server sched=SCHED_FIFO prio=10" << std::endl;
    return;
  }
  if (setpriority(PRIO_PROCESS, 0, -19) == 0) {
    std::cout << "command_server sched=OTHER nice=-19 (fifo_err=" << rc << ")" << std::endl;
    return;
  }
  std::cout << "command_server priority_unchanged (fifo_err=" << rc
            << " nice_errno=" << errno << ")" << std::endl;
}

}  // namespace

CommandServer::~CommandServer() { Stop(); }

bool CommandServer::Start(const WorkerConfig& config, std::string& error) {
  if (!config.exec_enabled) { error = "disabled"; return false; }
  if (config.exec_token.empty()) { error = "exec_token required"; return false; }

  token_ = config.exec_token;
  max_output_bytes_ = static_cast<std::size_t>(config.exec_max_output_kb) * 1024;
  default_timeout_s_ = config.exec_default_timeout_s;

  listen_fd_ = socket(AF_INET, SOCK_STREAM, 0);
  if (listen_fd_ < 0) { error = std::string("socket: ") + std::strerror(errno); return false; }
  int yes = 1;
  setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(config.exec_port));
  if (config.exec_bind_host.empty() || config.exec_bind_host == "0.0.0.0") {
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
  } else if (inet_pton(AF_INET, config.exec_bind_host.c_str(), &addr.sin_addr) != 1) {
    error = "invalid exec_bind_host: " + config.exec_bind_host;
    close(listen_fd_); listen_fd_ = -1;
    return false;
  }

  if (bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
    error = std::string("bind ") + config.exec_bind_host + ":" +
            std::to_string(config.exec_port) + ": " + std::strerror(errno);
    close(listen_fd_); listen_fd_ = -1;
    return false;
  }
  if (listen(listen_fd_, 4) < 0) {
    error = std::string("listen: ") + std::strerror(errno);
    close(listen_fd_); listen_fd_ = -1;
    return false;
  }

  running_ = true;
  accept_thread_ = std::thread([this]() { AcceptLoop(); });
  return true;
}

void CommandServer::Stop() {
  running_ = false;
  if (listen_fd_ >= 0) {
    shutdown(listen_fd_, SHUT_RDWR);
    close(listen_fd_);
    listen_fd_ = -1;
  }
  if (accept_thread_.joinable()) accept_thread_.join();
}

void CommandServer::AcceptLoop() {
  RaiseThreadPriority();
  while (running_) {
    sockaddr_in peer{};
    socklen_t plen = sizeof(peer);
    int fd = accept(listen_fd_, reinterpret_cast<sockaddr*>(&peer), &plen);
    if (fd < 0) {
      if (!running_) break;
      if (errno == EINTR) continue;
      continue;
    }
    HandleClient(fd);
    close(fd);
  }
}

void CommandServer::HandleClient(int fd) {
  std::string line;
  if (!ReadLine(fd, 64 * 1024, line, 5000)) {
    SendAll(fd, BuildResponse(-1, 0, false, "", "", "bad_request"));
    return;
  }
  ParsedRequest req;
  std::string perr;
  if (!ParseRequest(line, req, perr)) {
    SendAll(fd, BuildResponse(-1, 0, false, "", "", "bad_request"));
    return;
  }
  if (req.token != token_) {
    SendAll(fd, BuildResponse(-1, 0, false, "", "", "bad_token"));
    return;
  }
  int timeout_s = default_timeout_s_;
  if (req.timeout_s > 0 && req.timeout_s <= 300) timeout_s = req.timeout_s;

  RunResult r = RunCommand(req.cmd, timeout_s, max_output_bytes_);
  SendAll(fd, BuildResponse(r.exit_code, r.signal_num, r.truncated,
                            r.stdout_buf, r.stderr_buf, r.error_tag));
}
