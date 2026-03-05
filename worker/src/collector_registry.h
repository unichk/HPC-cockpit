#pragma once

#include "collector.h"

#include <string>
#include <vector>

CollectorPtr CreateCollector(const std::string& name);
std::vector<std::string> BuiltinCollectors();
