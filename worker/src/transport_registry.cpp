#include "transport_registry.h"

TransportPtr CreateStdoutTransport();

TransportPtr CreateTransport(const std::string& name) {
  if (name == "stdout") {
    return CreateStdoutTransport();
  }
  return nullptr;
}

std::vector<std::string> BuiltinTransports() {
  return {"stdout"};
}
