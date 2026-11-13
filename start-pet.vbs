' DeepSeek desktop pet launcher shim.
' ASCII only on purpose: Windows Script Host reads .vbs as ANSI, so non-ASCII
' literals break it on a GBK system.
'
' Launched by the desktop shortcut through wscript.exe.
'
' Why WMI instead of WshShell.Run / cmd start:
'   WshShell.Run() goes through ShellExecute, and an unsigned electron.exe then
'   hits the Windows "无法验证发布者" prompt (or fails outright with error 5 when
'   the command line needs nested quotes). Win32_Process.Create uses
'   CreateProcess directly: no shell, no reputation prompt, no console window,
'   and the quoting rules are plain.
'
' --no-sandbox is passed because this app only loads local assets (pet:// + local
' model files) and without the flag Electron exits with code 3 on this machine.

Option Explicit

Dim fso, wmi, root, exePath, logPath, cmdLine, rc
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = root & "\node_modules\electron\dist\electron.exe"
logPath = fso.BuildPath(fso.BuildPath(root, "_data"), "launch.log")

If Not fso.FileExists(exePath) Then
  Call AppendLog(logPath, "missing electron.exe: " & exePath)
  MsgBox "electron.exe not found. Run 'npm install' in:" & vbCrLf & root, 16, "DeepSeek Pet"
  WScript.Quit 1
End If

cmdLine = """" & exePath & """ --no-sandbox """ & root & """"

rc = -1
Err.Clear
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2:Win32_Process")
If Err.Number = 0 Then
  rc = wmi.Create(cmdLine, root, Nothing)
Else
  rc = 1000 + Err.Number
End If
If Err.Number <> 0 And rc = 0 Then rc = 1000 + Err.Number
On Error GoTo 0

If rc <> 0 Then
  Call AppendLog(logPath, "WMI create failed: " & rc & " / " & cmdLine)
  MsgBox "Failed to start the pet (code " & rc & ")" & vbCrLf & exePath, 16, "DeepSeek Pet"
Else
  Call AppendLog(logPath, "launched: " & cmdLine)
End If

Sub AppendLog(path, text)
  Dim f
  On Error Resume Next
  fso.CreateFolder fso.GetParentFolderName(path)
  Set f = fso.OpenTextFile(path, 8, True)
  f.Write Now & "  " & text & vbCrLf
  f.Close
  On Error GoTo 0
End Sub
