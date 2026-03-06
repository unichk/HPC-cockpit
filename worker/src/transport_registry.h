#pragma once

#include "config.h"
#include "transport.h"

#include <string>
#include <vector>

TransportPtr CreateTransport(const WorkerConfig& config, std::string& error);
std::vector<std::string> BuiltinTransports();
