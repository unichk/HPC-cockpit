#include "transport.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <sstream>
#include <string>

namespace {

std::string EscapeJson(const std::string& input) {
  std::string out;
  out.reserve(input.size());
  for (char c : input) {
    if (c == '\\' || c == '"') {
      out.push_back('\\');
    }
    out.push_back(c);
  }
  return out;
}

std::string SnapshotToJson(const Snapshot& snapshot) {
  std::ostringstream line;
  line << "{\"node_id\":\"" << EscapeJson(snapshot.node_id) << "\",\"timestamp_ms\":"
       << snapshot.timestamp_ms << ",\"metrics\":[";
  for (std::size_t index = 0; index < snapshot.metrics.size(); ++index) {
    const auto& metric = snapshot.metrics[index];
    if (index > 0) {
      line << ",";
    }
    line << "{\"module\":\"" << EscapeJson(metric.module) << "\",\"name\":\""
         << EscapeJson(metric.name) << "\",\"value\":" << metric.value << ",\"unit\":\""
         << EscapeJson(metric.unit) << "\"}";
  }
  line << "]}";
  return line.str();
}

class UdpTransport : public Transport {
 public:
  UdpTransport(std::string host, int port, int socket_fd, sockaddr_in remote_address)
      : host_(std::move(host)), port_(port), socket_fd_(socket_fd), remote_address_(remote_address) {}

  ~UdpTransport() override {
    if (socket_fd_ >= 0) {
      close(socket_fd_);
    }
  }

  std::string Name() const override { return "udp"; }

  bool Send(const Snapshot& snapshot, std::string& error) override {
    const std::string payload = SnapshotToJson(snapshot);
    const auto bytes_sent =
        sendto(socket_fd_, payload.data(), payload.size(), 0,
               reinterpret_cast<const sockaddr*>(&remote_address_), sizeof(remote_address_));
    if (bytes_sent < 0 || static_cast<std::size_t>(bytes_sent) != payload.size()) {
      error = "sendto failed for " + host_ + ":" + std::to_string(port_) + ": " +
              std::strerror(errno);
      return false;
    }
    return true;
  }

 private:
  std::string host_;
  int port_;
  int socket_fd_;
  sockaddr_in remote_address_;
};

}  // namespace

TransportPtr CreateUdpTransport(const std::string& host, int port) {
  const int socket_fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (socket_fd < 0) {
    return nullptr;
  }

  sockaddr_in remote_address {};
  remote_address.sin_family = AF_INET;
  remote_address.sin_port = htons(static_cast<uint16_t>(port));
  if (inet_pton(AF_INET, host.c_str(), &remote_address.sin_addr) != 1) {
    close(socket_fd);
    return nullptr;
  }

  return std::make_unique<UdpTransport>(host, port, socket_fd, remote_address);
}
