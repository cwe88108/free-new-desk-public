# Electron can create another visible window in the same process after the homepage mounts.
if (-not ('FreeNewDeskSmokeWindows' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FreeNewDeskSmokeWindows {
  public sealed class Window {
    public readonly IntPtr Handle;
    public readonly string Title;
    public Window(IntPtr handle, string title) { Handle = handle; Title = title; }
  }

  private delegate bool Visitor(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);

  public static Window[] VisibleForProcess(uint processId) {
    var windows = new List<Window>();
    EnumWindows(delegate (IntPtr handle, IntPtr ignored) {
      uint owner;
      GetWindowThreadProcessId(handle, out owner);
      if (owner == processId && IsWindowVisible(handle)) {
        var title = new StringBuilder(512);
        GetWindowText(handle, title, title.Capacity);
        windows.Add(new Window(handle, title.ToString()));
      }
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
}
