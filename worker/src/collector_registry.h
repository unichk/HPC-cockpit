#pragma once

#include "collector.h"
#include "config.h"

#include <string>
#include <vector>

CollectorPtr CreateCollector(const std::string& name, const WorkerConfig& config);
std::vector<std::string> BuiltinCollectors();
