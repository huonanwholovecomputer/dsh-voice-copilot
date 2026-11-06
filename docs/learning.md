# 小印的学习记录（learning/）

小印每跑一轮，插件都会把这轮的**思考过程、工具调用、工具返回、最终回复**记成一行 JSON，
落到 `learning/turns/YYYY-MM-DD.jsonl`。目的只有一个：把「实际工作里哪里卡住、哪里绕远、
用户纠正了什么」留成可分析的数据，回到本仓库复盘，然后改提示词、改工具、改流程。

记录只在本机，默认目录是插件 `dataDir` 下的 `learning/`；本机把它指到了仓库根目录的
`learning/`（`cordis.patch.yml` 里 `learningDir`），并且 `.gitignore` 已经挡住，不会进开源提交。

## 目录结构

```
learning/
  turns/2026-11-05.jsonl     每轮一行，主数据
  notes/2026-11-05.jsonl     小印自己用 voice_note 记的问题/想法
  sessions/<sessionId>.json  单个会话的累计摘要（轮数、工具数、失败数、最后一句用户输入）
```

## 一轮记录长什么样

```jsonc
{
  "v": 1,
  "sessionId": "session-…",
  "turn": 3,
  "startedAt": 1792138057704,   // 毫秒时间戳
  "endedAt": 1792138068120,
  "durationMs": 10416,
  "cwd": "D:\\打印机项目",
  "preset": "private-print-assistant",
  "model": "deepseek-v4.1-flash",
  "user": "帮我把申请表打两份",   // 已脱敏、已截断
  "userChars": 9,                // 脱敏后的原始长度（不是截断后的）
  "steps": 4,
  "thinking": [
    { "step": 1, "chars": 4210, "text": "先确认打印队列里有没有这一单……" } // 每段思考一条
  ],
  "tools": [
    {
      "step": 1,
      "name": "pwsh",
      "callId": "call_00_…",
      "args": "{\"command\":\"…\"}",  // 原样 JSON 字符串
      "argsChars": 118,
      "ok": true,
      "ms": 812,
      "result": "…",              // 已脱敏、已截断
      "resultChars": 2048,
      "error": "…"                // 只在 ok=false 时出现
    }
  ],
  "answer": "打好了，两份在出纸口。",
  "answerChars": 12,
  "reason": "completed",        // completed / interrupted / plugin-dispose / superseded
  "interrupted": false
}
```

`notes/*.jsonl` 一条：

```jsonc
{ "v": 1, "id": "note-…", "at": 1792138068120, "kind": "problem",
  "severity": "high", "title": "打印机偶发离线", "detail": "…",
  "sessionId": "…", "turn": 3, "cwd": "D:\\打印机项目" }
```

## 它是怎么产生的（实现要点）

- 数据源是宿主事件流。插件用 `ctx.on('session/event', (session, event) => …, { global: true })`
  订阅**所有**会话的事件——必须带 `global: true`，否则收不到别的上下文发出的会话事件。
- `turn/start` 开一轮；`user/message` 取用户原话；`assistant/message` 只取 `reasoning`（思考）
  与 `text`（回复），`tool-call` part 忽略（下面 `tool/call` 事件已经有一份）；
  工具调用看独立的 `tool/call`（含 `arguments` 字符串）与 `tool/result`（`toolCallId` 回填、
  `isError` 判失败、时间差算耗时）；`turn/end` 收尾。
- 事件按 `seq` 去重：会话跟随会重放窗口，重放的事件不会重复记账。
- 只记小印自己的语音会话（`resolveSessionId` 里 `learning.track(sessionId)` 登记过的）；
  其他会话的事件进来会直接返回。
- 插件卸载时 `flush()`：没收到 `turn/end` 的半轮仍然落盘，`reason: "plugin-dispose"`，
  `interrupted: true`。
- 截断在写盘时做：默认思考 4000 字、工具参数 2000 字、工具返回 1500 字，超出加 `…`，
  同时保留 `chars` 原长（所以「思考很长但没写清」这件事本身可被统计）。

## 脱敏

开启 `learningRedact`（默认开）时，落盘前统一打码：

- 手机号 `1[3-9]xxxxxxxxx` → `138****5678`
- 身份证 18 位 → 前 4 位 + 14 个 `*`
- `wxid_xxx` → `wxid_***`

工具参数、工具返回、思考、回复、notes 的标题与详情都过同一道脱敏。它只挡「一眼能认出来的
号码」，不挡姓名、地址、业务内容——`learning/` 默认不进 git，也是为了这个。

## 配置

插件配置项（`cordis.patch.yml` 的 `config`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `learning` | `true` | 总开关 |
| `learningDir` | 空 | 空则 `<dataDir>/learning`；本机指向仓库 `learning/` |
| `learningMaxChars` | `4000` | 每段思考的字符上限 |
| `learningToolArgsChars` | `2000` | 工具参数上限 |
| `learningToolResultChars` | `1500` | 工具返回上限 |
| `learningRedact` | `true` | 落盘前脱敏 |

改完配置或插件代码要重启 DSH 才生效。

## 复盘怎么用

1. 先出摘要：

   ```powershell
   python tools/learning_report.py            # 全部
   python tools/learning_report.py --days 7   # 最近一周
   python tools/learning_report.py --json     # 给别的脚本吃
   ```

   摘要给：轮次/会话/工具调用与失败率、每轮耗时 p50/p95/最长、思考字数、
   每天轮次、工具表现表（调用/失败/失败率/p50/p95）、最慢的几轮、小印自记的问题、
   以及几条启发式提示（失败率高的工具、p95 太慢的工具、思考过长的轮次、重复记录的问题）。

2. 带着摘要回到本仓库的对话里，按「症状 → 改哪里」来读：

   | 症状 | 先怀疑 | 改哪里 |
   | --- | --- | --- |
   | 同一工具连续失败、参数报错 | 参数约定、错误文案不明确 | 工具定义 / persona 里的用法说明 |
   | 工具对、但调用次数多、绕远路 | 提示词没给判定顺序、没有「先查再动」的约束 | `presets/*/cordis.patch.yml` 的 persona 与 `agent-instructions` |
   | 思考很长、回复很短 | 系统提示塞了太多流程；该写成脚本/工具 | 拆工具、把固定流程挪进脚本 |
   | 用户反复纠正同一件事 | 偏好没写进设定 | persona「用户偏好」段 |
   | 半轮中断多（`interrupted`） | 语音端超时/打断策略 | `silenceSeconds`、`maxSeconds`、宿主超时 |

3. 改完拿同一批 `learning/` 数据重跑报告，对比失败率与耗时，而不是凭感觉说「变好了」。

## 边界

- 这是**记录**，不是训练：不改模型权重，也不做在线学习。
- 记录里有用户原话（已脱敏），默认不进版本库；要分享样本请先手工挑，别整目录外发。
- 旧记录可以按天删：`learning/turns/2026-10-*.jsonl` 直接删掉即可，没有索引要维护。

## 持续学习闭环（tools/ 下的五个脚本）

`learning/` 记的是「小印怎么想的」，但它有个硬伤：**量太小**。本机跑了几天只有 7 轮，
一天 3–4 条，靠它统计任何东西都不显著。真正天然带标注的业务数据在另外两个地方：

| 数据源 | 有什么 | 为什么可信 |
| --- | --- | --- |
| 打印机日志 `%APPDATA%\HN打印工具\logs\*.log` | 每一单「出纸了、打的是哪几个文件、几张纸、单面还是双面」 | 这是**已经发生的事实**，不是模型猜的 |
| 台账 `var\ledger.db` 的 `file_msgs` | 同一批文件「是谁、什么时候发的、前后聊了什么」 | 顾客原话就嵌在 `context` 里 |

两边按「文件名 + 时间窗」对齐，就能**自动造出 (顾客原话 → 正确文件) 的样本**，
一行人工标注都不需要。这就是持续学习的燃料。

```
tools/order_labels.py    日志 ⨯ 台账 → 样本（自动对齐，不需要人工）
tools/eval_funnel.py     拿样本考 funnel：top1/top3/整批召回
tools/funnel.py          检索层本身（Step 0 分流 + 六步漏斗 + 加权排序 + 身份闸）
tools/identity.py        顾客身份判定（专业/班级/年级，T1/T2 证据分级）
tools/learn_vocab.py     从真实数据里学新词，写进 tools/vocab_learned.json
tools/learn_loop.py      一条命令跑完整闭环：刷新 → 造样本 → 评测 → 存基线 → 报变化
```

日常只用一条：

```powershell
python tools/learn_loop.py --refresh --rebuild-samples   # 有微信后端在跑时
python tools/learn_loop.py                               # 只重跑评测、跟上次比
python tools/learn_loop.py --history                     # 看历次成绩
```

它会把成绩追加到 `tools/learn_state.json`，并跟上一轮逐项对比 top1/top3/整批召回。
**样本数变了会明确提示「不能直接比」**——别拿 63 条时的 85.7% 去跟 84 条时的 85.7% 说「没退化」。

### 这套东西能改什么、不能改什么

能自动优化的是**检索层**（`funnel.py`）：业务词典、列权重、波宽、排序公式。
每次改完跑一遍 `learn_loop`，数字变好才留下。改 `funnel.py` 之前先备份，因为
`bridge/mcp_server.py` 的 `wechat_file_search` 会 import 它（见下节）。

不能自动优化的是**语义映射**：比如「那个霍尔的报告」为什么等于霍尔效应实验报告、
「综测和成绩」为什么是同一批里的两份。这类判断没有字面依据，自动学一定会学歪，
只能人手写进 `presets/private-print-assistant/EXPERIENCE.md`。

诚实的现状（2026-11-06 实测，别重复走弯路）：
- **自动学词目前挖不出东西**。84 条样本里能当查询串的只有 16 条，支持度≥2 的候选是 0 个；
  扫 729 行台账上下文只挖到 1 个「新社团」。原因是顾客原话 84% 根本不含内容词
  （见 EXPERIENCE.md 第 2 章），没有字面信号可学。这条路要等样本涨到几百条才有意义。
- **调权重也没用**。扫 `context` 权重 1/2/3/4 × `filename` 6/8 共 8 组，
  top1 恒 37、top3 恒 54，一组都不变。现在的瓶颈不在权重，在「这句话本身没有可检索内容」
  和「一波里挑哪一份」。

### 身份层：这一层是规则，不是学出来的

`tools/identity.py` 判定「这个顾客是哪个专业/哪个班的」，靠的是三类**可验证**证据，
而不是统计推断（下表人名、学号、班号均为虚构示例）：

| 级别 | 证据 | 例子 | 可信度 |
|---|---|---|---|
| T1 | 显示名自带专业班级 | `计科2401张三`、`电子2402李四`、`计科2601赵六` | high |
| T1 | 班级群组员 | `计科2401班级群`、`计科2401助学金` 的成员 | high |
| T2 | 学号第 7 位 = 班号末位 | `2499001017` → 2401；`2499003044` → 2403 | mid |
| T3 | 社团群、课程名、学院名 | 智能机器人社、数学建模1队、模拟电子技术实验、数科院 | **不采信** |

T3 明令禁止的原因很具体：**社团群是全校混编**。有位同学是「智能机器人社」的社长，
但她实际是数学专业（她来打的是数学专业成绩排名）。

三类陷阱词由 `identity.py` 的 `TRAP_WORDS` 先抹掉再解析：
`数学建模`（竞赛）、`模拟电子 / 电子技术 / 电子设计`（课程）、`智能机器人`（社团）、
`数科院`（学院名，不是「数科」专业）、`计算机基础`（公共课）。
加这张表的直接原因是实测 bug：`数学建模签到表（周一）.pdf` 被判成「数学专业限定」，
于是除数学专业外全校人都成了 mismatch。

**年级也是一道闸，不只是专业**。文件名里的 `24级 / 26级` 由 `GRADE_RE` 抓：
`24级计科大一日综测排名表.xlsx` 对计科 26 级的赵六判 `mismatch`
（「这份是 24 级的，你是 26 级」）。台账里绝大多数是同一届的几个班，相邻届只有零星几个人——
**少数派最容易被推错**，因为库里几乎所有表都是主流那届的。

这一层**不该由 learn_loop 自动优化**——判错会把材料推给错误的人，比推不出来更糟。
新增专业/班级时改 `identity.py` 的 `MAJOR_WORDS` / `CLASS_GROUPS` / `TRAP_WORDS`，然后跑
`.tmp-analysis/test_scope_gate.py` 看五种身份是否各自拿到该拿的那份。

为什么需要它：同一句「综测和成绩」，计科 2401 要 `计科成绩汇总表 + 计科综测排名表`，
电子/智能要的是各自专业的表（库里往往没有，正确动作是问），数学要
`2025-2026学年数学专业成绩排名.xlsx`。**查询词与文件名关键词完全一样，区别只在「谁在问」**，
所以它只能放在检索之后当一道闸，不能塞进检索算法里。

实测增量（84 条样本）：有身份判定 25 条、其中 1 条排名从第 5 升到第 1；
总体 top1/top3 不变——**这是一道安全网，不是提升准确率的手段**。

### 台账要定期刷新

`wechat_file_ledger(refresh=true)` 或 `learn_loop.py --refresh`。不刷新的后果很具体：
台账 `last_refresh` 停在哪，之后顾客发的文件就一条都进不来，检索再准也找不到。
本机实测停 37 小时后，评测里 9 条样本直接因为「台账里没这批文件」被判数据缺口。

### 接进 MCP 的位置

`…/WeChatDataAnalysis研究/bridge/mcp_server.py` 的 `_tool_wechat_file_search`
在 `q` 非空且 `smart` 不为 false 时，会先调 `funnel.lookup()` 拿一个**相关度顺序**
（`_funnel_order()`），再按 message_id 回台账取行——顺序用 funnel 的，行用台账的，
两边永远同源。`funnel` 不存在或 import 失败时自动退回纯台账 AND LIKE，工具不会挂。

`bridge/config.py` 的 `funnel_tools_dir`（环境变量 `WXCHAT_FUNNEL_TOOLS_DIR`）指向本仓库的
`tools/`；留空就关掉这个增强。

为什么必须这么接：台账的 SQL 是「空格分词、全部 AND」，而顾客原话整串传进去
（「综测和成绩给我打一份」）在台账里 **0 命中**。funnel 的 Step 0 分流 + 拆词是
把这 0 命中变成有候选的唯一办法。

身份闸也从这个入口进：`wechat_file_search(q=..., who=顾客名)`，
返回的 `match` 里会带 `person`（专业/班级/置信度）与 `scope_note`（「N 份跟你专业对不上」）；
`match.stage == 'scoped_out'` 表示一个都对不上，**这时该去问顾客，不是报一个最像的**。
私聊可以省略 `who`（自动取会话名）。


## 用店主自己的微信发消息（wechat_send_*）

这一组工具与上面的全部相反：它们是**对外动作**，会真的发到顾客手机上。

### 为什么不是 hook，而是 UIA

微信个人号没有官方发消息 API。市面上的方案只有两类：

- **UIA（模拟人点界面）**：不改微信进程、不注入内存、不发协议包。代价是必须有
  可交互的桌面会话（锁屏、远程桌面断开就失效），每次发送会抢占前台窗口，微信改
  界面就得改定位常量。
- **hook / 协议注入**：功能全（能收能发能群 @），但要往微信进程里写东西、逆向协议，
  腾讯风控能识别，且有真实封号先例；微信一升级整批失效（WeChatFerry 已归档）。

本机选的是 UIA，库是 `wechatauto-replica`（PyPI，Apache-2.0）。它是 wxauto 的 4.x
替代——wxauto 只支持微信 3.9.x，而本机是 **4.2.0.9**，直接不可用。

### 前置条件（缺一条都发不出去）

1. 微信已登录、进程在（进程名是 `Weixin`，不是老版的 `WeChat`）；
2. 主窗口**已恢复**——最小化或隐藏时 UIA 树拿不到，`doctor` 会报「控件树：拿不到」；
3. Qt accessibility gate **已热激活**：往 `Weixin.dll` 里写 1 个字节把 gate 打开。
   微信每次重启、升级、重新登录都会复位，所以要每次都做；
4. `pip install wechatauto-replica`（还需要 `pywin32`）。

`wechat_send_preflight` 会把这几条逐条检查完再告诉你能不能发、为什么不能。

### 三态返回，别把 maybe 说成成功

`wechat_send_text` / `wechat_send_file` 的 `state` 有三种：

- `sent`：数据库里读到了那条消息，**确实发出去了**；
- `maybe`：界面操作做了，但没读到落库。**别重发**，先看一眼店里的微信窗口——
  底层库给的文案是「已尝试发送但结果未确认，为避免重复发送不再自动重试」，它本身
  分不清「没发出去」和「发出去但没确认」，业务上这两件事必须分开；
- `failed`：明确没发出去（前置不满足或界面报错），`reason` 里给原因。

还有一个 `refused`：没带 `confirm=true`。这是故意的——发消息是唯一会惊动顾客的动作，
必须由店主在对话里明确同意，工具不接受「默认发」。

### 为什么自带一层回读，而不用库自带的 verify

底层的 `quick_send(..., verify=True)` 把回读窗口写死为 8 秒，而本机实测慢的不是落库
（1 秒内就到了），是**解密缓存的重建**（首次约 6 秒）。8 秒窗户经常赶不上，于是返回
那个歧义的「未确认」。所以 `tools/wechat_send.py` 自己做了三件事：

1. 发送前记该会话的落库水位（最新 `local_id`）；
2. 调底层发送时 `verify=False`，不让它自己猜；
3. 自己轮询：每轮先 `_invalidate_cache()` 强制重建，再看水位之后有没有新消息、
   内容是否匹配。实测第 1 次轮询就确认。

### 发出去的样子：逐字敲，不是整段粘贴

早期的发送走的是 `_paste_into`——把整段文字塞进剪贴板再 `Ctrl+V`。功能没问题，但
一天几十单都是「瞬间出现一整段」，还要占用店主的剪贴板，痕迹太重。

现在默认 `human=true`：`tools/human_type.py` 用 `SendInput` 的 Unicode 模式**一个字
一个字敲**，节奏取 `wechatauto.rhythm` 的 natural 档（`type_gap` / `key_hold` 带抖动、
写动作有间隔与突发上限）。`tools/wechat_send.py: _send_text_human()` 的顺序是：

1. `open_chat()` 打开会话 → 定位 `chat_input` 控件；
2. `wx_click()` 真点一下输入框拿焦点（微信输入框只认焦点上的键盘事件）；
3. 回读清残留 —— **`Ctrl+A` 在微信输入框上不生效**，只能按字符数敲退格；
4. `human_type.type_text()` 逐字敲；
5. **回车前回读比对**，不一致就清空、不发送——敲错比没发更糟；
6. `press_enter()` → 仍走前面那套数据库三态确认。

拟人路径失败会自动退回粘贴（回包的 `mode` 会写 `human` 还是 `paste`），所以默认开
不会降低可发送性。

> 踩过的坑：`wechatauto` 自带的 `type_unicode()` 一直敲不进输入框，原因是它的
> `INPUT` 结构体只声明了 `KEYBDINPUT`，x64 下是 **32 字节**，而 `SendInput` 要求
> **40 字节**（union 由 `MOUSEINPUT` 撑大）。`SendInput` 返回 0、`GetLastError()=87`，
> 但调用方不检查返回值——于是**静默失败**。`human_type.py` 补齐三个 union 成员并
> `assert ctypes.sizeof(INPUT) == 40`。

### 界面「窗口在、画面死」怎么办

本机 2026-11-06 出现过这种状态：进程在、`IsHungAppWindow=0`、`SendMessageTimeout`
秒回、`PrintWindow` 也能抓到完整画面——但点会话列表**一个像素都不变**，UIA 锚点只剩
`main_window`，`current_chat()` 和 `chat_input` 全是 None。此时发送必然报
`输入框没定位到（主窗可能不在聊天页）`。

判据只有画面差分：点一下会话，正常几万到几十万像素变化，死的只剩光标那几十个。
`wechat_send.py: _recover_ui()` 已把它产品化：先点一次会话测差分，不行就
`ShowWindow(SW_MINIMIZE)` → 1.2s → `SW_RESTORE` → 测 UIA 锚点与画面，实测这一招能
从 31 像素恢复到 275,031 像素。`preflight()` 会返回 `ui_alive` / `ui_recover`，
`ok=false` 时小印该让人手动点一下微信或重启，而不是硬试。

### 安全边界

发消息属于对外动作，与 persona 的硬约束一致：**不主动发、不替店主发、不在没被要求时发**。
调用前必须「店主明确说发 + 念回发给谁和正文」，调用时带 `confirm=true`。
`bridge/mcp_server.py` 顶部的铁律已把这三个工具单独标为「唯一的对外动作」。

---

## 当前默认：纯键盘链路（`tools/kbd_send.py`）

2026-11-06 下午，店主明确要求改用他自己平时的那套快捷键，不再碰 `wechatauto`：

> 「就用快捷键那一套方法吧，不要用其他显示微信进程的方式，不过保险起见，可以在每次
> 快捷键按下之后截个图分析一下。」

现在 `wechat_send_text` 默认走 `tools/kbd_send.py`（MCP 参数 `kbd` 默认 true，
`kbd=false` 才回退到上面那套粘贴路径）。

### 为什么必须换掉

`wechatauto/uia_driver.py` 的 `wake()` 会**静默把微信拉起来**：

```python
def wake(self) -> None:
    """weixin:// 协议唤起/显示窗口（托盘态也能拉起）；失败则拉起 exe。"""
    try:
        os.startfile("weixin://")        # ← 就是这句
        return
    except Exception:
        pass
    try:
        subprocess.Popen([DEFAULT_EXE])
```

调用链是 `ensure_window()` → `_find_main()` 找不到 → `_candidate_hwnds()` 也空 →
`self.wake()`。它**没有先判断微信是不是已经被关掉**，只要找不到窗口就默认你希望启动它。
同一个函数里还有 `_force_foreground()` 抢前台和 `_wake_accessibility()` 写微信进程内存。
那天我反复读控件树，微信被拉起、被抢前台、被改 z-order，店主为此重启了三次。

### 这条链路做什么

```
Ctrl+Alt+W  →  Ctrl+F  →  打全名  →  Enter  →  Ctrl+V  →  Enter
```

六步，每步截图存 `.tmp-analysis/kbd/<HHMMSS>-<NN>-<步骤名>.png`，
最后用只读 HTTP 接口做三态确认（`sent` / `maybe` / `failed`）。

模块纪律写在 docstring 里，比实现更重要：

- **不 import `wechatauto`**（它就带着 `wake()`；连 `from wechatauto import rhythm` 都会
  触发 `__init__.py` 连带加载 `guia`/`wx`/`db`）；
- 不调 `ShowWindow` / `SetWindowPos` / `SetForegroundWindow` / `AttachThreadInput`，
  不最小化、不置顶、不 post 消息——唤起微信只按店主自己的 `Ctrl+Alt+W`；
- 只做三件事：**截图**、**`SendInput` 敲键**、**HTTP 只读查消息**。

### 三个必须有的护栏

都是被真实事故逼出来的：

1. **先验前台进程名，再按键**。只看标题里有没有「微信」不够——那天前台其实是别的
   应用，我按下的 `Ctrl+F` 和正文全被它接走了，微信一个像素没动，我却以为它死了。
   判据改成「前台窗口 → `GetWindowThreadProcessId` → `psutil` 进程名 == `weixin.exe`」。
2. **回车后必须确认搜索面板真的关了才粘贴**。否则 `Ctrl+V` 会把整段正文粘进搜索框。
   判据是左侧面板画面差分 > 0.05；不达标就停下报 `failed`，不往下走。
3. **`Ctrl+F` 之后先清空搜索框**（`Ctrl+A` + `Back`）。微信会记住上次搜的词，
   不清空就会变成「上次残留 + 这次名字」拼成一串无效查询。

### 相机踩过的坑

- `SendInput` 的 Unicode 模式：**松开事件也必须带 `KEYEVENTF_UNICODE`**，只带
  `KEYEVENTF_KEYUP` 的抬起不被 Qt 认成同一个字符，整对事件被丢掉。症状是
  `SendInput` 返回成功、屏幕上一个字都没有。
- 组合键必须「全 down → 逆序全 up」一次投递，交替 down/up 不成立。
- `SetClipboardData` 必须声明 `argtypes`，否则 `OverflowError: int too long to convert`。
- `ctypes.windll.user32.CreateCompatibleDC` 取不到，要用 `ctypes.windll.gdi32`。
- 本机 150% 缩放：不先声明 DPI 感知（`SetProcessDpiAwarenessContext(-4)`），
  `GetWindowRect` 返回的是缩放后坐标，`SetCursorPos` 会点错位置。

### 还没做的

发文件（`wechat_send_file`）仍走旧的粘贴路径。拖文件到聊天窗口需要真实的
`WM_DROPFILES` 或剪贴板文件对象，比发文字复杂，等店主验收发文字之后再谈。

