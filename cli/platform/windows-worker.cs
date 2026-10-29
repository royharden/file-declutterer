using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace FileDeclutterer {
  // All requests (including mutex acquisition/release) execute on this one OS thread.
  public static class NativeWorker {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFileAttributesW(string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetLongPathNameW(string path, StringBuilder output, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetShortPathNameW(string path, StringBuilder output, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetVolumePathNameW(string path, StringBuilder volume, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetVolumeInformationW(string root, StringBuilder name, uint nameLength, out uint serial, out uint componentLength, out uint flags, StringBuilder fs, uint fsLength);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetDriveTypeW(string root);

    static Mutex guard;
    static string guardName;
    static Win32Exception WinError(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static SafeFileHandle Open(string path, uint access=0) {
      // OPEN_REPARSE_POINT prevents accidentally inspecting the target in place of a link.
      var h = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
      if (h.IsInvalid) { h.Dispose(); throw WinError("Open file attributes"); }
      return h;
    }
    static string Identity(SafeFileHandle h) {
      IntPtr data = Marshal.AllocHGlobal(24);
      try {
        if (!GetFileInformationByHandleEx(h, 18, data, 24)) throw WinError("FileIdInfo unavailable");
        byte[] id = new byte[16]; Marshal.Copy(IntPtr.Add(data,8), id,0,16);
        return unchecked((ulong)Marshal.ReadInt64(data)).ToString("x16") + ":" + Convert.ToHexString(id).ToLowerInvariant();
      } finally { Marshal.FreeHGlobal(data); }
    }
    static uint Attributes(string path) {
      uint value=GetFileAttributesW(path);
      if (value==0xffffffff) throw WinError("GetFileAttributes");
      return value;
    }
    static string LongPath(string path) {
      var buffer=new StringBuilder(32768);
      uint result=GetLongPathNameW(path,buffer,(uint)buffer.Capacity);
      if (result==0 || result>=buffer.Capacity) throw WinError("Canonical long path unavailable");
      return buffer.ToString();
    }
    static object Component(string path) {
      uint attrs=Attributes(path);
      string canonical=LongPath(path);
      if (!String.Equals(canonical.TrimEnd('\\'),path.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Short-name or noncanonical alias refused: " + path);
      using(var handle=Open(path)) {
        if ((attrs & 0x10)!=0 && (attrs & 0x400)==0) {
          IntPtr flags=Marshal.AllocHGlobal(4);
          try {
            if (!GetFileInformationByHandleEx(handle,23,flags,4)) throw WinError("Directory case-sensitivity facts unavailable");
            if (Marshal.ReadInt32(flags)!=0) throw new InvalidOperationException("Case-sensitive directories are unsupported");
          } finally { Marshal.FreeHGlobal(flags); }
        }
        return new { path, fileId=Identity(handle), reparse=(attrs&0x400)!=0, hidden=(attrs&2)!=0, system=(attrs&4)!=0,
          cloudPlaceholder=(attrs & (0x1000u|0x40000u|0x80000u|0x400000u))!=0 };
      }
    }
    static object Components(string supplied) {
      // Path.GetFullPath on Windows may expand 8.3 aliases. Reject the supplied spelling first.
      if (!Path.IsPathFullyQualified(supplied) || supplied.StartsWith(@"\\"))
        throw new InvalidOperationException("Unsupported native path");
      if (!String.Equals(LongPath(supplied).TrimEnd('\\'),supplied.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Short-name or noncanonical alias refused: " + supplied);
      string full=Path.GetFullPath(supplied);
      if (full.StartsWith(@"\\") || full.Length>32760) throw new InvalidOperationException("Unsupported native path");
      string root=Path.GetPathRoot(full);
      var facts=new List<object>();
      string current=root;
      facts.Add(Component(current));
      foreach(string part in full.Substring(root.Length).Split('\\',StringSplitOptions.RemoveEmptyEntries)) {
        current=Path.Combine(current,part); facts.Add(Component(current));
      }
      return facts;
    }
    static object Volume(string path) {
      var root=new StringBuilder(32768);
      if (!GetVolumePathNameW(path,root,(uint)root.Capacity)) throw WinError("Volume root unavailable");
      var fs=new StringBuilder(260); var name=new StringBuilder(260); uint serial,max,flags;
      if (!GetVolumeInformationW(root.ToString(),name,260,out serial,out max,out flags,fs,260)) throw WinError("Volume facts unavailable");
      uint kind=GetDriveTypeW(root.ToString());
      if (kind==0 || kind==1) throw new InvalidOperationException("Unknown drive type");
      return new { fileSystem=fs.ToString(), serial=serial.ToString("x8"), remote=kind==4, removable=kind!=3 };
    }
    static string Start(int pid) {
      try { using(var p=Process.GetProcessById(pid)) { return p.StartTime.ToUniversalTime().Ticks.ToString(); } }
      catch (ArgumentException) { return null; }
      // Access denied or other uncertainty must not be confused with an absent process.
    }
    static object Dispatch(JsonElement request) {
      string op=request.GetProperty("op").GetString();
      string arg=request.TryGetProperty("arg",out var a) ? a.GetString() : null;
      switch(op) {
        case "ping": return "windows-pwsh-win32-v1";
        case "volume": return Volume(arg);
        case "components": return Components(arg);
        case "fileId": using(var h=Open(arg)) return Identity(h);
        case "shortPath": {
          var buffer=new StringBuilder(32768);
          uint size=GetShortPathNameW(arg,buffer,(uint)buffer.Capacity);
          if(size==0 || size>=buffer.Capacity) throw WinError("Short-name facts unavailable");
          return buffer.ToString();
        }
        case "processStart": return Start(Int32.Parse(arg));
        case "acquire": {
          if(guard!=null) throw new InvalidOperationException("Helper already holds a root mutex");
          string name="Global\\FileDeclutterer-v1-"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(arg))).ToLowerInvariant();
          var m=new Mutex(false,name);
          bool acquired=false;
          try { acquired=m.WaitOne(0); } catch(AbandonedMutexException) { acquired=true; }
          if(!acquired) { m.Dispose(); throw new InvalidOperationException("Root mutex is held by another command"); }
          guard=m; guardName=name; return name;
        }
        case "held": return guard!=null && guardName==arg;
        case "release": {
          if(guard==null || guardName!=arg) throw new InvalidOperationException("Mutex ownership mismatch");
          guard.ReleaseMutex(); guard.Dispose(); guard=null; guardName=null; return true;
        }
        case "flushDirectory": {
          if((Attributes(arg)&0x10)==0) throw new InvalidOperationException("Flush target is not a directory");
          using(var h=Open(arg,0x40000000)) {
            if(!FlushFileBuffers(h)) throw WinError("Directory metadata flush unsupported");
          }
          return true;
        }
        default: throw new InvalidOperationException("Unknown helper operation");
      }
    }
    public static void Run(int parentPid) {
      Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
      string parentStart=Start(parentPid);
      if(parentStart==null) throw new InvalidOperationException("Parent process is absent");
      // Abrupt parent death cannot leave a detached worker owning the root mutex.
      using(var timer=new Timer(_ => {
        try { if(Start(parentPid)!=parentStart) Environment.Exit(71); } catch { Environment.Exit(72); }
      },null,100,100)) {
        try {
          string line;
          while((line=Console.ReadLine())!=null) {
            long id=0;
            try {
              if(line.Length>32768) throw new InvalidOperationException("Oversized helper request");
              using(var parsed=JsonDocument.Parse(line,new JsonDocumentOptions { MaxDepth=8 })) {
                id=parsed.RootElement.GetProperty("id").GetInt64();
                object value=Dispatch(parsed.RootElement);
                Console.WriteLine(JsonSerializer.Serialize(new {id,ok=true,value}));
              }
            } catch(Exception error) { Console.WriteLine(JsonSerializer.Serialize(new {id,ok=false,error=error.Message})); }
            Console.Out.Flush();
          }
        } finally { if(guard!=null) { guard.ReleaseMutex(); guard.Dispose(); guard=null; } }
      }
    }
  }
}
