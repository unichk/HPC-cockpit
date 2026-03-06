#include "transport_registry.h"

#include <sstream>

TransportPtr CreateStdoutTransport();
TransportPtr CreateUdpTransport(const std::string& host, int port);

TransportPtr CreateTransport(const WorkerConfig& config, std::string& error) {
  if (config.transport == "stdout") {
    return CreateStdoutTransport();
  }
  if (config.transport == "udp") {
    if (config.transport_udp_host.empty()) {
      error = "transport_udp_host is required when transport=udp";
      return nullptr;
    }
    auto transport = CreateUdpTransport(config.transport_udp_host, config.transport_udp_port);
    if (!transport) {
      error = "failed to initialize udp transport for " + config.transport_udp_host + ":" +
              std::to_string(config.transport_udp_port) + " (expected IPv4 address)";
      return nullptr;
    }
    return transport;
  }
  error = "unknown transport: " + config.transport;
  return nullptr;
}

std::vector<std::string> BuiltinTransports() {
  return {"stdout", "udp"};
}
