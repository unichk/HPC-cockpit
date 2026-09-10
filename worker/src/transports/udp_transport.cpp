#include "transport.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <zlib.h>

#include <cerrno>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <string>

namespace {

// Largest payload a single UDP datagram can carry (65535 - 8 UDP - 20 IPv4).
constexpr std::size_t kMaxDatagram = 65507;

// zlib-deflate the snapshot so it fits in one unfragmented datagram. A
// fully-populated node serialises to ~12 KB of JSON, which IP-fragments into
// nine packets — losing any one of them costs the whole snapshot. The key
// names repeat on every metric, so deflate takes that to ~1.3 KB (~9x).
//
// The server tells the two apart by first byte: a zlib stream starts with a
// CMF byte (0x78 for the 32K window compress2 uses), JSON with '{'. That way
// a worker and server can be upgraded independently in either order.
bool CompressPayload(const std::string& input, std::string& out) {
  uLongf dest_len = compressBound(static_cast<uLong>(input.size()));
  out.resize(dest_len);
  const int rc = compress2(reinterpret_cast<Bytef*>(&out[0]), &dest_len,
                           reinterpret_cast<const Bytef*>(input.data()),
                           static_cast<uLong>(input.size()), Z_DEFAULT_COMPRESSION);
  if (rc != Z_OK) {
    return false;
  }
  out.resize(dest_len);
  return true;
}

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
  // 15 sig digits round-trips memory totals (long long → double) without
  // truncation; default stream precision of 6 caused e.g. 8388604 → 8388600.
  line << std::setprecision(15);
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
    const std::string json = SnapshotToJson(snapshot);

    // Fall back to raw JSON if deflate fails or would not actually shrink the
    // payload (tiny snapshots, e.g. a worker with most modules disabled).
    std::string compressed;
    const std::string* payload = &json;
    if (CompressPayload(json, compressed) && compressed.size() < json.size()) {
      payload = &compressed;
    }

    if (payload->size() > kMaxDatagram) {
      error = "snapshot of " + std::to_string(payload->size()) +
              " bytes exceeds the " + std::to_string(kMaxDatagram) +
              "-byte UDP datagram limit; reduce the enabled modules";
      return false;
    }

    const auto bytes_sent =
        sendto(socket_fd_, payload->data(), payload->size(), 0,
               reinterpret_cast<const sockaddr*>(&remote_address_), sizeof(remote_address_));
    if (bytes_sent < 0 || static_cast<std::size_t>(bytes_sent) != payload->size()) {
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
