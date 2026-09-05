#pragma once
#include <windows.h>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
struct mpv_handle;
struct mpv_event;
struct MpvLoadState{std::string loadId;std::string status;std::string error;};
class MpvLoader {
 public:
  MpvLoader()=default;~MpvLoader();MpvLoader(const MpvLoader&)=delete;MpvLoader& operator=(const MpvLoader&)=delete;
  bool initialize(const std::filesystem::path& dllPath,std::string& error,bool nullAudioOutput=false);
  bool startLoad(const std::string& url,const std::string& headerFields,std::string& loadId,std::string& error);
  MpvLoadState loadState()const;
  bool setProperty(const std::string& name,const std::string& value,std::string& error);
  bool getProperty(const std::string& name,std::string& value,std::string& error);
  bool command(const std::vector<std::string>& args,std::string& error);
  bool available()const noexcept{return handle_!=nullptr;}
 private:
  HMODULE module_=nullptr;mpv_handle* handle_=nullptr;
  using create_fn=mpv_handle*(*)();using initialize_fn=int(*)(mpv_handle*);using terminate_destroy_fn=void(*)(mpv_handle*);using set_option_string_fn=int(*)(mpv_handle*,const char*,const char*);using set_property_string_fn=int(*)(mpv_handle*,const char*,const char*);using get_property_string_fn=char*(*)(mpv_handle*,const char*);using free_fn=void(*)(void*);using command_fn=int(*)(mpv_handle*,const char**);using command_async_fn=int(*)(mpv_handle*,std::uint64_t,const char**);using error_string_fn=const char*(*)(int);using wait_event_fn=mpv_event*(*)(mpv_handle*,double);
  terminate_destroy_fn terminateDestroy_=nullptr;set_property_string_fn setPropertyString_=nullptr;get_property_string_fn getPropertyString_=nullptr;free_fn free_=nullptr;command_fn command_=nullptr;command_async_fn commandAsync_=nullptr;error_string_fn errorString_=nullptr;wait_event_fn waitEvent_=nullptr;
  mutable std::mutex loadMutex_;std::thread eventThread_;std::atomic<bool> stopEvents_{false};std::uint64_t loadGeneration_=0;bool loadStarted_=false;std::string loadId_;std::string loadStatus_="idle";std::string loadError_;std::string headerFields_;
  void eventLoop();void failCurrentLoad(const std::string& message);
  std::string errorMessage(const char* action,int code)const;
};
