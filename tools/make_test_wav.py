"""生成一段中文测试音频（Windows SAPI），用于离线验证识别链路。"""
import subprocess
import sys
import tempfile
from pathlib import Path

TEMP = Path(tempfile.gettempdir())
PS1 = TEMP / "vc_tts.ps1"
WAV = TEMP / "vc_test.wav"

SCRIPT = r"""Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice("Microsoft Huihui Desktop")
$s.SetOutputToWaveFile("$env:TEMP\vc_test.wav")
$s.Speak("帮我看一下今天的安排")
$s.Dispose()
Write-Output "done"
"""

PS1.write_text(SCRIPT, encoding="utf-8-sig")
result = subprocess.run(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(PS1)],
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
)
print("rc", result.returncode)
print((result.stdout or "").strip()[:200])
print((result.stderr or "").strip()[:400])
print("wav bytes", WAV.stat().st_size if WAV.exists() else "missing")
