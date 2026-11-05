/**
 * 把 DSH 桌面端主窗口切到前台（仅 Windows）。
 *
 * DSH 是 Electron 应用（进程名形如 `DSH NEXT` / `DeepSeek Harness`），主窗口
 * 类是 `Chrome_WidgetWin_1`。难点不在找窗口，而在 Windows 的前台锁：一个
 * 后台进程直接 `SetForegroundWindow` 会被静默拒绝。这里沿用 dsh-notify-me
 * 验证过的那套做法——
 *
 *   1. 已经在前台就不折腾（避免闪烁）；
 *   2. 最小化过就先 `ShowWindow(SW_RESTORE)`；
 *   3. `keybd_event(VK_MENU)` 点一下 Alt：让自己成为"最近输入来源"，
 *      这是前台锁真正检查的条件；
 *   4. 还不行就 `AttachThreadInput` 挂到前台线程的输入队列上，
 *      再 `BringWindowToTop` + `SetForegroundWindow`；
 *   5. 最后兜一手 `SW_MINIMIZE` + `SW_RESTORE` 再抢。
 *
 * 每一步之后都重新读 `GetForegroundWindow()` 核对，`ok` 只来自核对结果，
 * 不做乐观返回。任何异常/超时都折成 `{ ok: false }`，**绝不抛出**。
 *
 * 调用约定：
 *   const { focusDshWindow } = require('./focus')
 *   const result = await focusDshWindow({ log })
 *   // => { ok: true, method: 'setforeground', title: '… — DeepSeek Harness' }
 *
 * 调试用环境变量（都不影响正常路径）：
 *   DSH_FOCUS_MATCH  覆盖进程名正则，默认 `DSH NEXT|DeepSeek|Harness`
 *   DSH_FOCUS_TITLE  覆盖标题回退正则，默认 `DSH NEXT|DeepSeek`
 *
 * 实现要点：PowerShell 脚本以**纯 ASCII** 内嵌、运行时落到临时目录再 `-File`
 * 调用，窗口标题以 base64(UTF-8) 回传，因此不会出现中文乱码。
 */
'use strict'

const { execFile } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 总超时：再慢也不能把浮窗的调用方卡住。 */
const TIMEOUT_MS = 4000

/** 结果的 `method` 取值。 */
const METHOD = {
  ALREADY: 'already-foreground',
  RESTORE: 'restore',
  SET_FOREGROUND: 'setforeground',
  ATTACHED: 'attached-thread',
  MINIMIZE_RESTORE: 'minimize-restore',
  NONE: 'none',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
  SPAWN_ERROR: 'spawn-error',
}

/**
 * 内嵌的 PowerShell 脚本。
 *
 * 必须是纯 ASCII：PowerShell 5.1 读无 BOM 的 .ps1 时按系统 ANSI 代码页解码，
 * 中文注释会被啃坏。窗口标题走 `TITLE_B64:` 回传，不经过控制台代码页。
 */
const SCRIPT = `# focus-window.ps1 - bring the DSH (Electron) main window to the foreground.
#
# Contract:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File focus-window.ps1 [-ProcessId N]
#   * stdout: ASCII-only diagnostic lines; the LAST line is "FOCUSED=1" or "FOCUSED=0".
#   * "TITLE_B64: <base64(utf8 title)>" carries the chosen title without codepage damage.
#   * "METHOD: <token>" names the rung that actually raised the window.
#   * always exits 0.
#
# Window selection: visible top-level window, GWL_EXSTYLE without WS_EX_TOOLWINDOW,
# GW_OWNER == 0, non-empty title. Ranked by process-name match, then class
# Chrome_WidgetWin_1, then largest area. Never just the first enum match.
#
# Raise ladder (each rung verified with GetForegroundWindow):
#   0. already foreground -> done
#   1. IsIconic -> ShowWindow(SW_RESTORE)
#   2. Alt tap (keybd_event VK_MENU) + SetForegroundWindow
#   3. AttachThreadInput to the foreground thread + Alt tap + BringWindowToTop
#      + SetForegroundWindow (beats the foreground-lock refusal)
#   4. ShowWindow(SW_MINIMIZE) + SW_RESTORE + Alt tap + SetForegroundWindow
#
# ASCII only, UTF-8 without BOM (Windows PowerShell 5.1 safe).

param(
    [int]$ProcessId = 0,
    [int]$BudgetMs = 3200
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$script:Sw = [System.Diagnostics.Stopwatch]::StartNew()
$script:Method = 'failed'
$script:Status = 'FOCUSED=0'

function Out-Line([string]$Text) {
    try { [Console]::Out.WriteLine($Text) } catch { }
}

function To-Ascii([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    return [regex]::Replace($Text, '[^\\x20-\\x7E]', '?')
}

function Short-Text([string]$Text, [int]$Max) {
    $s = To-Ascii $Text
    if ($s.Length -gt $Max) { return $s.Substring(0, $Max) + '...' }
    return $s
}

function Out-Title([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { Out-Line 'TITLE_B64:'; return }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    Out-Line ('TITLE_B64: ' + [Convert]::ToBase64String($bytes))
}

try {
    # ------------------------------------------------------------------ native
    if (-not ('FocusNative' -as [type])) {
        $cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class FocusNative
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public const uint GW_OWNER = 4;
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;
    public const byte VK_MENU = 0x12;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const string TARGET_CLASS = "Chrome_WidgetWin_1";

    public class WinInfo
    {
        public IntPtr Hwnd;
        public int Pid;
        public bool Visible;
        public bool HasOwner;
        public bool Iconic;
        public string ClassName;
        public string Title;
        public long Area;
        public bool ToolWindow;
    }

    public static string ClassOf(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string TitleOf(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static long AreaOf(IntPtr hWnd)
    {
        RECT r;
        if (!GetWindowRect(hWnd, out r)) { return -1; }
        long w = (long)r.Right - (long)r.Left;
        long h = (long)r.Bottom - (long)r.Top;
        if (w < 0) { w = -w; }
        if (h < 0) { h = -h; }
        return w * h;
    }

    public static List<WinInfo> ListTopWindows()
    {
        List<WinInfo> list = new List<WinInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            WinInfo wi = new WinInfo();
            wi.Hwnd = hWnd;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            wi.Pid = (int)pid;
            wi.Visible = IsWindowVisible(hWnd);
            wi.HasOwner = GetWindow(hWnd, GW_OWNER) != IntPtr.Zero;
            wi.Iconic = IsIconic(hWnd);
            wi.ClassName = ClassOf(hWnd);
            wi.Title = TitleOf(hWnd);
            wi.Area = AreaOf(hWnd);
            wi.ToolWindow = (GetWindowLong(hWnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0;
            list.Add(wi);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // A plain keybd_event Alt tap marks this process as the most recent input
    // source, which is what the foreground lock rule actually checks.
    public static void AltTap()
    {
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(15);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        System.Threading.Thread.Sleep(15);
    }

    // Rung 3: share the foreground thread input queue, then raise. Windows lets
    // SetForegroundWindow through because the caller is now attached to the
    // thread that owns the foreground. Always detach again.
    public static bool AttachedForeground(IntPtr hWnd)
    {
        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint targetPid;
        uint targetThread = GetWindowThreadProcessId(hWnd, out targetPid);
        uint myThread = GetCurrentThreadId();
        bool attachedFg = false;
        bool attachedTarget = false;
        try
        {
            if (fgThread != 0 && fgThread != myThread)
            {
                attachedFg = AttachThreadInput(myThread, fgThread, true);
            }
            if (targetThread != 0 && targetThread != myThread && targetThread != fgThread)
            {
                attachedTarget = AttachThreadInput(myThread, targetThread, true);
            }
            AltTap();
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
            return true;
        }
        finally
        {
            if (attachedTarget) { AttachThreadInput(myThread, targetThread, false); }
            if (attachedFg) { AttachThreadInput(myThread, fgThread, false); }
        }
    }
}
'@
        Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop
    }
    Out-Line ('DETAIL: native helper ready in ' + $script:Sw.ElapsedMilliseconds + ' ms')

    # ------------------------------------------------------------- find window
    $pattern = $env:DSH_FOCUS_MATCH
    if ([string]::IsNullOrEmpty($pattern)) { $pattern = 'DSH NEXT|DeepSeek|Harness' }
    $titlePattern = $env:DSH_FOCUS_TITLE
    if ([string]::IsNullOrEmpty($titlePattern)) { $titlePattern = 'DSH NEXT|DeepSeek' }

    $autoMode = ($ProcessId -le 0)
    $allWindows = [FocusNative]::ListTopWindows()
    $autoPids = @{}
    if ($autoMode) {
        foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
            try {
                if ($p.ProcessName -match $pattern) { $autoPids[[int]$p.Id] = $true }
            } catch { }
        }
        Out-Line ('DETAIL: auto mode, pattern=' + (Short-Text $pattern 60) + ' pids=' + ((@($autoPids.Keys | Sort-Object) -join ',')))
    } else {
        Out-Line ('DETAIL: explicit mode, pid=' + $ProcessId)
    }

    $candidates = @()
    foreach ($w in $allWindows) {
        if (-not $w.Visible) { continue }
        if ($w.HasOwner) { continue }
        if ($w.ToolWindow) { continue }
        if ([string]::IsNullOrEmpty($w.Title)) { continue }
        $isProcMatch = $false
        if ($autoMode) {
            if ($autoPids.ContainsKey([int]$w.Pid)) { $isProcMatch = $true }
            elseif (-not ($w.Title -match $titlePattern)) { continue }
        } else {
            if ([int]$w.Pid -ne $ProcessId) { continue }
            $isProcMatch = $true
        }
        $isClassTarget = ($w.ClassName -eq [FocusNative]::TARGET_CLASS)
        $candidates += [pscustomobject]@{
            Hwnd          = $w.Hwnd
            Pid           = [int]$w.Pid
            ClassName     = $w.ClassName
            Title         = $w.Title
            Area          = [long]$w.Area
            Iconic        = [bool]$w.Iconic
            IsClassTarget = [bool]$isClassTarget
            IsProcMatch   = [bool]$isProcMatch
        }
    }
    Out-Line ('DETAIL: candidates=' + $candidates.Count)

    if ($candidates.Count -eq 0) {
        Out-Line 'ERROR: no-window'
        Out-Line 'DETAIL: no candidate top-level window found'
        $script:Method = 'none'
    } else {
        # Main window = process match, then Chrome class, then the biggest
        # visible rectangle. Manual comparison keeps 5.1 behaviour predictable.
        $best = $null
        $idx = 0
        foreach ($c in $candidates) {
            $idx++
            Out-Line ('DETAIL: candidate #{0} hwnd=0x{1:X} pid={2} class={3} area={4} iconic={5} proc={6} title={7}' -f $idx, $c.Hwnd.ToInt64(), $c.Pid, $c.ClassName, $c.Area, $c.Iconic, $c.IsProcMatch, (Short-Text $c.Title 70))
            if ($null -eq $best) { $best = $c; continue }
            $better = $false
            if ($c.IsProcMatch -ne $best.IsProcMatch) { $better = [bool]$c.IsProcMatch }
            elseif ($c.IsClassTarget -ne $best.IsClassTarget) { $better = [bool]$c.IsClassTarget }
            elseif ($c.Area -ne $best.Area) { $better = ($c.Area -gt $best.Area) }
            if ($better) { $best = $c }
        }

        $hwnd = [IntPtr]$best.Hwnd
        Out-Line ('DETAIL: selected hwnd=0x{0:X} pid={1} class={2} area={3} iconic={4}' -f $hwnd.ToInt64(), $best.Pid, $best.ClassName, $best.Area, $best.Iconic)
        Out-Title $best.Title

        function Test-Foreground([IntPtr]$Handle, [int]$TimeoutMs) {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
                if ([FocusNative]::GetForegroundWindow() -eq $Handle) { return $true }
                Start-Sleep -Milliseconds 20
            }
            return ([FocusNative]::GetForegroundWindow() -eq $Handle)
        }

        $fg0 = [FocusNative]::GetForegroundWindow()
        $iconic0 = [FocusNative]::IsIconic($hwnd)
        Out-Line ('DETAIL: initial foreground=0x{0:X} iconic={1}' -f $fg0.ToInt64(), $iconic0)

        $focused = $false
        $restored = $false
        $prefix = ''

        if ($fg0 -eq $hwnd -and -not $iconic0) {
            $focused = $true
            $script:Method = 'already-foreground'
            Out-Line 'DETAIL: step 0: already foreground'
        }

        if (-not $focused -and $iconic0) {
            Out-Line 'DETAIL: step 1: iconic, ShowWindow(SW_RESTORE)'
            [void][FocusNative]::ShowWindow($hwnd, [FocusNative]::SW_RESTORE)
            Start-Sleep -Milliseconds 60
            $restored = $true
            $prefix = 'restore+'
            if (Test-Foreground $hwnd 120) {
                $focused = $true
                $script:Method = 'restore'
                Out-Line 'DETAIL: restore alone was enough'
            }
        }

        if (-not $focused -and $script:Sw.ElapsedMilliseconds -lt $BudgetMs) {
            Out-Line 'DETAIL: step 2: Alt tap + SetForegroundWindow'
            [FocusNative]::AltTap()
            [void][FocusNative]::SetForegroundWindow($hwnd)
            if (Test-Foreground $hwnd 220) {
                $focused = $true
                $script:Method = $prefix + 'setforeground'
            }
        }

        if (-not $focused -and $script:Sw.ElapsedMilliseconds -lt $BudgetMs) {
            Out-Line 'DETAIL: step 3: AttachThreadInput + Alt tap + BringWindowToTop + SetForegroundWindow'
            try { [void][FocusNative]::AttachedForeground($hwnd) } catch { Out-Line ('DETAIL: attach failed ' + (To-Ascii $_.Exception.Message)) }
            if (Test-Foreground $hwnd 240) {
                $focused = $true
                $script:Method = $prefix + 'attached-thread'
            }
        }

        if (-not $focused -and $script:Sw.ElapsedMilliseconds -lt $BudgetMs) {
            Out-Line 'DETAIL: step 4: SW_MINIMIZE + SW_RESTORE + Alt tap + SetForegroundWindow'
            [void][FocusNative]::ShowWindow($hwnd, [FocusNative]::SW_MINIMIZE)
            Start-Sleep -Milliseconds 70
            [FocusNative]::AltTap()
            [void][FocusNative]::ShowWindow($hwnd, [FocusNative]::SW_RESTORE)
            Start-Sleep -Milliseconds 60
            [FocusNative]::AltTap()
            [void][FocusNative]::SetForegroundWindow($hwnd)
            if (Test-Foreground $hwnd 260) {
                $focused = $true
                $script:Method = $prefix + 'minimize-restore'
            }
        }

        $fg1 = [FocusNative]::GetForegroundWindow()
        $iconic1 = [FocusNative]::IsIconic($hwnd)
        Out-Line ('DETAIL: final foreground=0x{0:X} target=0x{1:X} iconic={2}' -f $fg1.ToInt64(), $hwnd.ToInt64(), $iconic1)
        if ($fg1 -eq $hwnd -and -not $iconic1) {
            $script:Status = 'FOCUSED=1'
        } else {
            $script:Status = 'FOCUSED=0'
            $script:Method = 'failed'
            Out-Line 'ERROR: foreground-not-acquired'
        }
    }
} catch {
    Out-Line ('ERROR: ' + (To-Ascii $_.Exception.Message))
    $script:Method = 'error'
    $script:Status = 'FOCUSED=0'
}

Out-Line ('METHOD: ' + $script:Method)
Out-Line ('DETAIL: elapsed_ms=' + $script:Sw.ElapsedMilliseconds)
Out-Line $script:Status
exit 0
`

/** 临时目录里已经就绪的脚本路径。 */
let cachedScriptPath = null

/**
 * @returns {string} `powershell.exe` 的路径；缺省时退回名字查找。
 */
function powershellPath() {
  const root = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot.length > 0
    ? process.env.SystemRoot
    : 'C:\\Windows'
  const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    if (fs.existsSync(candidate)) return candidate
  } catch {
    /* 落到名字查找 */
  }
  return 'powershell.exe'
}

/**
 * 把内嵌脚本落到临时目录（内容哈希命名，已存在就不重写）。
 * @returns {string} 脚本绝对路径。
 */
function ensureScriptFile() {
  if (cachedScriptPath !== null) return cachedScriptPath
  if (!/^[\t\n\r\x20-\x7e]*$/.test(SCRIPT)) {
    throw new Error('helper script must stay ASCII-only')
  }
  const hash = crypto.createHash('sha1').update(SCRIPT, 'utf8').digest('hex').slice(0, 10)
  const file = path.join(os.tmpdir(), `dsh-focus-window-${hash}.ps1`)
  let current = null
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    current = null
  }
  if (current !== SCRIPT) {
    const staging = `${file}.${process.pid}.tmp`
    fs.writeFileSync(staging, SCRIPT, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(staging, file)
  }
  cachedScriptPath = file
  return file
}

/**
 * 跑一次脚本，拿回 stdout/stderr 与错误。永不 reject。
 * @param {string} scriptPath
 * @returns {Promise<{ error: NodeJS.ErrnoException | null, stdout: string, stderr: string }>}
 */
function runScript(scriptPath) {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ]
    execFile(
      powershellPath(),
      args,
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          error: error === undefined ? null : error,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        })
      },
    )
  })
}

/**
 * 解析脚本输出。协议见文件头部注释。
 * @param {string} stdout
 * @returns {{ verdict: 0 | 1 | null, method: string | null, title: string | null, error: string | null, details: string[] }}
 */
function parseOutput(stdout) {
  let verdict = null
  let method = null
  let title = null
  let error = null
  const details = []

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === 'FOCUSED=1') verdict = 1
    else if (line === 'FOCUSED=0') verdict = 0
    else if (line.startsWith('METHOD:')) method = line.slice('METHOD:'.length).trim() || null
    else if (line.startsWith('TITLE_B64:')) {
      const encoded = line.slice('TITLE_B64:'.length).trim()
      if (encoded.length > 0) {
        try {
          title = Buffer.from(encoded, 'base64').toString('utf8')
        } catch {
          title = null
        }
      }
    } else if (line.startsWith('DETAIL:')) details.push(line.slice('DETAIL:'.length).trim())
    else if (line.startsWith('ERROR:')) error = line.slice('ERROR:'.length).trim() || null
  }

  return { verdict, method, title, error, details }
}

/**
 * 把 DSH 桌面端主窗口切到前台。
 *
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {Promise<{ ok: boolean, method: string, title?: string, error?: string }>}
 *   `ok` 只有在脚本回读 `GetForegroundWindow()==目标 hwnd` 之后才会是 true。
 *   永不抛出。
 */
async function focusDshWindow(options) {
  const started = Date.now()
  const log = typeof options?.log === 'function' ? options.log : null
  const say = (message) => {
    if (log === null) return
    try {
      log(`focus: ${message}`)
    } catch {
      /* 日志自己坏了不该影响切窗口 */
    }
  }

  try {
    if (process.platform !== 'win32') {
      return { ok: false, method: METHOD.UNSUPPORTED, error: 'focusDshWindow only supports Windows' }
    }

    let scriptPath
    try {
      scriptPath = ensureScriptFile()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      say(`cannot stage helper script: ${message}`)
      return { ok: false, method: METHOD.ERROR, error: `cannot stage helper script: ${message}` }
    }

    const { error, stdout, stderr } = await runScript(scriptPath)
    const parsed = parseOutput(stdout)
    for (const detail of parsed.details) say(detail)

    if (error !== null) {
      const code = typeof error.code === 'string' ? error.code : ''
      const signal = typeof error.signal === 'string' ? error.signal : ''
      const timedOut = error.killed === true || code === 'ETIMEDOUT' || signal === 'SIGTERM'
      if (timedOut) {
        say(`timeout after ${TIMEOUT_MS} ms`)
        return { ok: false, method: METHOD.TIMEOUT, error: `timeout after ${TIMEOUT_MS} ms` }
      }
      const message = error.message || String(error)
      if (code === 'ENOENT') {
        say(`powershell not found: ${message}`)
        return { ok: false, method: METHOD.SPAWN_ERROR, error: `powershell not found: ${message}` }
      }
      say(`helper failed: ${message}`)
      return { ok: false, method: METHOD.ERROR, error: `helper failed: ${message}` }
    }

    if (parsed.verdict === null) {
      const hint = stderr.trim().split(/\r?\n/).filter((line) => line.length > 0).slice(0, 2).join(' | ')
      say(`helper produced no verdict${hint.length > 0 ? ` (stderr: ${hint})` : ''}`)
      return {
        ok: false,
        method: METHOD.ERROR,
        error: `helper produced no verdict${hint.length > 0 ? `: ${hint}` : ''}`,
      }
    }

    const method = parsed.method !== null ? parsed.method : METHOD.ERROR
    const result = { ok: parsed.verdict === 1, method }
    if (parsed.title !== null && parsed.title.length > 0) result.title = parsed.title
    if (result.ok) {
      say(`ok via ${method} in ${Date.now() - started} ms${result.title ? ` title="${result.title}"` : ''}`)
      return result
    }

    result.error = parsed.error !== null ? parsed.error : 'foreground-not-acquired'
    say(`failed (${result.error}) after ${Date.now() - started} ms`)
    return result
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    say(`unexpected failure: ${message}`)
    return { ok: false, method: METHOD.ERROR, error: `unexpected failure: ${message}` }
  }
}

module.exports = { focusDshWindow }
