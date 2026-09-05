#pragma once
#include <functional>
#include <mutex>
#include <string>
class NamedPipeServer {
 public:
  using Handler=std::function<std::string(const std::string&)>;
  NamedPipeServer(std::wstring pipeName,Handler handler);
  int run();
 private:
  std::wstring pipeName_;
  Handler handler_;
  std::mutex handlerMutex_;
};
