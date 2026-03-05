#include "transport.h"

#include <iostream>
#include <sstream>

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

class StdoutTransport : public Transport {
 public:
  std::string Name() const override { return "stdout"; }

  bool Send(const Snapshot& snapshot, std::string&) override {
    std::ostringstream line;
    line << "{\"node_id\":\"" << EscapeJson(snapshot.node_id) << "\",\"timestamp_ms\":"
         << snapshot.timestamp_ms << ",\"metrics\":[";

    for (std::size_t i = 0; i < snapshot.metrics.size(); ++i) {
      const auto& metric = snapshot.metrics[i];
      if (i > 0) {
        line << ",";
      }
      line << "{\"module\":\"" << EscapeJson(metric.module) << "\",\"name\":\""
           << EscapeJson(metric.name) << "\",\"value\":" << metric.value << ",\"unit\":\""
           << EscapeJson(metric.unit) << "\"}";
    }
    line << "]}";
    std::cout << line.str() << "\n" << std::flush;
    return true;
  }
};

}  // namespace

TransportPtr CreateStdoutTransport() {
  return std::make_unique<StdoutTransport>();
}
