#include "transport.h"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <zlib.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <iomanip>
#include <map>
#include <sstream>
#include <string>
#include <vector>

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
  // Best compression: at one snapshot every few seconds the extra CPU is
  // immeasurable, and the ~6% it buys over the default level is margin against
  // the 1472-byte single-frame ceiling.
  const int rc = compress2(reinterpret_cast<Bytef*>(&out[0]), &dest_len,
                           reinterpret_cast<const Bytef*>(input.data()),
                           static_cast<uLong>(input.size()), Z_BEST_COMPRESSION);
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

// Serialise one module's slice of a snapshot. Each datagram is a complete,
// independently-parseable document carrying the node id, the collection
// timestamp and the module it belongs to, so the receiver can apply it without
// reference to any other packet.
std::string ModuleToJson(const Snapshot& snapshot, const std::string& module,
                         const std::vector<const Metric*>& metrics) {
  std::ostringstream line;
  // 15 sig digits round-trips memory totals (long long → double) without
  // truncation; default stream precision of 6 caused e.g. 8388604 → 8388600.
  line << std::setprecision(15);
  line << "{\"node_id\":\"" << EscapeJson(snapshot.node_id) << "\",\"timestamp_ms\":"
       << snapshot.timestamp_ms << ",\"module\":\"" << EscapeJson(module) << "\",\"metrics\":[";
  for (std::size_t index = 0; index < metrics.size(); ++index) {
    const Metric& metric = *metrics[index];
    if (index > 0) {
      line << ",";
    }
    line << "{\"module\":\"" << EscapeJson(metric.module) << "\",\"name\":\""
         << EscapeJson(metric.name) << "\",\"value\":" << metric.value << ",\"unit\":\""
         << EscapeJson(metric.unit) << "\"";
    if (!metric.text.empty()) {
      line << ",\"text\":\"" << EscapeJson(metric.text) << "\"";
    }
    line << "}";
  }
  line << "]}";
  return line.str();
}

class UdpTransport : public Transport {
 public:
  UdpTransport(std::string host, int port, int socket_fd)
      : host_(std::move(host)), port_(port), socket_fd_(socket_fd) {}

  ~UdpTransport() override {
    if (socket_fd_ >= 0) {
      close(socket_fd_);
    }
  }

  std::string Name() const override { return "udp"; }

  // One datagram per module rather than one per snapshot. A whole snapshot no
  // longer fits in a single Ethernet frame once a node reports per-sensor
  // thermals, 8 GPUs and 34 fans, and a fragmented datagram is all-or-nothing:
  // one lost fragment discards every module. Split along the data's own seams
  // instead, so each packet stands alone and a loss costs exactly one module's
  // worth of freshness. Every module comfortably fits one frame on its own.
  bool Send(const Snapshot& snapshot, std::string& error) override {
    // Group by module, preserving first-appearance order so packets go out in
    // the order the collectors ran.
    std::vector<std::string> order;
    std::map<std::string, std::vector<const Metric*>> groups;
    for (const Metric& metric : snapshot.metrics) {
      auto found = groups.find(metric.module);
      if (found == groups.end()) {
        order.push_back(metric.module);
        found = groups.emplace(metric.module, std::vector<const Metric*>{}).first;
      }
      found->second.push_back(&metric);
    }
    if (order.empty()) {
      return true;
    }

    bool all_sent = true;
    for (const std::string& module : order) {
      std::string module_error;
      if (!SendOne(snapshot, module, groups[module], module_error)) {
        // Keep going: the point of splitting is that one module's failure does
        // not take the others with it. Report the first error encountered.
        if (all_sent) {
          error = module_error;
        }
        all_sent = false;
      }
    }
    return all_sent;
  }

 private:
  bool SendOne(const Snapshot& snapshot, const std::string& module,
               const std::vector<const Metric*>& metrics, std::string& error) {
    const std::string json = ModuleToJson(snapshot, module, metrics);

    // Fall back to raw JSON if deflate fails or would not actually shrink the
    // payload (a module with only a metric or two).
    std::string compressed;
    const std::string* payload = &json;
    if (CompressPayload(json, compressed) && compressed.size() < json.size()) {
      payload = &compressed;
    }

    if (payload->size() > kMaxDatagram) {
      error = "module '" + module + "' serialises to " + std::to_string(payload->size()) +
              " bytes, over the " + std::to_string(kMaxDatagram) + "-byte UDP datagram limit";
      return false;
    }

    if (!Resolve(error)) {
      return false;
    }
    const auto bytes_sent =
        sendto(socket_fd_, payload->data(), payload->size(), 0,
               reinterpret_cast<const sockaddr*>(&remote_address_), sizeof(remote_address_));
    if (bytes_sent < 0 || static_cast<std::size_t>(bytes_sent) != payload->size()) {
      error = "sendto failed for " + host_ + ":" + std::to_string(port_) + " (module '" +
              module + "'): " + std::strerror(errno);
      return false;
    }
    return true;
  }

  // transport_udp_host may be a hostname, so the cockpit's address lives in
  // /etc/hosts (or DNS) rather than in worker.conf. It is looked up again
  // every kResolveEvery, so moving the cockpit or renumbering the network
  // (e.g. at the competition venue) needs no worker restart, and a name that
  // does not resolve yet at boot only delays the first sends.
  bool Resolve(std::string& error) {
    const auto now = std::chrono::steady_clock::now();
    if (resolved_ && now - resolved_at_ < kResolveEvery) {
      return true;
    }
    addrinfo hints {};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    addrinfo* result = nullptr;
    const int rc = getaddrinfo(host_.c_str(), nullptr, &hints, &result);
    if (rc != 0 || result == nullptr) {
      // Keep using the last good address if there is one.
      if (resolved_) {
        return true;
      }
      error = "cannot resolve '" + host_ + "': " + gai_strerror(rc);
      return false;
    }
    sockaddr_in address = *reinterpret_cast<const sockaddr_in*>(result->ai_addr);
    // Ubuntu maps a host's own name to 127.0.1.1. Prefer a real address so
    // the server records the node's network IP (it connects back to it for
    // the exec channel), and fall back to loopback only when that is all.
    for (const addrinfo* ai = result; ai != nullptr; ai = ai->ai_next) {
      const auto* sin = reinterpret_cast<const sockaddr_in*>(ai->ai_addr);
      if ((ntohl(sin->sin_addr.s_addr) >> 24) != 127) {
        address = *sin;
        break;
      }
    }
    freeaddrinfo(result);
    address.sin_port = htons(static_cast<uint16_t>(port_));
    remote_address_ = address;
    resolved_ = true;
    resolved_at_ = now;
    return true;
  }

  static constexpr std::chrono::seconds kResolveEvery{60};

  std::string host_;
  int port_;
  int socket_fd_;
  sockaddr_in remote_address_ {};
  bool resolved_ = false;
  std::chrono::steady_clock::time_point resolved_at_ {};
};

}  // namespace

TransportPtr CreateUdpTransport(const std::string& host, int port) {
  const int socket_fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (socket_fd < 0) {
    return nullptr;
  }

  if (host.empty()) {
    close(socket_fd);
    return nullptr;
  }
  return std::make_unique<UdpTransport>(host, port, socket_fd);
}
