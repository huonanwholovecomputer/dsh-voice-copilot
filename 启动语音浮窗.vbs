' Launch 小印 (the Electron floating window) without a console.
' Looks for electron.exe in the usual caches; no user name is hard-coded.
' Starting it twice is safe: the second one just calls the first window back up.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)

electron = ""
candidates = Array( _
  shell.ExpandEnvironmentStrings("%DSH_VOICE_COPILOT_ELECTRON%"), _
  base & "\desktop\node_modules\electron\dist\electron.exe", _
  shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh\electron\electron.exe" _
)
For Each candidate In candidates
  If electron = "" And candidate <> "" And fso.FileExists(candidate) Then electron = candidate
Next

If electron = "" Then
  MsgBox "electron.exe not found." & vbCrLf & _
         "Install DSH desktop once (it caches Electron under %USERPROFILE%\.dsh\electron)," & vbCrLf & _
         "or set DSH_VOICE_COPILOT_ELECTRON to its full path.", 16, "小印"
  WScript.Quit 1
End If

If Not fso.FileExists(base & "\desktop\main.js") Then
  MsgBox "desktop\main.js is missing; the floating window was not installed.", 16, "小印"
  WScript.Quit 1
End If

' ELECTRON_RUN_AS_NODE in the shell environment would turn Electron into plain node.
Set env = shell.Environment("PROCESS")
env("ELECTRON_RUN_AS_NODE") = ""

shell.CurrentDirectory = base & "\desktop"
shell.Run """" & electron & """ """ & base & "\desktop""", 0, False
