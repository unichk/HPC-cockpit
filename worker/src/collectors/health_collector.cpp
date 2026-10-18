#include "collector.h"

#include <arpa/inet.h>
#include <linux/nvme_ioctl.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/statvfs.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <dirent.h>
#include <fstream>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// OK/not-OK checks for the cockpit's status wall. Every result is one metric
// in module "health": name "<group>:<item>", value 0 = OK, 1 = warning,
// 2 = failure, and `text` says what was seen. Groups map to the wall's
// columns: disk, nfs, ib, net, svc, slurm, gpu.
//
// Cheap checks (statvfs, sysfs, /proc) run every tick. Checks that fork a
// tool (systemctl, scontrol, nvidia-smi, journalctl) or talk to hardware
// (NVMe SMART) run every kSlowPeriod and are re-sent from cache in between,
// so the module stays fresh without adding their cost to every interval.

namespace {

constexpr int kOk = 0;
constexpr int kWarn = 1;
constexpr int kFail = 2;

constexpr auto kSlowPeriod = std::chrono::seconds(60);
// An NFS mount that does not answer statvfs within this is reported hung.
constexpr auto kNfsTimeout = std::chrono::milliseconds(2000);
// IB error counters that rose within this window keep the port at warning.
constexpr auto kIbErrorWindow = std::chrono::minutes(15);

constexpr double kDiskWarnPct = 85.0;
constexpr double kDiskFailPct = 95.0;

// Units reported when they exist on the node. Anything enabled must also be
// active; a unit that is merely installed but disabled is left out.
const char* const kUnits[] = {
    "slurmd",    "slurmctld", "slurmdbd",       "munge",       "sssd",
    "slapd",     "nfs-server", "prometheus",    "grafana-server", "mariadb",
    "mysql",     "chrony",    "systemd-timesyncd", "sshd",     "ssh",
    "hpc-worker", "hpc-cockpit", "rsyslog",
};

// Xid codes that mean the GPU or its memory needs attention, not just that an
// application crashed (13, 31, 43, 45 are usually application faults).
const std::set<int> kSevereXids = {48, 61, 62, 63, 64, 74, 79, 92, 94, 95, 119, 120, 140};

using Clock = std::chrono::steady_clock;

struct Item {
  std::string name;
  int status;
  std::string text;
};

std::string ReadFirstLine(const std::string& path) {
  std::ifstream in(path);
  std::string line;
  std::getline(in, line);
  return line;
}

std::vector<std::string> ListDir(const std::string& path) {
  std::vector<std::string> names;
  DIR* dir = opendir(path.c_str());
  if (dir == nullptr) return names;
  while (dirent* e = readdir(dir)) {
    if (e->d_name[0] != '.') names.emplace_back(e->d_name);
  }
  closedir(dir);
  std::sort(names.begin(), names.end());
  return names;
}

bool RunCommand(const std::string& command, std::string& output) {
  output.clear();
  FILE* pipe = popen(command.c_str(), "r");
  if (pipe == nullptr) return false;
  std::array<char, 4096> buffer{};
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    output.append(buffer.data());
  }
  return pclose(pipe) == 0;
}

std::string Trim(const std::string& s) {
  const auto b = s.find_first_not_of(" \t\r\n");
  if (b == std::string::npos) return "";
  const auto e = s.find_last_not_of(" \t\r\n");
  return s.substr(b, e - b + 1);
}

// The transports escape quotes and backslashes only, so keep text to one
// printable line.
std::string Clean(std::string s, std::size_t max_len = 160) {
  for (char& c : s) {
    if (static_cast<unsigned char>(c) < 0x20 || c == 0x7f) c = ' ';
  }
  s = Trim(s);
  if (s.size() > max_len) s = s.substr(0, max_len - 3) + "...";
  return s;
}

std::string HumanBytes(double bytes) {
  const char* units[] = {"B", "KB", "MB", "GB", "TB", "PB"};
  int u = 0;
  while (bytes >= 1000.0 && u < 5) {
    bytes /= 1000.0;
    ++u;
  }
  char buf[32];
  std::snprintf(buf, sizeof(buf), bytes < 10 ? "%.1f %s" : "%.0f %s", bytes, units[u]);
  return buf;
}

std::string Pct(double v) {
  char buf[16];
  std::snprintf(buf, sizeof(buf), "%.0f%%", v);
  return buf;
}

struct Mount {
  std::string source;
  std::string target;
  std::string type;
};

std::vector<Mount> ReadMounts() {
  std::vector<Mount> mounts;
  std::ifstream in("/proc/mounts");
  std::string line;
  while (std::getline(in, line)) {
    std::istringstream ss(line);
    Mount m;
    ss >> m.source >> m.target >> m.type;
    // /proc/mounts escapes spaces as \040; good enough to leave as is.
    mounts.push_back(m);
  }
  return mounts;
}

// Usage of a mounted filesystem as an Item; `status_floor` lets the caller
// keep a worse status it already decided on.
Item UsageItem(const std::string& name, const std::string& label, const struct statvfs& st) {
  const double total = static_cast<double>(st.f_blocks) * st.f_frsize;
  const double avail = static_cast<double>(st.f_bavail) * st.f_frsize;
  const double used_pct = total > 0 ? 100.0 * (1.0 - avail / total) : 0.0;
  const double inode_pct =
      st.f_files > 0 ? 100.0 * (1.0 - static_cast<double>(st.f_favail) / st.f_files) : 0.0;
  int status = kOk;
  if (used_pct >= kDiskFailPct) status = kFail;
  else if (used_pct >= kDiskWarnPct) status = kWarn;
  if (inode_pct >= kDiskFailPct) status = std::max(status, kFail);
  else if (inode_pct >= 90.0) status = std::max(status, kWarn);
  std::string text = label + " " + Pct(used_pct) + " used, " + HumanBytes(avail) + " free of " +
                     HumanBytes(total);
  if (inode_pct >= 90.0) text += ", inodes " + Pct(inode_pct) + " used";
  return Item{name, status, text};
}

class HealthCollector : public Collector {
 public:
  HealthCollector() {
    char host[256] = {0};
    if (gethostname(host, sizeof(host) - 1) == 0) {
      hostname_ = host;
      const auto dot = hostname_.find('.');
      if (dot != std::string::npos) hostname_.resize(dot);
    }
  }

  ~HealthCollector() override {
    for (auto& [target, probe] : nfs_probes_) {
      if (probe.pid > 0) kill(probe.pid, SIGKILL);
    }
  }

  std::string Name() const override { return "health"; }

  bool Collect(std::vector<Metric>& out, std::string& /*error*/) override {
    std::vector<Item> items;
    const auto mounts = ReadMounts();
    CheckLocalDisks(mounts, items);
    CheckRaid(items);
    CheckNfs(mounts, items);
    CheckInfiniband(items);
    CheckNetwork(items);

    const auto now = Clock::now();
    if (first_ || now - last_slow_ >= kSlowPeriod) {
      first_ = false;
      last_slow_ = now;
      slow_items_.clear();
      CheckNvme(slow_items_);
      CheckServices(slow_items_);
      CheckSlurmNode(slow_items_);
      CheckGpus(slow_items_);
    }
    items.insert(items.end(), slow_items_.begin(), slow_items_.end());

    for (const Item& item : items) {
      out.push_back(Metric{"health", item.name, static_cast<double>(item.status), "status",
                           Clean(item.text)});
    }
    return true;
  }

 private:
  // ---- disk: local filesystems ------------------------------------------
  void CheckLocalDisks(const std::vector<Mount>& mounts, std::vector<Item>& items) {
    std::set<std::string> seen_sources;
    for (const Mount& m : mounts) {
      if (m.type != "ext4" && m.type != "xfs" && m.type != "btrfs") continue;
      // One filesystem bind-mounted twice (scc01 exports /mnt/opt as
      // /srv/nfs/opt too) is reported once, under its first mount point.
      if (!seen_sources.insert(m.source).second) continue;
      struct statvfs st {};
      if (statvfs(m.target.c_str(), &st) != 0) {
        items.push_back({"disk:" + m.target, kFail, m.target + ": statvfs failed: " +
                                                       std::strerror(errno)});
        continue;
      }
      items.push_back(UsageItem("disk:" + m.target, m.target, st));
    }
  }

  // ---- disk: software RAID ------------------------------------------------
  void CheckRaid(std::vector<Item>& items) {
    std::ifstream in("/proc/mdstat");
    std::string line;
    std::string current;
    int status = kOk;
    std::string text;
    auto flush = [&]() {
      if (!current.empty()) items.push_back({"disk:" + current, status, text});
      current.clear();
    };
    while (std::getline(in, line)) {
      if (line.rfind("md", 0) == 0 && line.find(" : ") != std::string::npos) {
        flush();
        current = line.substr(0, line.find(' '));
        status = kOk;
        text = current + ": " + Trim(line.substr(line.find(" : ") + 3));
        if (line.find("inactive") != std::string::npos) {
          status = kFail;
          text += " (inactive)";
        }
        continue;
      }
      if (current.empty()) continue;
      const auto lb = line.rfind('[');
      const auto rb = line.rfind(']');
      if (line.find("blocks") != std::string::npos && lb != std::string::npos &&
          rb != std::string::npos && rb > lb) {
        const std::string map = line.substr(lb + 1, rb - lb - 1);
        if (map.find('_') != std::string::npos) {
          status = kFail;
          text += " - DEGRADED [" + map + "]";
        } else {
          text += " [" + map + "]";
        }
      }
      for (const char* op : {"recovery", "resync", "reshape", "check"}) {
        const auto p = line.find(op);
        if (p != std::string::npos && line.find('=', p) != std::string::npos) {
          status = std::max(status, kWarn);
          text += " - " + Trim(line.substr(p, line.find('%', p) - p + 1));
        }
      }
      if (Trim(line).empty()) flush();
    }
    flush();
  }

  // ---- disk: NVMe SMART -----------------------------------------------------
  // Reads the SMART / Health log page (0x02) with an admin passthrough ioctl,
  // which needs root (the worker runs as root) but no nvme-cli.
  void CheckNvme(std::vector<Item>& items) {
    for (const std::string& ctrl : ListDir("/sys/class/nvme")) {
      const std::string model = Trim(ReadFirstLine("/sys/class/nvme/" + ctrl + "/model"));
      const int fd = open(("/dev/" + ctrl).c_str(), O_RDONLY);
      if (fd < 0) continue;
      std::array<unsigned char, 512> log{};
      nvme_admin_cmd cmd{};
      cmd.opcode = 0x02;  // Get Log Page
      cmd.nsid = 0xffffffff;
      cmd.addr = reinterpret_cast<std::uintptr_t>(log.data());
      cmd.data_len = static_cast<unsigned>(log.size());
      cmd.cdw10 = ((static_cast<unsigned>(log.size()) / 4 - 1) << 16) | 0x02;
      const int rc = ioctl(fd, NVME_IOCTL_ADMIN_CMD, &cmd);
      close(fd);
      if (rc != 0) continue;

      const unsigned critical = log[0];
      const int temp_c = static_cast<int>(log[1] | (log[2] << 8)) - 273;
      const unsigned spare = log[3];
      const unsigned used = log[5];
      unsigned long long media_errors = 0;
      for (int i = 7; i >= 0; --i) media_errors = (media_errors << 8) | log[160 + i];

      int status = kOk;
      std::string text = ctrl + " (" + model + "): " + std::to_string(temp_c) + " C, wear " +
                         std::to_string(used) + "%, spare " + std::to_string(spare) + "%";
      if (critical != 0) {
        status = kFail;
        text += ", CRITICAL WARNING";
        if (critical & 0x01) text += " spare-low";
        if (critical & 0x02) text += " temperature";
        if (critical & 0x04) text += " reliability";
        if (critical & 0x08) text += " read-only";
        if (critical & 0x10) text += " backup-device";
      }
      if (media_errors > 0) {
        status = std::max(status, kWarn);
        text += ", " + std::to_string(media_errors) + " media errors";
      }
      if (used >= 90) status = std::max(status, kWarn);
      items.push_back({"disk:" + ctrl, status, text});
    }
  }

  // ---- nfs: responsiveness + usage -----------------------------------------
  // statvfs on a hung NFS mount blocks forever, so each probe runs in a forked
  // child that writes the result to a pipe. A child that misses the deadline
  // is left running (it may be stuck in the kernel) and the mount is not
  // probed again until it exits.
  struct NfsProbe {
    pid_t pid = -1;
    int fd = -1;
  };

  void CheckNfs(const std::vector<Mount>& mounts, std::vector<Item>& items) {
    struct Pending {
      Mount mount;
      pid_t pid;
      int fd;
    };
    std::vector<Pending> pending;
    std::set<std::string> seen_sources;

    for (const Mount& m : mounts) {
      if (m.type != "nfs" && m.type != "nfs4") continue;
      if (!seen_sources.insert(m.source).second) continue;
      const std::string name = "nfs:" + m.target;

      // Still stuck from an earlier tick?
      auto stuck = nfs_probes_.find(m.target);
      if (stuck != nfs_probes_.end()) {
        if (waitpid(stuck->second.pid, nullptr, WNOHANG) == 0) {
          items.push_back({name, kFail, m.target + " (" + m.source +
                                            "): NOT RESPONDING, statvfs still blocked"});
          continue;
        }
        close(stuck->second.fd);
        nfs_probes_.erase(stuck);
      }

      int pipefd[2];
      if (pipe(pipefd) != 0) continue;
      const pid_t pid = fork();
      if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        continue;
      }
      if (pid == 0) {
        close(pipefd[0]);
        struct statvfs st {};
        const int rc = statvfs(m.target.c_str(), &st);
        const int err = rc == 0 ? 0 : errno;
        if (write(pipefd[1], &err, sizeof(err)) < 0) _exit(1);
        if (rc == 0 && write(pipefd[1], &st, sizeof(st)) < 0) _exit(1);
        _exit(0);
      }
      close(pipefd[1]);
      fcntl(pipefd[0], F_SETFL, O_NONBLOCK);
      pending.push_back({m, pid, pipefd[0]});
    }

    // All probes share one deadline, so N healthy mounts cost one round trip.
    const auto deadline = Clock::now() + kNfsTimeout;
    for (Pending& p : pending) {
      const std::string name = "nfs:" + p.mount.target;
      const std::string label = p.mount.target + " (" + p.mount.source + ")";
      bool done = false;
      int status = 0;
      while (Clock::now() < deadline) {
        const pid_t r = waitpid(p.pid, &status, WNOHANG);
        if (r == p.pid) {
          done = true;
          break;
        }
        usleep(10000);
      }
      if (!done) {
        nfs_probes_[p.mount.target] = NfsProbe{p.pid, p.fd};
        items.push_back({name, kFail, label + ": NOT RESPONDING (no answer in 2 s)"});
        continue;
      }
      int err = 0;
      struct statvfs st {};
      const bool got_err = read(p.fd, &err, sizeof(err)) == static_cast<ssize_t>(sizeof(err));
      const bool got_st =
          got_err && err == 0 && read(p.fd, &st, sizeof(st)) == static_cast<ssize_t>(sizeof(st));
      close(p.fd);
      if (!got_err || (err == 0 && !got_st)) {
        items.push_back({name, kWarn, label + ": probe failed"});
      } else if (err != 0) {
        items.push_back({name, kFail, label + ": " + std::strerror(err)});
      } else {
        items.push_back(UsageItem(name, label, st));
      }
    }
  }

  // ---- ib: port state, rate, error counters --------------------------------
  struct CounterHistory {
    std::map<std::string, unsigned long long> last;
    std::deque<std::pair<Clock::time_point, std::string>> rises;  // when, what
  };

  void CheckInfiniband(std::vector<Item>& items) {
    static const char* const kCounters[] = {
        "symbol_error",       "link_error_recovery",
        "link_downed",        "port_rcv_errors",
        "local_link_integrity_errors", "excessive_buffer_overrun_errors",
        "port_rcv_remote_physical_errors",
    };
    struct Port {
      std::string id, netdev, state, phys, rate_text;
      double rate = 0;
    };
    std::vector<Port> ports;
    double best_rate = 0;
    for (const std::string& dev : ListDir("/sys/class/infiniband")) {
      const std::string base = "/sys/class/infiniband/" + dev;
      const auto netdevs = ListDir(base + "/device/net");
      for (const std::string& port : ListDir(base + "/ports")) {
        const std::string pb = base + "/ports/" + port;
        Port p;
        p.id = dev + "/" + port;
        p.netdev = netdevs.empty() ? "" : netdevs.front();
        p.state = ReadFirstLine(pb + "/state");          // "4: ACTIVE"
        p.phys = ReadFirstLine(pb + "/phys_state");      // "5: LinkUp"
        p.rate_text = ReadFirstLine(pb + "/rate");       // "200 Gb/sec (4X HDR)"
        try {
          p.rate = std::stod(p.rate_text);
        } catch (...) {
        }
        best_rate = std::max(best_rate, p.rate);
        ports.push_back(p);
      }
    }

    const auto now = Clock::now();
    for (const Port& p : ports) {
      const auto strip = [](const std::string& s) {
        const auto c = s.find(": ");
        return c == std::string::npos ? s : s.substr(c + 2);
      };
      std::string label = p.id + (p.netdev.empty() ? "" : " (" + p.netdev + ")");
      int status = kOk;
      std::string text = label + ": " + strip(p.state) + ", " + strip(p.phys) + ", " + p.rate_text;
      if (strip(p.state) != "ACTIVE") {
        status = kFail;
        if (strip(p.state) == "INIT") text += " - no subnet manager?";
      } else if (best_rate > 0 && p.rate < best_rate) {
        status = kWarn;
        text += " - slower than the node's other ports";
      }

      // Error counters: warn while any of them rose within the window.
      CounterHistory& h = ib_history_[p.id];
      const std::string cdir = "/sys/class/infiniband/" + p.id.substr(0, p.id.find('/')) +
                               "/ports/" + p.id.substr(p.id.find('/') + 1) + "/counters/";
      for (const char* c : kCounters) {
        const std::string raw = ReadFirstLine(cdir + c);
        if (raw.empty()) continue;
        unsigned long long v = 0;
        try {
          v = std::stoull(raw);
        } catch (...) {
          continue;
        }
        auto it = h.last.find(c);
        if (it != h.last.end() && v > it->second) {
          h.rises.emplace_back(now, std::string(c) + " +" + std::to_string(v - it->second));
        }
        h.last[c] = v;  // a decrease is a counter reset: take it as the new base
      }
      while (!h.rises.empty() && now - h.rises.front().first > kIbErrorWindow) h.rises.pop_front();
      if (!h.rises.empty()) {
        status = std::max(status, kWarn);
        text += " - errors in last 15 min: ";
        for (std::size_t i = 0; i < h.rises.size() && i < 4; ++i) {
          text += (i ? ", " : "") + h.rises[i].second;
        }
      }
      items.push_back({"ib:" + p.id, status, text});
    }
  }

  // ---- net: Ethernet links ------------------------------------------------
  // Physical Ethernet interfaces only (IPoIB is covered by the ib group). A
  // port with an IPv4 address is in use and must be up at >= 1 Gb/s; a port
  // without one is reported as unused, never as a fault.
  void CheckNetwork(std::vector<Item>& items) {
    std::map<std::string, std::string> addrs;
    ifaddrs* list = nullptr;
    if (getifaddrs(&list) == 0) {
      for (ifaddrs* a = list; a != nullptr; a = a->ifa_next) {
        if (a->ifa_addr == nullptr || a->ifa_addr->sa_family != AF_INET) continue;
        char buf[INET_ADDRSTRLEN] = {0};
        const auto* sin = reinterpret_cast<sockaddr_in*>(a->ifa_addr);
        if (inet_ntop(AF_INET, &sin->sin_addr, buf, sizeof(buf)) != nullptr) {
          addrs[a->ifa_name] = buf;
        }
      }
      freeifaddrs(list);
    }
    for (const std::string& ifname : ListDir("/sys/class/net")) {
      const std::string base = "/sys/class/net/" + ifname;
      if (access((base + "/device").c_str(), F_OK) != 0) continue;  // virtual
      if (ReadFirstLine(base + "/type") != "1") continue;             // not Ethernet
      const std::string oper = ReadFirstLine(base + "/operstate");
      const std::string carrier = ReadFirstLine(base + "/carrier");
      const std::string speed = ReadFirstLine(base + "/speed");
      long mbps = 0;
      try {
        mbps = std::stol(speed);
      } catch (...) {
      }
      const auto addr = addrs.find(ifname);
      if (addr == addrs.end()) {
        items.push_back({"net:" + ifname, kOk, ifname + ": unused (no IPv4 address, link " +
                                                   oper + ")"});
        continue;
      }
      std::string text = ifname + " " + addr->second + ": " + oper;
      int status = kOk;
      if (oper != "up" || carrier != "1") {
        status = kFail;
        text += ", no carrier";
      } else if (mbps > 0) {
        text += ", " + (mbps >= 1000 ? std::to_string(mbps / 1000) + " Gb/s"
                                     : std::to_string(mbps) + " Mb/s");
        if (mbps < 1000) {
          status = kWarn;
          text += " - below 1 Gb/s, check cable/switch port";
        }
      }
      items.push_back({"net:" + ifname, status, text});
    }
  }

  // ---- svc: systemd units -----------------------------------------------------
  void CheckServices(std::vector<Item>& items) {
    std::string cmd = "timeout 10s systemctl show --no-pager "
                      "-p Id,LoadState,ActiveState,SubState,UnitFileState";
    for (const char* u : kUnits) cmd += std::string(" ") + u + ".service";
    cmd += " 2>/dev/null";
    std::string output;
    RunCommand(cmd, output);  // non-zero when some units are missing; still parse

    std::map<std::string, std::string> props;
    std::set<std::string> reported;
    auto flush = [&]() {
      if (props.empty()) return;
      std::string id = props["Id"];
      const std::string dot = ".service";
      if (id.size() > dot.size() && id.compare(id.size() - dot.size(), dot.size(), dot) == 0) {
        id.resize(id.size() - dot.size());
      }
      const std::string load = props["LoadState"];
      const std::string active = props["ActiveState"];
      const std::string file = props["UnitFileState"];
      props.clear();
      if (load != "loaded" || id.empty()) return;
      // sshd and ssh are aliases of one unit on Ubuntu: report it once.
      if (!reported.insert(id).second) return;
      const bool wanted = file == "enabled" || file == "static" || file == "alias" ||
                          file == "enabled-runtime" || active == "active";
      if (!wanted) return;
      int status = kOk;
      if (active == "failed" || active == "inactive") status = kFail;
      else if (active != "active") status = kWarn;
      items.push_back({"svc:" + id, status, id + ": " + active + " (" + file + ")"});
    };
    std::istringstream in(output);
    std::string line;
    while (std::getline(in, line)) {
      if (Trim(line).empty()) {
        flush();
        continue;
      }
      const auto eq = line.find('=');
      if (eq != std::string::npos) props[line.substr(0, eq)] = line.substr(eq + 1);
    }
    flush();

    // Anything else systemd considers failed.
    if (RunCommand("timeout 10s systemctl --failed --no-legend --plain --no-pager 2>/dev/null",
                   output)) {
      std::vector<std::string> failed;
      std::istringstream fin(output);
      while (std::getline(fin, line)) {
        std::istringstream ls(line);
        std::string unit;
        ls >> unit;
        if (!unit.empty()) failed.push_back(unit);
      }
      std::string text = failed.empty() ? "no failed units" : "failed: ";
      for (std::size_t i = 0; i < failed.size(); ++i) text += (i ? ", " : "") + failed[i];
      items.push_back({"svc:failed-units", failed.empty() ? kOk : kWarn, text});
    }
  }

  // ---- slurm: this node's state as slurmctld sees it ---------------------
  void CheckSlurmNode(std::vector<Item>& items) {
    if (hostname_.empty()) return;
    std::string output;
    if (!RunCommand("timeout 10s scontrol show node -o " + hostname_ + " 2>&1", output)) {
      if (output.find("not found") != std::string::npos ||
          output.find("Invalid node name") != std::string::npos) {
        return;  // not a Slurm node
      }
      if (access("/usr/bin/scontrol", X_OK) != 0) return;
      items.push_back({"slurm:node", kFail, "scontrol failed: " + Trim(output)});
      return;
    }
    auto field = [&](const std::string& key) {
      const auto p = output.find(" " + key + "=");
      if (p == std::string::npos) return std::string();
      const auto start = p + key.size() + 2;
      // Reason is the one free-text field; it runs to the next " Key=".
      if (key == "Reason") {
        auto end = start;
        while (true) {
          end = output.find(' ', end + 1);
          if (end == std::string::npos) break;
          const auto eq = output.find('=', end);
          const auto sp = output.find(' ', end + 1);
          if (eq != std::string::npos && (sp == std::string::npos || eq < sp)) break;
        }
        return Trim(output.substr(start, end == std::string::npos ? std::string::npos
                                                                  : end - start));
      }
      return output.substr(start, output.find_first_of(" \n", start) - start);
    };
    const std::string state = field("State");
    const std::string reason = field("Reason");
    int status = kOk;
    for (const char* bad : {"DOWN", "FAIL", "NOT_RESPONDING", "INVALID", "UNKNOWN"}) {
      if (state.find(bad) != std::string::npos) status = kFail;
    }
    if (status == kOk && state.find("DRAIN") != std::string::npos) status = kWarn;
    std::string text = "Slurm state " + state;
    if (!reason.empty() && reason != "(null)") text += ", reason: " + reason;
    items.push_back({"slurm:node", status, text});
  }

  // ---- gpu: presence, memory errors, hardware slowdown, Xid ----------------
  void CheckGpus(std::vector<Item>& items) {
    int pci_gpus = 0;
    for (const std::string& dev : ListDir("/sys/bus/pci/devices")) {
      const std::string base = "/sys/bus/pci/devices/" + dev;
      if (ReadFirstLine(base + "/vendor") != "0x10de") continue;
      const std::string cls = ReadFirstLine(base + "/class");
      if (cls.rfind("0x0300", 0) == 0 || cls.rfind("0x0302", 0) == 0) ++pci_gpus;
    }
    if (pci_gpus == 0) return;  // no NVIDIA GPU in this node

    std::string output;
    const bool ok = RunCommand(
        "timeout 20s nvidia-smi --query-gpu=index,ecc.errors.uncorrected.volatile.total,"
        "remapped_rows.pending,remapped_rows.failure,clocks_event_reasons.hw_slowdown,"
        "clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.hw_power_brake_slowdown "
        "--format=csv,noheader,nounits 2>&1",
        output);
    if (!ok) {
      items.push_back({"gpu:driver", kFail, "nvidia-smi failed: " + Trim(output)});
      return;
    }
    int visible = 0;
    std::vector<std::string> ecc, remap_pending, remap_failed, slowdown;
    std::istringstream in(output);
    std::string line;
    while (std::getline(in, line)) {
      std::vector<std::string> f;
      std::istringstream ls(line);
      std::string cell;
      while (std::getline(ls, cell, ',')) f.push_back(Trim(cell));
      if (f.size() < 7) continue;
      ++visible;
      const std::string& idx = f[0];
      if (f[1] != "0" && f[1] != "[N/A]" && f[1] != "N/A") ecc.push_back(idx + ":" + f[1]);
      if (f[2] == "Yes") remap_pending.push_back(idx);
      if (f[3] == "Yes") remap_failed.push_back(idx);
      if (f[4] == "Active") slowdown.push_back(idx + " hw");
      if (f[5] == "Active") slowdown.push_back(idx + " thermal");
      if (f[6] == "Active") slowdown.push_back(idx + " power-brake");
    }
    auto join = [](const std::vector<std::string>& v) {
      std::string s;
      for (std::size_t i = 0; i < v.size(); ++i) s += (i ? ", " : "") + v[i];
      return s;
    };

    items.push_back({"gpu:count", visible == pci_gpus ? kOk : kFail,
                     std::to_string(visible) + " of " + std::to_string(pci_gpus) +
                         " GPUs on the PCI bus visible to the driver"});

    int mem_status = kOk;
    std::string mem_text = "no uncorrected ECC errors, no pending row remaps";
    if (!ecc.empty() || !remap_failed.empty()) {
      mem_status = kFail;
      mem_text = "";
      if (!ecc.empty()) mem_text += "uncorrected ECC errors (GPU:count) " + join(ecc);
      if (!remap_failed.empty()) mem_text += (mem_text.empty() ? "" : "; ") +
                                             std::string("row remap FAILED on GPU ") +
                                             join(remap_failed);
    } else if (!remap_pending.empty()) {
      mem_status = kWarn;
      mem_text = "row remap pending on GPU " + join(remap_pending) + " - reset the GPU when idle";
    }
    items.push_back({"gpu:memory", mem_status, mem_text});

    items.push_back({"gpu:slowdown", slowdown.empty() ? kOk : kWarn,
                     slowdown.empty() ? "no hardware slowdown (power cap throttling is normal)"
                                      : "hardware slowdown active: GPU " + join(slowdown)});

    // Xid errors in the kernel log over the last 15 minutes.
    RunCommand("timeout 10s journalctl -k -q --no-pager -o cat --since=-15min "
               "--grep='NVRM: Xid' 2>/dev/null",
               output);
    int xid_count = 0;
    int xid_status = kOk;
    std::string last_xid;
    std::istringstream xin(output);
    while (std::getline(xin, line)) {
      const auto p = line.find("Xid");
      if (p == std::string::npos) continue;
      ++xid_count;
      last_xid = line.substr(line.find("NVRM:"));
      // "NVRM: Xid (PCI:0000:03:00): 79, pid=..."
      const auto colon = line.find("): ", p);
      int code = 0;
      if (colon != std::string::npos) {
        try {
          code = std::stoi(line.substr(colon + 3));
        } catch (...) {
        }
      }
      xid_status = std::max(xid_status, kSevereXids.count(code) ? kFail : kWarn);
    }
    items.push_back({"gpu:xid", xid_status,
                     xid_count == 0 ? "no Xid errors in the last 15 min"
                                    : std::to_string(xid_count) + " Xid error(s) in last 15 min, "
                                      "latest: " + last_xid});
  }

  std::string hostname_;
  bool first_ = true;
  Clock::time_point last_slow_{};
  std::vector<Item> slow_items_;
  std::map<std::string, NfsProbe> nfs_probes_;
  std::map<std::string, CounterHistory> ib_history_;
};

}  // namespace

CollectorPtr CreateHealthCollector() {
  return std::make_unique<HealthCollector>();
}
