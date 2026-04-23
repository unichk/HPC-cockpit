// GPU collector — AMD ROCm primary, NVIDIA secondary.
//
// NOTE: UNTESTED — the dev cluster (Inventec F6IVT) has no GPU. Every
// rocm-smi / nvidia-smi shell-out and its associated parser is marked
// with "UNTESTED" so the whole GPU code path is grep-findable on first
// boot against real hardware. Before trusting the numbers:
//   1. Run /tmp/probe_gpu.sh (read-only) on the target machine to dump the
//      raw CLI output this collector parses.
//   2. Sanity-check that column order / units match the parsers below.
//   3. Only then try the tuning commands in server/web/node.html's
//      GPU_CMDS table.
//
// The collector stays completely silent when no GPU is present: if both
// rocm-smi and nvidia-smi are missing or return zero GPUs, it emits only
// gpu.count=0 and returns, so the current GPU-less cluster sees no UI.

#include "collector.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr int kMaxGpus = 8;

enum GpuVendor {
  kVendorNone = 0,
  kVendorAmd = 1,
  kVendorNvidia = 2,
  kVendorMixed = 3,
};

bool RunCommand(const char* command, std::string& output) {
  std::array<char, 4096> buffer{};
  output.clear();
  FILE* pipe = popen(command, "r");
  if (!pipe) return false;
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    output.append(buffer.data());
  }
  const int status = pclose(pipe);
  return status == 0 && !output.empty();
}

// Quiet variant: some tools print to stderr on missing-device conditions.
// We already redirect 2>/dev/null at the call site; this helper doesn't
// demand the command to exit 0, because rocm-smi sometimes returns
// nonzero on partial queries but still prints usable rows.
bool RunCommandSoft(const char* command, std::string& output) {
  std::array<char, 4096> buffer{};
  output.clear();
  FILE* pipe = popen(command, "r");
  if (!pipe) return false;
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    output.append(buffer.data());
  }
  pclose(pipe);
  return !output.empty();
}

std::string Trim(const std::string& value) {
  std::size_t start = 0;
  while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) ++start;
  std::size_t end = value.size();
  while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) --end;
  return value.substr(start, end - start);
}

std::vector<std::string> SplitChar(const std::string& value, char sep) {
  std::vector<std::string> out;
  std::stringstream stream(value);
  std::string part;
  while (std::getline(stream, part, sep)) out.push_back(Trim(part));
  return out;
}

// Try to parse a leading double. "[N/A]", "N/A", "not available", empty → false.
bool ParseNumber(const std::string& raw, double& out) {
  const std::string s = Trim(raw);
  if (s.empty()) return false;
  if (s.find("N/A") != std::string::npos) return false;
  if (s.find("not") != std::string::npos) return false;
  std::stringstream ss(s);
  ss >> out;
  return !ss.fail();
}

// NOTE: UNTESTED — expected to print one line per AMD GPU like:
//   GPU[0]		: GPU ID: 0x7312
//   GPU[1]		: GPU ID: 0x7312
int CountAmdGpus() {
  std::string out;
  if (!RunCommandSoft("rocm-smi --showid 2>/dev/null", out)) return 0;
  int count = 0;
  std::istringstream ss(out);
  std::string line;
  while (std::getline(ss, line)) {
    if (line.rfind("GPU[", 0) == 0) ++count;
  }
  return std::min(count, kMaxGpus);
}

// NOTE: UNTESTED — `nvidia-smi -L` prints one "GPU 0: <name> (UUID...)" per card.
int CountNvidiaGpus() {
  std::string out;
  if (!RunCommandSoft("nvidia-smi -L 2>/dev/null", out)) return 0;
  int count = 0;
  std::istringstream ss(out);
  std::string line;
  while (std::getline(ss, line)) {
    if (line.rfind("GPU ", 0) == 0) ++count;
  }
  return std::min(count, kMaxGpus);
}

struct GpuSample {
  int index = -1;
  int vendor = kVendorNone;
  double temp_c = 0.0;
  double util_percent = 0.0;
  double power_w = 0.0;
  double power_cap_w = 0.0;
  double mem_used_mb = 0.0;
  double mem_total_mb = 0.0;
  double clock_mhz = 0.0;
  bool has_temp = false;
  bool has_util = false;
  bool has_power = false;
  bool has_cap = false;
  bool has_mem = false;
  bool has_clock = false;
};

// NOTE: UNTESTED — nvidia-smi --query-gpu with --format=csv,noheader,nounits
// produces one comma-separated line per GPU. Expected columns (order matters):
//   0: index
//   1: temperature.gpu (°C)
//   2: utilization.gpu (%)
//   3: power.draw (W)
//   4: power.limit (W)  — current cap, not hardware max
//   5: memory.used (MiB)
//   6: memory.total (MiB)
//   7: clocks.gr (MHz)
void QueryNvidia(std::vector<GpuSample>& samples) {
  std::string out;
  const char* cmd =
      "nvidia-smi --query-gpu=index,temperature.gpu,utilization.gpu,"
      "power.draw,power.limit,memory.used,memory.total,clocks.gr "
      "--format=csv,noheader,nounits 2>/dev/null";
  if (!RunCommand(cmd, out)) return;

  std::istringstream ss(out);
  std::string line;
  while (std::getline(ss, line)) {
    if (Trim(line).empty()) continue;
    const auto f = SplitChar(line, ',');
    if (f.size() < 8) continue;

    GpuSample g;
    g.vendor = kVendorNvidia;
    double tmp;
    if (!ParseNumber(f[0], tmp)) continue;
    g.index = static_cast<int>(tmp);
    if (g.index < 0 || g.index >= kMaxGpus) continue;
    if (ParseNumber(f[1], g.temp_c))       g.has_temp = true;
    if (ParseNumber(f[2], g.util_percent)) g.has_util = true;
    if (ParseNumber(f[3], g.power_w))      g.has_power = true;
    if (ParseNumber(f[4], g.power_cap_w))  g.has_cap = true;
    const bool used_ok = ParseNumber(f[5], g.mem_used_mb);
    const bool total_ok = ParseNumber(f[6], g.mem_total_mb);
    g.has_mem = used_ok && total_ok;
    if (ParseNumber(f[7], g.clock_mhz))    g.has_clock = true;
    samples.push_back(g);
  }
}

// NOTE: UNTESTED — rocm-smi CSV mode emits a header row and one row per GPU.
// The exact column names vary between ROCm releases, so we parse by header
// name rather than position. Flags tried (combined in one call for speed):
//   --showtemp       → "Temperature (Sensor edge) (C)"
//   --showuse        → "GPU use (%)"
//   --showpower      → "Average Graphics Package Power (W)"
//   --showmaxpower   → "Max Graphics Package Power (W)"
//   --showmeminfo vram → "VRAM Total Memory (B)" / "VRAM Total Used Memory (B)"
//   --showclocks     → "sclk clock speed: (XMhz)" and similar — plain text, NOT
//                      CSV-friendly. We fall back to --showclocks parsed
//                      line-by-line when the CSV headers don't contain it.
//
// If header names on your ROCm release differ from the substrings below, add
// aliases in the `header_is(...)` calls rather than relying on position.
void QueryAmd(std::vector<GpuSample>& samples, int amd_count) {
  std::string csv_out;
  const char* csv_cmd =
      "rocm-smi --showtemp --showuse --showpower --showmaxpower "
      "--showmeminfo vram --csv 2>/dev/null";
  const bool have_csv = RunCommand(csv_cmd, csv_out);

  // Seed samples for all AMD GPUs we know about, so we can fill them
  // partially even if CSV parsing doesn't yield every field.
  std::vector<GpuSample> locals(amd_count);
  for (int i = 0; i < amd_count; ++i) {
    locals[i].index = i;
    locals[i].vendor = kVendorAmd;
  }

  if (have_csv) {
    std::istringstream ss(csv_out);
    std::string line;
    std::vector<std::string> headers;
    bool got_header = false;
    while (std::getline(ss, line)) {
      const std::string t = Trim(line);
      if (t.empty()) continue;
      const auto fields = SplitChar(t, ',');
      if (!got_header) {
        headers = fields;
        got_header = true;
        continue;
      }
      if (fields.empty()) continue;

      // First column is a device name like "card0" or "GPU0". Walk backward
      // to find the trailing run of digits; that's the device index.
      int dev_idx = -1;
      {
        const std::string& dev = fields[0];
        std::size_t end = dev.size();
        while (end > 0 && std::isdigit(static_cast<unsigned char>(dev[end - 1]))) --end;
        if (end < dev.size()) {
          try { dev_idx = std::stoi(dev.substr(end)); } catch (...) { dev_idx = -1; }
        }
      }
      if (dev_idx < 0 || dev_idx >= amd_count) continue;

      auto header_has = [&](std::size_t col, std::initializer_list<const char*> needles) {
        if (col >= headers.size()) return false;
        const std::string& h = headers[col];
        for (const char* n : needles) if (h.find(n) != std::string::npos) return true;
        return false;
      };

      for (std::size_t c = 1; c < fields.size() && c < headers.size(); ++c) {
        double v;
        if (!ParseNumber(fields[c], v)) continue;
        GpuSample& g = locals[dev_idx];
        if (header_has(c, {"Temperature", "edge"})) {
          g.temp_c = v; g.has_temp = true;
        } else if (header_has(c, {"GPU use", "GPU Use"})) {
          g.util_percent = v; g.has_util = true;
        } else if (header_has(c, {"Average Graphics Package Power", "Average Socket Power"})) {
          g.power_w = v; g.has_power = true;
        } else if (header_has(c, {"Max Graphics Package Power"})) {
          g.power_cap_w = v; g.has_cap = true;
        } else if (header_has(c, {"VRAM Total Memory"})) {
          g.mem_total_mb = v / (1024.0 * 1024.0); g.has_mem = true;
        } else if (header_has(c, {"VRAM Total Used Memory"})) {
          g.mem_used_mb = v / (1024.0 * 1024.0);
        }
      }
    }
  }

  // NOTE: UNTESTED — clock speed from --showclocks is plain text, not CSV.
  // Typical line: "GPU[0]		: sclk clock speed: (800Mhz)"
  std::string clk_out;
  if (RunCommandSoft("rocm-smi --showclocks 2>/dev/null", clk_out)) {
    std::istringstream ss(clk_out);
    std::string line;
    while (std::getline(ss, line)) {
      // Look for "GPU[N]" prefix and "sclk clock speed: (XXXMhz)"
      const auto open = line.find("GPU[");
      if (open == std::string::npos) continue;
      const auto close = line.find("]", open);
      if (close == std::string::npos) continue;
      int idx = 0;
      for (auto i = open + 4; i < close; ++i) {
        if (!std::isdigit(static_cast<unsigned char>(line[i]))) { idx = -1; break; }
        idx = idx * 10 + (line[i] - '0');
      }
      if (idx < 0 || idx >= amd_count) continue;
      const auto tag = line.find("sclk");
      if (tag == std::string::npos) continue;
      const auto lparen = line.find("(", tag);
      const auto rparen = line.find("Mhz", tag);
      if (lparen == std::string::npos || rparen == std::string::npos || rparen <= lparen + 1) continue;
      const std::string num = line.substr(lparen + 1, rparen - lparen - 1);
      double mhz;
      if (ParseNumber(num, mhz)) {
        locals[idx].clock_mhz = mhz;
        locals[idx].has_clock = true;
      }
    }
  }

  for (auto& g : locals) {
    if (g.index >= 0) samples.push_back(g);
  }
}

class GpuCollector : public Collector {
 public:
  std::string Name() const override { return "gpu"; }

  bool Collect(std::vector<Metric>& out, std::string& /*error*/) override {
    const int count = amd_count_ + nvidia_count_;
    int fleet_vendor = kVendorNone;
    if (amd_count_ > 0 && nvidia_count_ > 0) fleet_vendor = kVendorMixed;
    else if (amd_count_ > 0) fleet_vendor = kVendorAmd;
    else if (nvidia_count_ > 0) fleet_vendor = kVendorNvidia;

    out.push_back(Metric{"gpu", "count", static_cast<double>(count), "count"});
    out.push_back(Metric{"gpu", "vendor_code", static_cast<double>(fleet_vendor), "enum"});

    if (count == 0) return true;  // GPU-less host: stay silent beyond headers.

    std::vector<GpuSample> samples;
    samples.reserve(count);
    if (amd_count_ > 0) QueryAmd(samples, amd_count_);
    if (nvidia_count_ > 0) QueryNvidia(samples);

    // Emit per-GPU metrics. Per-collect re-indexing isn't needed because both
    // rocm-smi and nvidia-smi number their devices 0..N-1 within each vendor;
    // on mixed hosts the UI would need a joint namespace, but mixed hosts are
    // vanishingly rare so we just emit AMDs as 0..amd_count-1 and NVs as
    // (amd_count)..(amd_count+nvidia_count-1). Renumber NV samples here.
    for (auto& s : samples) {
      if (s.vendor == kVendorNvidia) s.index += amd_count_;
    }

    double max_temp = 0.0, sum_power = 0.0, sum_util = 0.0;
    int util_n = 0;

    for (const auto& s : samples) {
      if (s.index < 0 || s.index >= kMaxGpus) continue;
      out.push_back(Metric{"gpu", std::to_string(s.index) + ".vendor_code",
                           static_cast<double>(s.vendor), "enum"});
      if (s.has_temp) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".temp_c", s.temp_c, "celsius"});
        if (s.temp_c > max_temp) max_temp = s.temp_c;
      }
      if (s.has_util) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".util_percent",
                             s.util_percent, "percent"});
        sum_util += s.util_percent; ++util_n;
      }
      if (s.has_power) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".power_w", s.power_w, "watt"});
        sum_power += s.power_w;
      }
      if (s.has_cap) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".power_cap_w",
                             s.power_cap_w, "watt"});
      }
      if (s.has_mem) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".mem_used_mb",
                             s.mem_used_mb, "mebibyte"});
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".mem_total_mb",
                             s.mem_total_mb, "mebibyte"});
      }
      if (s.has_clock) {
        out.push_back(Metric{"gpu", std::to_string(s.index) + ".clock_mhz",
                             s.clock_mhz, "megahertz"});
      }
    }

    if (max_temp > 0.0) out.push_back(Metric{"gpu", "temp_max_c", max_temp, "celsius"});
    if (sum_power > 0.0) out.push_back(Metric{"gpu", "power_sum_w", sum_power, "watt"});
    if (util_n > 0) {
      out.push_back(Metric{"gpu", "util_avg_percent", sum_util / util_n, "percent"});
    }
    return true;
  }

 private:
  int amd_count_ = CountAmdGpus();
  int nvidia_count_ = CountNvidiaGpus();
};

}  // namespace

CollectorPtr CreateGpuCollector() {
  return std::make_unique<GpuCollector>();
}
