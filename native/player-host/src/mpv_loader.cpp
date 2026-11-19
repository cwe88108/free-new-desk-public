#include "mpv_loader.h"
#include <cstring>
#include <sstream>

// Stable public libmpv client.h ABI. loadfile returns a NODE_MAP containing an INT64 entry ID.
// https://github.com/mpv-player/mpv/blob/c1529642089bfebfc928a1c1664638a7a5d219ba/include/mpv/client.h
struct mpv_node_list;
struct mpv_byte_array;
enum mpv_format : int { MPV_FORMAT_NONE=0, MPV_FORMAT_STRING=1, MPV_FORMAT_OSD_STRING=2,
  MPV_FORMAT_FLAG=3, MPV_FORMAT_INT64=4, MPV_FORMAT_DOUBLE=5, MPV_FORMAT_NODE=6,
  MPV_FORMAT_NODE_ARRAY=7, MPV_FORMAT_NODE_MAP=8, MPV_FORMAT_BYTE_ARRAY=9 };
struct mpv_node { union { char* string; int flag; std::int64_t int64; double double_; mpv_node_list* list; mpv_byte_array* ba; } u; mpv_format format; };
struct mpv_node_list { int num; mpv_node* values; char** keys; };

struct mpv_event { int event_id; int error; std::uint64_t reply_userdata; void* data; };

namespace {
struct mpv_event_start_file_head { std::int64_t playlist_entry_id; };
struct mpv_event_end_file_head { int reason; int error; std::int64_t playlist_entry_id; std::int64_t playlist_insert_id; int playlist_insert_num_entries; };
constexpr int MPV_EVENT_NONE=0;
constexpr int MPV_EVENT_SHUTDOWN=1;
constexpr int MPV_EVENT_COMMAND_REPLY=5;
constexpr int MPV_EVENT_START_FILE=6;
constexpr int MPV_EVENT_END_FILE=7;
constexpr int MPV_EVENT_FILE_LOADED=8;
constexpr int MPV_EVENT_VIDEO_RECONFIG=17;
constexpr int MPV_END_FILE_REASON_EOF=0;
constexpr int MPV_END_FILE_REASON_STOP=2;
constexpr int MPV_END_FILE_REASON_QUIT=3;
constexpr int MPV_END_FILE_REASON_ERROR=4;
constexpr int MPV_END_FILE_REASON_REDIRECT=5;
constexpr const char* FND_SEGMENT_MARKER="#fnd-segment=";
std::string end_reason_name(int reason){
  switch(reason){
    case MPV_END_FILE_REASON_EOF:return "eof";
    case MPV_END_FILE_REASON_STOP:return "stop";
    case MPV_END_FILE_REASON_QUIT:return "quit";
    case MPV_END_FILE_REASON_ERROR:return "error";
    case MPV_END_FILE_REASON_REDIRECT:return "redirect";
    default:return "unknown";
  }
}
struct SegmentLoad{std::string url;std::string options;};
SegmentLoad parse_segment_load(const std::string& input){
  const auto marker=input.rfind(FND_SEGMENT_MARKER);if(marker==std::string::npos)return{input,{}};
  const auto payload=input.substr(marker+std::char_traits<char>::length(FND_SEGMENT_MARKER));const auto comma=payload.find(',');if(comma==std::string::npos)return{input,{}};
  const auto start=payload.substr(0,comma),end=payload.substr(comma+1);try{const double startValue=std::stod(start);if(startValue<0)return{input,{}};std::ostringstream options;options<<"start="<<startValue;if(!end.empty()){const double endValue=std::stod(end);if(endValue<=startValue)return{input,{}};options<<",end="<<endValue;}return{input.substr(0,marker),options.str()};}catch(...){return{input,{}};}
}
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
  getProperty_=reinterpret_cast<get_property_fn>(GetProcAddress(module_,"mpv_get_property"));
  free_=reinterpret_cast<free_fn>(GetProcAddress(module_,"mpv_free"));
  command_=reinterpret_cast<command_fn>(GetProcAddress(module_,"mpv_command"));
  commandRet_=reinterpret_cast<command_ret_fn>(GetProcAddress(module_,"mpv_command_ret"));
  freeNodeContents_=reinterpret_cast<free_node_contents_fn>(GetProcAddress(module_,"mpv_free_node_contents"));
  commandAsync_=reinterpret_cast<command_async_fn>(GetProcAddress(module_,"mpv_command_async"));
  errorString_=reinterpret_cast<error_string_fn>(GetProcAddress(module_,"mpv_error_string"));
  waitEvent_=reinterpret_cast<wait_event_fn>(GetProcAddress(module_,"mpv_wait_event"));
  if(!create||!initialize||!terminateDestroy_||!setOption||!setPropertyString_||!getPropertyString_||!getProperty_||!free_||!command_||!commandRet_||!freeNodeContents_||!commandAsync_||!waitEvent_){error="libmpv API is incomplete";return false;}
  handle_=create();
  if(!handle_){error="mpv_create returned null";return false;}
  const int tlsVerification=setOption(handle_,"tls-verify","yes");
  if(tlsVerification<0){error=errorMessage("mpv tls-verify",tlsVerification);return false;}
  const auto trustBundle=dllPath.parent_path()/L"player-public-roots.pem";
  std::error_code trustBundleError;
  if(std::filesystem::is_regular_file(trustBundle,trustBundleError)){
    const auto utf8Path=trustBundle.u8string();
    const int tlsCaFile=setOption(handle_,"tls-ca-file",reinterpret_cast<const char*>(utf8Path.c_str()));
    if(tlsCaFile<0){error=errorMessage("mpv tls-ca-file",tlsCaFile);return false;}
  }
  setOption(handle_,"hwdec","auto-safe");
  setOption(handle_,"vo","gpu-next");
  setOption(handle_,"gpu-api","d3d11");
  setOption(handle_,"force-window","immediate");
  // Prewarm must not activate mpv's temporary top-level window before embedding.
  // The surface owner restores it without activation when video becomes visible.
  const int minimizedOption=setOption(handle_,"window-minimized","yes");
  if(minimizedOption<0){error=errorMessage("mpv window-minimized",minimizedOption);return false;}
  setOption(handle_,"keep-open","yes");
  setOption(handle_,"cache","yes");
  setOption(handle_,"demuxer-max-bytes","512MiB");
  setOption(handle_,"target-colorspace-hint","yes");
  setOption(handle_,"input-default-bindings","yes");
  setOption(handle_,"input-cursor","yes");
  setOption(handle_,"osc","yes");
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

std::int64_t MpvLoader::getIntegerProperty(const char* name){
  std::int64_t value=0;
  if(!handle_||!getProperty_||getProperty_(handle_,name,MPV_FORMAT_INT64,&value)<0)return 0;
  return value;
}

MpvCacheUsage MpvLoader::cacheUsage(){
  mpv_node state{};
  MpvCacheUsage usage;
  if(!handle_||getProperty_(handle_,"demuxer-cache-state",MPV_FORMAT_NODE,&state)<0)return usage;
  if(state.format==MPV_FORMAT_NODE_MAP&&state.u.list){
    const auto& fields=*state.u.list;
    for(int i=0;i<fields.num;++i){
      const auto& field=fields.values[i];
      if(field.format!=MPV_FORMAT_INT64)continue;
      if(std::strcmp(fields.keys[i],"fw-bytes")==0)usage.forwardBytes=field.u.int64;
      if(std::strcmp(fields.keys[i],"total-bytes")==0)usage.totalBytes=field.u.int64;
    }
  }
  freeNodeContents_(&state);
  return usage;
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
  if(!handle_||!waitEvent_||!commandRet_||!freeNodeContents_){error="libmpv event API is unavailable";return false;}
  std::lock_guard<std::mutex> lock(loadMutex_);
  loadId_=std::to_string(GetCurrentProcessId())+"-"+std::to_string(GetTickCount64())+"-"+std::to_string(++loadGeneration_);loadId=loadId_;
  loadStatus_="loading";loadError_.clear();loadStarted_=false;activeEntryId_=-1;
  if(headerFields_!=headerFields){
    if(!setProperty("http-header-fields",headerFields,error)){loadStatus_="failed";loadError_=error;return false;}
    headerFields_=headerFields;
  }
  const auto segment=parse_segment_load(url);
  std::vector<std::string> values={"loadfile",segment.url,"replace"};
  if(!segment.options.empty()){values.push_back("-1");values.push_back(segment.options);}
  std::vector<const char*> raw;
  for(const auto& value:values)raw.push_back(value.c_str());
  raw.push_back(nullptr);
  mpv_node result{};
  const int status=commandRet_(handle_,raw.data(),&result);
  if(status<0){error=errorMessage("mpv loadfile",status);loadStatus_="failed";loadError_=error;return false;}
  // Capture the command's own entry ID while holding loadMutex_: queued START_FILE
  // events for a replaced request must never become the owner of this load.
  if(result.format==MPV_FORMAT_NODE_MAP&&result.u.list){
    const auto& map=*result.u.list;
    for(int i=0;i<map.num;++i){
      if(map.keys&&map.values&&map.keys[i]&&std::string(map.keys[i])=="playlist_entry_id"&&map.values[i].format==MPV_FORMAT_INT64)
        activeEntryId_=map.values[i].u.int64;
    }
  }
  freeNodeContents_(&result);
  eventEntryId_=-1;
  if(activeEntryId_<0){error="libmpv loadfile did not return a playlist entry ID";loadStatus_="failed";loadError_=error;return false;}
  return true;
}

MpvLoadState MpvLoader::loadState()const{
  std::lock_guard<std::mutex> lock(loadMutex_);
  return{loadId_,loadStatus_,loadError_};
}

bool MpvLoader::sampleReady()const{
  std::lock_guard<std::mutex> lock(loadMutex_);
  return loadStatus_=="loaded"&&loadStarted_&&eventEntryId_==activeEntryId_;
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
      const std::int64_t entry=event->data?static_cast<const mpv_event_start_file_head*>(event->data)->playlist_entry_id:-1;
      // FILE_LOADED has no ID. Associate it with the most recent START_FILE
      // in this ordered event stream, even when that START_FILE is stale.
      eventEntryId_=entry;
      if(loadStatus_=="loading"&&entry>=0&&entry==activeEntryId_){
        loadStarted_=true;
        loadError_.clear();
      }
      continue;
    }
    if(event->event_id==MPV_EVENT_VIDEO_RECONFIG){
      if(surfaceChanged_)surfaceChanged_();
      continue;
    }
    if(event->event_id==MPV_EVENT_FILE_LOADED){
      // Apply the current embedding intent after mpv may have resized or shown its window.
      // No load mutex is held while the owner performs Win32 window operations.
      if(surfaceChanged_)surfaceChanged_();
      std::lock_guard<std::mutex> lock(loadMutex_);
      if(loadStatus_=="loading"&&loadStarted_&&eventEntryId_==activeEntryId_){loadStatus_="loaded";loadError_.clear();}
      continue;
    }
    if(event->event_id==MPV_EVENT_SHUTDOWN){
      std::lock_guard<std::mutex> lock(loadMutex_);
      if(loadStatus_=="loading"){loadStatus_="failed";loadError_="mpv shut down while opening media";}
      continue;
    }
    if(event->event_id==MPV_EVENT_END_FILE){
      int code=event->error;
      int reason=-1;
      if(event->data){
        const auto* end=static_cast<const mpv_event_end_file_head*>(event->data);
        reason=end->reason;
        if(end->error<0)code=end->error;
      }
      std::lock_guard<std::mutex> lock(loadMutex_);
      if(!loadStarted_||!event->data||static_cast<const mpv_event_end_file_head*>(event->data)->playlist_entry_id!=activeEntryId_)continue;
      if(code<0||reason==MPV_END_FILE_REASON_ERROR){
        loadStatus_="failed";
        loadError_=errorMessage("mpv media",code<0?code:-1);
      }else if(reason==MPV_END_FILE_REASON_REDIRECT){
        const auto* end=static_cast<const mpv_event_end_file_head*>(event->data);
        // Playlist expansion is a continuation, not HTTP redirect failure. Accept only
        // the inserted child START_FILE; a late event must not take over this load.
        loadStarted_=false;
        eventEntryId_=-1;
        if(end->playlist_insert_num_entries>0&&end->playlist_insert_id>=0){
          activeEntryId_=end->playlist_insert_id;
          loadStatus_="loading";
          loadError_.clear();
        }else{
          loadStatus_="failed";
          loadError_="redirect-empty-playlist";
        }
        continue;
      }else if(reason==MPV_END_FILE_REASON_EOF){
        loadStatus_="ended";
        loadError_="eof";
      }else if(loadStatus_=="loaded"){
        loadStatus_="ended";
        loadError_=end_reason_name(reason);
      }else if(loadStatus_=="loading"){
        loadStatus_="ended";
        loadError_=end_reason_name(reason)+"-before-loaded";
      }
      loadStarted_=false;
    }
  }
}
