' Hidden launcher for the dsh-tray-follower bridge (wscript, no console window).
'
' The installer points the DeepSeek Harness Start-Menu / Desktop shortcuts at:
'   wscript.exe "launch-bridge.vbs" "<dataDir>"
'
' This script only starts the hidden PowerShell launcher; the actual work (start
' DSH with a loopback inspector, inject the hook, close the inspector) happens in
' launch-bridge.ps1 -> launch.mjs.
'
' NOTE: this file is intentionally ASCII-only so Windows Script Host can parse it
' regardless of the system ANSI code page. Localized UI text lives in the
' PowerShell script (stored as UTF-8 with BOM).
Option Explicit

Dim shell, fso, dataDir, scriptPath, command, message
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count >= 1 Then
  dataDir = WScript.Arguments(0)
Else
  dataDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\dsh-tray-follower"
End If

scriptPath = dataDir & "\app\launcher\launch-bridge.ps1"
If Not fso.FileExists(scriptPath) Then
  message = "dsh-tray-follower is not installed or is incomplete:" & vbCrLf & scriptPath & vbCrLf & vbCrLf & _
    "Reinstall with: node tools\install-bridge.mjs --apply"
  shell.Popup message, 25, "DSH tray follower", 16
  WScript.Quit 3
End If

command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & _
  scriptPath & """ -DataDir """ & dataDir & """"
shell.Run command, 0, False
WScript.Quit 0
