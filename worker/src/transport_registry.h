#pragma once

#include "transport.h"

#include <string>
#include <vector>

TransportPtr CreateTransport(const std::string& name);
std::vector<std::string> BuiltinTransports();
