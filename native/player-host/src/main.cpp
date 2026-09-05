#include "mpv_loader.h"
#include "named_pipe_server.h"

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace {

std::string escape_json(const std::string& value) {
  std::string out;
  for (char c : value) {
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out += c;
    }
  }
  return out;
}

std::optional<std::string> json_string(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return std::nullopt;
  pos = json.find(':', pos + needle.size());
  if (pos == std::string::npos) return std::nullopt;
  pos = json.find('"', pos + 1);
  if (pos == std::string::npos) return std::nullopt;

  std::string out;
  bool escaped = false;
  for (size_t i = pos + 1; i < json.size(); ++i) {
    const char c = json[i];
    if (escaped) {
      switch (c) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        default: out += c;
      }
      escaped = false;
      continue;
    }
    if (c == '\\') {
      escaped = true;
      continue;
    }
    if (c == '"') return out;
    out += c;
  }
  return std::nullopt;
}

std::optional<double> json_number(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return std::nullopt;
  pos = json.find(':', pos + needle.size());
  if (pos == std::string::npos) return std::nullopt;
  auto start = json.find_first_of("-0123456789.", pos + 1);
  if (start == std::string::npos) return std::nullopt;
  auto end = json.find_first_not_of("-+0123456789.eE", start);
  try {
    return std::stod(json.substr(start, end - start));
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<bool> json_bool(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return std::nullopt;
  pos = json.find(':', pos + needle.size());
  if (pos == std::string::npos) return std::nullopt;
  auto start = json.find_first_not_of(" \t\r\n", pos + 1);
  if (start == std::string::npos) return std::nullopt;
  if (json.compare(start, 4, "true") == 0) return true;
  if (json.compare(start, 5, "false") == 0) return false;
  return std::nullopt;
}

std::string ok(const std::string& id) {
  return "{\"id\":\"" + escape_json(id) + "\",\"result\":{\"ok\":true}}";
}

std::string result(const std::string& id, const std::string& payload) {
  return "{\"id\":\"" + escape_json(id) + "\",\"result\":" + payload + "}";
}

std::string fail(const std::string& id, const std::string& message) {
  return "{\"id\":\"" + escape_json(id) + "\",\"error\":{\"message\":\"" + escape_json(message) + "\"}}";
}

std::string number_string(double value) {
  std::ostringstream out;
  out << value;
  return out.str();
}

std::string property(MpvLoader& mpv, const std::string& name, const std::string& fallback = "") {
  std::string value, error;
  return mpv.getProperty(name, value, error) ? value : fallback;
}

double property_number(MpvLoader& mpv, const std::string& name, double fallback = 0) {
  try {
    return std::stod(property(mpv, name, number_string(fallback)));
  } catch (...) {
    return fallback;
  }
}

bool property_bool(MpvLoader& mpv, const std::string& name, bool fallback = false) {
  const auto value = property(mpv, name, fallback ? "yes" : "no");
  return value == "yes" || value == "true" || value == "1";
}

std::string stats_json(MpvLoader& mpv) {
  std::ostringstream out;
  out << "{\"position\":" << property_number(mpv, "time-pos")
      << ",\"duration\":" << property_number(mpv, "duration")
      << ",\"paused\":" << (property_bool(mpv, "pause") ? "true" : "false")
      << ",\"muted\":" << (property_bool(mpv, "mute") ? "true" : "false")
      << ",\"volume\":" << property_number(mpv, "volume", 100)
      << ",\"speed\":" << property_number(mpv, "speed", 1)
      << ",\"cacheDuration\":" << property_number(mpv, "demuxer-cache-duration")
      << ",\"pausedForCache\":" << (property_bool(mpv, "paused-for-cache") ? "true" : "false")
      << ",\"cacheBytes\":" << property_number(mpv, "demuxer-cache-state/fw-bytes")
      << ",\"cacheMaxBytes\":536870912"
      << ",\"hwdec\":\"" << escape_json(property(mpv, "hwdec-current")) << "\""
      << ",\"videoFormat\":\"" << escape_json(property(mpv, "video-format")) << "\""
      << ",\"audioFormat\":\"" << escape_json(property(mpv, "audio-codec-name")) << "\""
      << ",\"containerFormat\":\"" << escape_json(property(mpv, "file-format")) << "\""
      << ",\"width\":" << property_number(mpv, "width")
      << ",\"height\":" << property_number(mpv, "height")
      << ",\"fps\":" << property_number(mpv, "estimated-vf-fps")
      << ",\"videoBitrate\":" << property_number(mpv, "video-bitrate")
      << ",\"audioBitrate\":" << property_number(mpv, "audio-bitrate")
      << ",\"sampleRate\":" << property_number(mpv, "audio-params/samplerate")
      << ",\"audioChannels\":" << property_number(mpv, "audio-params/channel-count")
      << ",\"path\":\"" << escape_json(property(mpv, "path")) << "\""
      << ",\"fileSize\":" << property_number(mpv, "file-size") << "}";
  return out.str();
}

std::string tracks_json(MpvLoader& mpv) {
  const int count = static_cast<int>(property_number(mpv, "track-list/count", 0));
  std::ostringstream out;
  out << "[";
  for (int i = 0; i < count; ++i) {
    if (i) out << ",";
    const auto base = "track-list/" + std::to_string(i) + "/";
    out << "{\"id\":\"" << escape_json(property(mpv, base + "id"))
        << "\",\"type\":\"" << escape_json(property(mpv, base + "type"))
        << "\",\"title\":\"" << escape_json(property(mpv, base + "title"))
        << "\",\"language\":\"" << escape_json(property(mpv, base + "lang"))
        << "\",\"selected\":" << (property_bool(mpv, base + "selected") ? "true" : "false")
        << "}";
  }
  out << "]";
  return out.str();
}

struct WindowSearch {
  DWORD pid;
  HWND window;
  bool visibleOnly;
};

HWND g_playerWindow = nullptr;
HWND g_parentWindow = nullptr;
DWORD g_parentPid = 0;

BOOL CALLBACK find_process_window(HWND window, LPARAM value) {
  auto* search = reinterpret_cast<WindowSearch*>(value);
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid != search->pid) return TRUE;
  if (search->visibleOnly && !IsWindowVisible(window)) return TRUE;

  wchar_t className[128]{};
  GetClassNameW(window, className, 128);
  if (std::wstring(className) == L"ConsoleWindowClass") return TRUE;
  search->window = window;
  return FALSE;
}

HWND wait_for_process_window(DWORD pid, bool visibleOnly) {
  for (int attempt = 0; attempt < 100; ++attempt) {
    WindowSearch search{pid, nullptr, visibleOnly};
    EnumWindows(find_process_window, reinterpret_cast<LPARAM>(&search));
    if (search.window) return search.window;
    Sleep(50);
  }
  return nullptr;
}

HWND mpv_window() {
  if (g_playerWindow && IsWindow(g_playerWindow)) return g_playerWindow;
  g_playerWindow = wait_for_process_window(GetCurrentProcessId(), false);
  return g_playerWindow;
}

HWND electron_window() {
  if (g_parentWindow && IsWindow(g_parentWindow)) return g_parentWindow;
  return wait_for_process_window(g_parentPid, true);
}

void make_popup(HWND window) {
  if (!window) return;
  LONG_PTR style = GetWindowLongPtrW(window, GWL_STYLE);
  style &= ~static_cast<LONG_PTR>(WS_CHILD | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
  style |= WS_POPUP;
  SetWindowLongPtrW(window, GWL_STYLE, style);
  LONG_PTR ex = GetWindowLongPtrW(window, GWL_EXSTYLE);
  ex |= WS_EX_APPWINDOW;
  SetWindowLongPtrW(window, GWL_EXSTYLE, ex);
  SetLastError(ERROR_SUCCESS);
  SetParent(window, nullptr);
  SetWindowPos(window, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

bool sync_window(const std::string& request, std::string& error) {
  const auto x = json_number(request, "x");
  const auto y = json_number(request, "y");
  const auto width = json_number(request, "width");
  const auto height = json_number(request, "height");
  if (!x || !y || !width || !height) {
    error = "Invalid native player bounds";
    return false;
  }

  const HWND window = mpv_window();
  if (!window) {
    error = "Could not locate mpv video window";
    return false;
  }
  const HWND parent = electron_window();
  if (!parent) {
    error = "Could not locate Electron BrowserWindow";
    return false;
  }

  LONG_PTR style = GetWindowLongPtrW(window, GWL_STYLE);
  style &= ~static_cast<LONG_PTR>(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
  style |= WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN;
  SetWindowLongPtrW(window, GWL_STYLE, style);

  LONG_PTR ex = GetWindowLongPtrW(window, GWL_EXSTYLE);
  ex &= ~static_cast<LONG_PTR>(WS_EX_APPWINDOW | WS_EX_TOPMOST);
  ex |= WS_EX_NOACTIVATE;
  SetWindowLongPtrW(window, GWL_EXSTYLE, ex);

  if (GetParent(window) != parent) {
    SetLastError(ERROR_SUCCESS);
    SetParent(window, parent);
    const DWORD setParentError = GetLastError();
    if (GetParent(window) != parent) {
      error = setParentError == ERROR_SUCCESS
          ? "SetParent did not attach the native player to the Electron client window"
          : "SetParent failed for embedded player (Win32 " + std::to_string(setParentError) + ")";
      return false;
    }
  }

  const UINT dpi = GetDpiForWindow(parent);
  const auto reportedScale = json_number(request, "scale");
  const double scale = reportedScale && *reportedScale > 0 && *reportedScale <= 8
      ? *reportedScale
      : dpi > 0 ? static_cast<double>(dpi) / 96.0 : 1.0;
  const int px = static_cast<int>(std::lround(*x * scale));
  const int py = static_cast<int>(std::lround(*y * scale));
  const int pwidth = std::max(1, static_cast<int>(std::lround(*width * scale)));
  const int pheight = std::max(1, static_cast<int>(std::lround(*height * scale)));
  const bool visible = json_bool(request, "visible").value_or(true);
  const UINT flags = SWP_NOACTIVATE | SWP_FRAMECHANGED | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);
  if (!SetWindowPos(window, HWND_TOP, px, py, pwidth, pheight, flags)) {
    error = "SetWindowPos failed (Win32 " + std::to_string(GetLastError()) + ")";
    return false;
  }
  ShowWindow(window, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
  return true;
}

std::string handle_command(MpvLoader& mpv, const std::string& id, const std::string& request, std::string& error) {
  const auto command = json_string(request, "command").value_or("");

  if (command == "pause")
    return mpv.setProperty("pause", json_bool(request, "value").value_or(true) ? "yes" : "no", error) ? ok(id) : fail(id, error);
  if (command == "seek")
    return mpv.command({"seek", number_string(json_number(request, "value").value_or(0)), json_bool(request, "absolute").value_or(false) ? "absolute" : "relative"}, error) ? ok(id) : fail(id, error);
  if (command == "volume")
    return mpv.setProperty("volume", number_string(json_number(request, "value").value_or(100)), error) ? ok(id) : fail(id, error);
  if (command == "mute")
    return mpv.setProperty("mute", json_bool(request, "value").value_or(true) ? "yes" : "no", error) ? ok(id) : fail(id, error);
  if (command == "speed")
    return mpv.setProperty("speed", number_string(json_number(request, "value").value_or(1)), error) ? ok(id) : fail(id, error);
  if (command == "hwdec")
    return mpv.setProperty("hwdec", json_string(request, "value").value_or("auto-safe"), error) ? ok(id) : fail(id, error);
  if (command == "stop")
    return mpv.command({"stop"}, error) ? ok(id) : fail(id, error);

  if (command == "subtitle-add") {
    const auto value = json_string(request, "value");
    return value && mpv.command({"sub-add", *value, "select"}, error) ? ok(id) : fail(id, value ? error : "Missing subtitle path");
  }
  if (command == "audio-track")
    return mpv.setProperty("aid", json_string(request, "value").value_or("auto"), error) ? ok(id) : fail(id, error);
  if (command == "subtitle-track")
    return mpv.setProperty("sid", json_string(request, "value").value_or("auto"), error) ? ok(id) : fail(id, error);
  if (command == "subtitle-delay")
    return mpv.setProperty("sub-delay", number_string(json_number(request, "value").value_or(0)), error) ? ok(id) : fail(id, error);
  if (command == "audio-delay")
    return mpv.setProperty("audio-delay", number_string(json_number(request, "value").value_or(0)), error) ? ok(id) : fail(id, error);
  if (command == "aspect-ratio")
    return mpv.setProperty("video-aspect-override", json_string(request, "value").value_or("no"), error) ? ok(id) : fail(id, error);

  if (command == "pip") {
    const bool enabled = json_bool(request, "value").value_or(false);
    if (enabled) make_popup(mpv_window());
    if (!mpv.setProperty("ontop", enabled ? "yes" : "no", error)) return fail(id, error);
    if (enabled) mpv.setProperty("geometry", "30%x30%-20-20", error);
    return ok(id);
  }

  if (command == "fullscreen") {
    const bool enabled = json_bool(request, "value").value_or(false);
    if (enabled) make_popup(mpv_window());
    return mpv.setProperty("fullscreen", enabled ? "yes" : "no", error) ? ok(id) : fail(id, error);
  }

  if (command == "screenshot") {
    const auto file = json_string(request, "value");
    return file && mpv.command({"screenshot-to-file", *file, "subtitles"}, error) ? ok(id) : fail(id, file ? error : "Missing screenshot path");
  }

  if (command == "window-sync") return sync_window(request, error) ? ok(id) : fail(id, error);
  return fail(id, "Unsupported player command");
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  std::wstring pipeName;
  bool testNullAudio = false;

  for (int i = 1; i + 1 < argc; ++i) {
    const std::wstring arg = argv[i];
    if (arg == L"--pipe") {
      pipeName = argv[i + 1];
    } else if (arg == L"--parent-pid") {
      try {
        g_parentPid = static_cast<DWORD>(std::stoul(argv[i + 1]));
      } catch (...) {
        g_parentPid = 0;
      }
    } else if (arg == L"--parent-hwnd") {
      try {
        const auto value = static_cast<std::uintptr_t>(std::stoull(argv[i + 1]));
        g_parentWindow = reinterpret_cast<HWND>(value);
      } catch (...) {
        g_parentWindow = nullptr;
      }
    } else if (arg == L"--test-audio-output") {
      testNullAudio = std::wstring(argv[i + 1]) == L"null";
    }
  }

  if (pipeName.empty()) {
    std::wcerr << L"Missing --pipe" << std::endl;
    return 2;
  }

  const auto dllPath = std::filesystem::path(argv[0]).parent_path() / L"libmpv-2.dll";
  MpvLoader mpv;
  std::string initError;
  const bool ready = mpv.initialize(dllPath, initError, testNullAudio);
  std::mutex loadMutex;
  std::string activeProfile;

  NamedPipeServer server(pipeName, [&](const std::string& request) {
    const std::string id = json_string(request, "id").value_or("unknown");
    const std::string method = json_string(request, "method").value_or("");

    if (method == "player.ping") {
      if (!ready) return fail(id, initError);
      return ok(id);
    }
    if (!ready) return fail(id, initError);

    std::string error;
    if (method == "player.load") {
      std::lock_guard<std::mutex> loadLock(loadMutex);
      const auto url = json_string(request, "url");
      if (!url) return fail(id, "Missing playback URL");
      const auto profile = json_string(request, "profile").value_or("vod");
      if (profile != activeProfile) {
        const bool live = profile == "live";
        if (!mpv.setProperty("demuxer-readahead-secs", live ? "3" : "20", error) ||
            !mpv.setProperty("demuxer-max-bytes", live ? "134217728" : "536870912", error) ||
            !mpv.setProperty("cache-pause", live ? "no" : "yes", error) ||
            !mpv.setProperty("cache-pause-wait", live ? "1" : "2", error)) return fail(id, error);
        activeProfile = profile;
      }
      std::string loadId;
      if (!mpv.startLoad(*url, json_string(request, "headerFields").value_or(""), loadId, error)) return fail(id, error);
      return result(id, "{\"ok\":true,\"accepted\":true,\"loadId\":\"" + escape_json(loadId) + "\"}");
    }

    if (method == "player.query") {
      const auto query = json_string(request, "query").value_or("");
      if (query == "load-status") {const auto state=mpv.loadState();std::ostringstream payload;payload<<"{\"loadId\":\""<<escape_json(state.loadId)<<"\",\"status\":\""<<escape_json(state.status)<<"\"";if(!state.error.empty())payload<<",\"error\":\""<<escape_json(state.error)<<"\"";payload<<"}";return result(id,payload.str());}
      if (query == "stats") return result(id, stats_json(mpv));
      if (query == "tracks") return result(id, tracks_json(mpv));
      return fail(id, "Unsupported player query");
    }

    if (method == "player.command") return handle_command(mpv, id, request, error);
    return fail(id, "Unsupported player method");
  });

  return server.run();
}
