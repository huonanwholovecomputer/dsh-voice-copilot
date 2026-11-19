Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | ForEach-Object {
    if ($_.CommandLine -like '*dsh-voice-copilot*') {
        Stop-Process -Id $_.ProcessId -Force
        Write-Output ("stopped " + $_.ProcessId)
    }
}
Start-Sleep -Milliseconds 400
# 本脚本就在仓库的 tools/ 下，vbs 在上一级
$vbs = Get-ChildItem (Join-Path $PSScriptRoot '..\*.vbs') | Select-Object -First 1
Start-Process wscript.exe -ArgumentList $vbs.FullName
Write-Output ("started " + $vbs.FullName)
