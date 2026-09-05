#include "named_pipe_server.h"
#include <windows.h>
#include <array>
#include <atomic>
#include <thread>
#include <vector>

NamedPipeServer::NamedPipeServer(std::wstring pipeName,Handler handler):pipeName_(std::move(pipeName)),handler_(std::move(handler)){}

int NamedPipeServer::run(){
  constexpr int listenerCount=4;
  std::atomic<int> exitCode{0};
  std::vector<std::thread> listeners;
  listeners.reserve(listenerCount);
  for(int listener=0;listener<listenerCount;++listener){
    listeners.emplace_back([this,&exitCode](){
      for(;;){
        HANDLE pipe=CreateNamedPipeW(pipeName_.c_str(),PIPE_ACCESS_DUPLEX,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT,PIPE_UNLIMITED_INSTANCES,64*1024,64*1024,0,nullptr);
        if(pipe==INVALID_HANDLE_VALUE){exitCode.store(2);return;}
        const BOOL connected=ConnectNamedPipe(pipe,nullptr)?TRUE:(GetLastError()==ERROR_PIPE_CONNECTED);
        if(!connected){CloseHandle(pipe);continue;}
        std::string pending;
        std::array<char,4096> buffer{};
        DWORD read=0;
        while(ReadFile(pipe,buffer.data(),static_cast<DWORD>(buffer.size()),&read,nullptr)&&read>0){
          pending.append(buffer.data(),read);
          std::size_t pos=0;
          while((pos=pending.find('\n'))!=std::string::npos){
            const auto line=pending.substr(0,pos);
            pending.erase(0,pos+1);
            const std::string response=handler_(line)+"\n";
            DWORD written=0;
            WriteFile(pipe,response.data(),static_cast<DWORD>(response.size()),&written,nullptr);
            FlushFileBuffers(pipe);
          }
        }
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
      }
    });
  }
  for(auto& listener:listeners)listener.join();
  return exitCode.load();
}
