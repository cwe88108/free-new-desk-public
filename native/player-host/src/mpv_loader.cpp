#include "mpv_loader.h"
#include <sstream>

struct mpv_event { int event_id; int error; std::uint64_t reply_userdata; void* data; };

namespace {
struct mpv_event_end_file_head { int reason; int error; };
constexpr int MPV_EVENT_NONE=0;
constexpr int MPV_EVENT_SHUTDOWN=1;
constexpr int MPV_EVENT_COMMAND_REPLY=5;
constexpr int MPV_EVENT_START_FILE=6;
constexpr int MPV_EVENT_END_FILE=7;
constexpr int MPV_EVENT_FILE_LOADED=8;
}

MpvLoader::~MpvLoader(){
  stopEvents_.store(true);
  if(eventThread_.joinable())eventThread_.join();
  if(handle_&&terminateDestroy_)terminateDestroy_(handle_);
  handle_=nullptr;
  if(module_)FreeLibrary(module_);
  module_=nullptr;
}

std::string MpvLoader::errorMessage(const char* action,int code)const{
  std::ostringstream out;
  out<<action<<" failed";
  if(errorString_){if(const char* text=errorString_(code);text&&*text)out<<": "<<text;}
  out<<" (mpv "<<code<<")";
  return out.str();
}

bool MpvLoader::initialize(const std::filesystem::path& dllPath,std::string& error,bool nullAudioOutput){
  module_=LoadLibraryW(dllPath.c_str());
  if(!module_){error="Could not load libmpv-2.dll";return false;}
  const auto create=reinterpret_cast<create_fn>(GetProcAddress(module_,"mpv_create"));
  const auto initialize=reinterpret_cast<initialize_fn>(GetProcAddress(module_,"mpv_initialize"));
  terminateDestroy_=reinterpret_cast<terminate_destroy_fn>(GetProcAddress(module_,"mpv_terminate_destroy"));
  const auto setOption=reinterpret_cast<set_option_string_fn>(GetProcAddress(module_,"mpv_set_option_string"));
  setPropertyString_=reinterpret_cast<set_property_string_fn>(GetProcAddress(module_,"mpv_set_property_string"));
  getPropertyString_=reinterpret_cast<get_property_string_fn>(GetProcAddress(module_,"mpv_get_property_string"));
  free_=reinterpret_cast<free_fn>(GetProcAddress(module_,"mpv_free"));
  command_=reinterpret_cast<command_fn>(GetProcAddress(module_,"mpv_command"));
  commandAsync_=reinterpret_cast<command_async_fn>(GetProcAddress(module_,"mpv_command_async"));
  errorString_=reinterpret_cast<error_string_fn>(GetProcAddress(module_,"mpv_error_string"));
  waitEvent_=reinterpret_cast<wait_event_fn>(GetProcAddress(module_,"mpv_wait_event"));
  if(!create||!initialize||!terminateDestroy_||!setOption||!setPropertyString_||!getPropertyString_||!free_||!command_||!commandAsync_||!waitEvent_){error="libmpv API is incomplete";return false;}
  handle_=create();
  if(!handle_){error="mpv_create returned null";return false;}
  setOption(handle_,"hwdec","auto-safe");
  setOption(handle_,"vo","gpu-next");
  setOption(handle_,"gpu-api","d3d11");
  setOption(handle_,"force-window",nullAudioOutput?"immediate":"yes");
  setOption(handle_,"keep-open","yes");
  setOption(handle_,"cache","yes");
  setOption(handle_,"demuxer-max-bytes","512MiB");
  setOption(handle_,"target-colorspace-hint","yes");
  setOption(handle_,"input-default-bindings","yes");
  setOption(handle_,"osc","no");
  if(nullAudioOutput)setOption(handle_,"ao","null");
  const int result=initialize(handle_);
  if(result<0){error=errorMessage("mpv_initialize",result);return false;}
  stopEvents_.store(false);
  eventThread_=std::thread([this](){eventLoop();});
  return true;
}

bool MpvLoader::setProperty(const std::string& name,const std::string& value,std::string& error){
  if(!handle_||!setPropertyString_){error="libmpv is not initialized";return false;}
  const int result=setPropertyString_(handle_,name.c_str(),value.c_str());
  if(result<0){error=errorMessage("mpv_set_property_string",result);return false;}
  return true;
}

bool MpvLoader::getProperty(const std::string& name,std::string& value,std::string& error){
  if(!handle_||!getPropertyString_||!free_){error="libmpv is not initialized";return false;}
  char* raw=getPropertyString_(handle_,name.c_str());
  if(!raw){error="mpv_get_property_string failed for "+name;return false;}
  value=raw;
  free_(raw);
  return true;
}

bool MpvLoader::command(const std::vector<std::string>& args,std::string& error){
  if(!handle_||!command_){error="libmpv is not initialized";return false;}
  std::vector<const char*> raw;
  raw.reserve(args.size()+1);
  for(const auto& arg:args)raw.push_back(arg.c_str());
  raw.push_back(nullptr);
  const int result=command_(handle_,raw.data());
  if(result<0){error=errorMessage("mpv_command",result);return false;}
  return true;
}

void MpvLoader::failCurrentLoad(const std::string& message){
  std::lock_guard<std::mutex> lock(loadMutex_);
  loadStatus_="failed";
  loadError_=message;
}

bool MpvLoader::startLoad(const std::string& url,const std::string& headerFields,std::string& loadId,std::string& error){
  if(!handle_||!waitEvent_||!commandAsync_){error="libmpv event API is unavailable";return false;}
  std::uint64_t generation=0;
  {
    std::lock_guard<std::mutex> lock(loadMutex_);
    generation=++loadGeneration_;
    loadId_=std::to_string(generation);
    loadId=loadId_;
    loadStatus_="loading";
    loadError_.clear();
    loadStarted_=false;
  }
  if(headerFields_!=headerFields){
    if(!setProperty("http-header-fields",headerFields,error)){failCurrentLoad(error);return false;}
    headerFields_=headerFields;
  }
  const char* args[]={"loadfile",url.c_str(),"replace",nullptr};
  const int result=commandAsync_(handle_,generation,args);
  if(result<0){error=errorMessage("mpv_command_async",result);failCurrentLoad(error);return false;}
  return true;
}

MpvLoadState MpvLoader::loadState()const{
  std::lock_guard<std::mutex> lock(loadMutex_);
  return{loadId_,loadStatus_,loadError_};
}

void MpvLoader::eventLoop(){
  while(!stopEvents_.load()){
    auto* event=waitEvent_?waitEvent_(handle_,0.10):nullptr;
    if(!event||event->event_id==MPV_EVENT_NONE)continue;
    if(event->event_id==MPV_EVENT_COMMAND_REPLY){
      if(event->error<0){
        std::lock_guard<std::mutex> lock(loadMutex_);
        if(event->reply_userdata==loadGeneration_&&loadStatus_=="loading"){
          loadStatus_="failed";
          loadError_=errorMessage("mpv async load command",event->error);
        }
      }
      continue;
    }
    if(event->event_id==MPV_EVENT_START_FILE){
      std::lock_guard<std::mutex> lock(loadMutex_);
      loadStarted_=true;
      loadStatus_="loading";
      loadError_.clear();
      continue;
    }
    if(event->event_id==MPV_EVENT_FILE_LOADED){
      std::lock_guard<std::mutex> lock(loadMutex_);
      if(loadStarted_){loadStatus_="loaded";loadError_.clear();}
      continue;
    }
    if(event->event_id==MPV_EVENT_SHUTDOWN){
      std::lock_guard<std::mutex> lock(loadMutex_);
      if(loadStatus_=="loading"){loadStatus_="failed";loadError_="mpv shut down while opening media";}
      continue;
    }
    if(event->event_id==MPV_EVENT_END_FILE){
      int code=event->error;
      if(event->data){
        const auto* end=static_cast<const mpv_event_end_file_head*>(event->data);
        if(end->error<0)code=end->error;
      }
      std::lock_guard<std::mutex> lock(loadMutex_);
      if(!loadStarted_)continue;
      if(code<0){
        loadStatus_="failed";
        loadError_=errorMessage("mpv media open",code);
      }else if(loadStatus_=="loading"){
        loadStatus_="ended";
        loadError_="media ended before FILE_LOADED";
      }
      loadStarted_=false;
    }
  }
}
