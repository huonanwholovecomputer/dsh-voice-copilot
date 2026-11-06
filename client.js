/**
 * Voice copilot — Browser half.
 *
 * 干两件事：
 *  1. 把浮窗按下的「回到会话」落到真正的那段对话上；
 *  2. 在「插件 → 已安装 → DSH 语音助手」行上提供配置页，改称呼 / 唤醒词 / 提示词 / 热键，
 *     写回 Cordis 配置，宿主下一拍同步给浮窗，不需要重启 DSH。
 *
 * 为什么跳会话非要页面这一半：跳会话的 API（`uiWorkspace.openSession(id)`）是浏览器里的服务，
 * 宿主进程拿不到，通知类插件（dsh-notify-me / dsh-pet）也是靠页面里的这一句才跳得过去。
 *
 * 这文件必须是普通脚本（不能有顶层 import/export）：DSH 用
 * `window.__ModuleLoader__.load({ id, factory })` 加载它，`require` 由工厂注入。
 */
window.__ModuleLoader__.load({
  // 必须与 package.json "name" 完全一致，否则 client-modules 报：
  // bundle loaded without registering "@local/dsh-voice-copilot"
  id: '@local/dsh-voice-copilot', // ui-copy-ignore
  factory(require) {
    const react = require('react')
    const h = react.createElement

    const ROUTE = '/__dsh-voice-copilot/open-session' // ui-copy-ignore
    const PERSONA_ROUTE = '/__dsh-voice-copilot/preset-persona' // ui-copy-ignore
    const ROW_CONFIG_KEY = '@local/dsh-voice-copilot#voice-copilot' // ui-copy-ignore
    const LEDGER_ROUTE = '/__dsh-voice-copilot/ledger/chats' // ui-copy-ignore
    const LEDGER_EXCLUDE_ROUTE = '/__dsh-voice-copilot/ledger/exclude' // ui-copy-ignore
    const LEDGER_POLICY_ROUTE = '/__dsh-voice-copilot/ledger/policy' // ui-copy-ignore
    const LEDGER_POLICY_APPLY_ROUTE = '/__dsh-voice-copilot/ledger/policy/apply' // ui-copy-ignore
    const LEDGER_POLICY_UNDO_ROUTE = '/__dsh-voice-copilot/ledger/policy/undo' // ui-copy-ignore
    // 侧栏入口 id 与 main 面板 key 必须是同一个值。
    const PANEL_ID = '@local/dsh-voice-copilot#groups' // ui-copy-ignore
    // 800ms 一次：用户按下按钮到画面切过去，感知上还是「立刻」。
    const POLL_MS = 800

    const asText = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value))

    // 表单 value 只包含 volatile 字段；缺省值在这里显示为空，保存时只写改动过的键，
    // 所以不会把用户没碰的字段覆盖成空。
    const readDraft = (value) => {
      const v = value && typeof value === 'object' ? value : {}
      return {
        name: asText(v.name) || '小印',
        wakeWords: asText(v.wakeWords),
        prompt: asText(v.prompt),
        hotkey: asText(v.hotkey) || 'Ctrl+Alt+J',
        agentPreset: asText(v.agentPreset) || 'standard',
        cwd: asText(v.cwd),
        language: asText(v.language) || 'zh',
        silenceSeconds: asText(v.silenceSeconds == null ? '1.2' : v.silenceSeconds),
        maxSeconds: asText(v.maxSeconds == null ? '20' : v.maxSeconds),
        wake: v.wake !== false,
        releaseMicWhenWakeOff: v.releaseMicWhenWakeOff === true,
      }
    }

    const label = (text, control, hint) => h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' } },
      h('span', { style: { fontWeight: 600, fontSize: '0.92em' } }, text),
      control,
      hint ? h('span', { style: { opacity: 0.65, fontSize: '0.82em', lineHeight: 1.5 } }, hint) : null,
    )

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: '6px',
      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    }

    function SettingsPage(props) {
      const form = props ? props.form : undefined
      const [draft, setDraft] = react.useState(() => readDraft(form && form.state.value))
      const [initial, setInitial] = react.useState(() => readDraft(form && form.state.value))
      const [revision, setRevision] = react.useState(form && form.state.revision)
      const [busy, setBusy] = react.useState(false)
      const [message, setMessage] = react.useState('')
      const [persona, setPersona] = react.useState({ status: 'idle', preset: '', text: '', error: '' })

      const loadPersona = async (preset) => {
        const value = asText(preset).trim()
        if (!value) {
          setPersona({ status: 'empty', preset: '', text: '', error: '' })
          return
        }
        setPersona((prev) => ({ ...prev, status: 'loading', preset: value, error: '' }))
        try {
          const res = await fetch(`${PERSONA_ROUTE}?preset=${encodeURIComponent(value)}`, { cache: 'no-store' })
          const data = await res.json()
          setPersona({
            status: data && data.error ? 'error' : 'ready',
            preset: (data && data.preset) || value,
            text: (data && data.persona) || '',
            error: (data && data.error) || '',
          })
        } catch (error) {
          setPersona({ status: 'error', preset: value, text: '', error: String(error && error.message ? error.message : error) })
        }
      }

      react.useEffect(() => {
        if (busy) return
        const next = readDraft(form && form.state.value)
        setDraft(next)
        setInitial(next)
        setRevision(form && form.state.revision)
      }, [form && form.state.revision, form && form.state.status, busy])

      const ready = Boolean(form && form.state.status === 'ready' && form.state.writable)
      const setField = (key, value) => { setDraft((prev) => ({ ...prev, [key]: value })); setMessage('') }

      react.useEffect(() => {
        if (!ready) return
        void loadPersona(draft.agentPreset)
      }, [ready])

      const save = async () => {
        if (!ready || busy) return
        const silence = Number(draft.silenceSeconds)
        const max = Number(draft.maxSeconds)
        if (!Number.isFinite(silence) || silence < 0.3 || silence > 10) {
          setMessage('静音判定需要在 0.3–10 秒之间')
          return
        }
        if (!Number.isFinite(max) || max < 3 || max > 120) {
          setMessage('最长录音需要在 3–120 秒之间')
          return
        }
        const ops = []
        const textKeys = ['name', 'wakeWords', 'prompt', 'hotkey', 'agentPreset', 'cwd', 'language']
        for (const key of textKeys) {
          if (draft[key] !== initial[key]) ops.push({ op: 'set', path: [key], value: draft[key] })
        }
        if (draft.wake !== initial.wake) ops.push({ op: 'set', path: ['wake'], value: draft.wake })
        if (draft.releaseMicWhenWakeOff !== initial.releaseMicWhenWakeOff) {
          ops.push({ op: 'set', path: ['releaseMicWhenWakeOff'], value: draft.releaseMicWhenWakeOff })
        }
        if (silence !== Number(initial.silenceSeconds)) ops.push({ op: 'set', path: ['silenceSeconds'], value: silence })
        if (max !== Number(initial.maxSeconds)) ops.push({ op: 'set', path: ['maxSeconds'], value: max })
        if (ops.length === 0) { setMessage('没有改动'); return }
        setBusy(true)
        try {
          const accepted = await form.mutate(ops, revision)
          setMessage(accepted ? '已保存，浮窗会在下一拍同步' : '配置已被其他页面改动，请重试')
          if (accepted) setInitial(draft)
        } catch (error) {
          setMessage(String(error && error.message ? error.message : error))
        } finally {
          setBusy(false)
        }
      }

      if (!ready) {
        return h('p', { style: { opacity: 0.75, lineHeight: 1.7 } },
          form && form.state.status === 'loading'
            ? '正在读取配置…'
            : '当前环境不能在这里改配置：请编辑 profile 的 cordis.patch.yml 后重启。')
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: '560px' } },
        h('p', { style: { opacity: 0.75, lineHeight: 1.7, marginTop: 0 } },
          '这里的改动会写回 Cordis 配置，并同步给浮窗；称呼同时决定默认唤醒词。'),
        label('称呼 / 唤醒名', h('input', {
          style: inputStyle, value: draft.name, placeholder: '例如：小印',
          onChange: (event) => setField('name', event.target.value),
        }), '默认会据此生成「称呼」「嘿称呼」「称呼称呼」三个唤醒词。'),
        label('额外唤醒词', h('input', {
          style: inputStyle, value: draft.wakeWords, placeholder: '留空则自动生成；多个用逗号分隔',
          onChange: (event) => setField('wakeWords', event.target.value),
        }), '只有这里的词会覆盖自动生成；支持中文与空格分隔的多个词。'),
        label('提示词 / 人设', h('textarea', {
          style: { ...inputStyle, minHeight: '96px', resize: 'vertical' },
          value: draft.prompt, placeholder: '例如：你是我的桌面助手，回答尽量短，先给结论。',
          onChange: (event) => setField('prompt', event.target.value),
        }), '会作为一条开发者消息注入语音会话，可用 {{name}} 代入称呼。'),
        h('details', { style: { marginBottom: '16px' } },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600, fontSize: '0.92em' } },
            `当前预设人设（只读）${persona.preset ? ` · ${persona.preset}` : ''}`),
          h('div', { style: { marginTop: '8px' } },
            persona.status === 'loading'
              ? h('p', { style: { opacity: 0.7, margin: '4px 0' } }, '正在读取预设…')
              : persona.error
                ? h('p', { style: { color: '#d9534f', margin: '4px 0' } }, `读取失败：${persona.error}`)
                : persona.text
                  ? h('pre', {
                    style: {
                      margin: '4px 0', padding: '8px', maxHeight: '280px', overflow: 'auto',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
                      borderRadius: '6px', background: 'color-mix(in srgb, currentColor 4%, transparent)',
                      fontSize: '0.86em', lineHeight: 1.55,
                    },
                  }, persona.text)
                  : h('p', { style: { opacity: 0.7, margin: '4px 0' } },
                    persona.status === 'empty' ? '还没有配置语音会话预设。' : '这个预设没有 persona.prefix。'),
            h('button', {
              type: 'button', style: { marginTop: '8px' },
              onClick: () => { void loadPersona(draft.agentPreset) },
            }, '刷新'),
          ),
        ),
        label('全局热键', h('input', {
          style: inputStyle, value: draft.hotkey, placeholder: 'Ctrl+Alt+J',
          onChange: (event) => setField('hotkey', event.target.value),
        })),
        label('语音会话预设', h('input', {
          style: inputStyle, value: draft.agentPreset, placeholder: 'standard',
          onChange: (event) => setField('agentPreset', event.target.value),
          onBlur: (event) => { void loadPersona(event.target.value) },
        }), '留空则用 DSH 默认预设；只影响之后新建的语音会话，已有会话保持原预设。'),
        label('工作区目录', h('input', {
          style: inputStyle, value: draft.cwd, placeholder: '留空则用用户主目录',
          onChange: (event) => setField('cwd', event.target.value),
        })),
        h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
          label('静音判定（秒）', h('input', {
            style: inputStyle, type: 'number', min: 0.3, max: 10, step: 0.1,
            value: draft.silenceSeconds,
            onChange: (event) => setField('silenceSeconds', event.target.value),
          })),
          label('最长录音（秒）', h('input', {
            style: inputStyle, type: 'number', min: 3, max: 120, step: 1,
            value: draft.maxSeconds,
            onChange: (event) => setField('maxSeconds', event.target.value),
          })),
        ),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
          h('input', {
            type: 'checkbox', checked: draft.wake,
            onChange: (event) => setField('wake', event.target.checked),
          }),
          h('span', null, '监听唤醒词'),
        ),
        h('label', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '16px' } },
          h('input', {
            type: 'checkbox', checked: draft.releaseMicWhenWakeOff,
            onChange: (event) => setField('releaseMicWhenWakeOff', event.target.checked),
          }),
          h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('span', null, '关唤醒词时释放麦克风'),
            h('span', { style: { opacity: 0.65, fontSize: '0.85em', lineHeight: 1.5 } },
              '关掉唤醒词就放开麦克风（任务栏的麦克风图标会灭）；按热键时才临时开麦，开头一两个字可能缺一点。'),
          ),
        ),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
          h('button', { type: 'button', disabled: busy, onClick: () => { void save() } }, busy ? '保存中…' : '保存'),
          h('button', {
            type: 'button', disabled: busy,
            onClick: () => { setDraft(initial); setMessage('') },
          }, '撤销'),
          message ? h('span', { style: { opacity: 0.75, fontSize: '0.9em' } }, message) : null,
        ),
      )
    }

    const chipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '2px 9px',
      borderRadius: '999px',
      fontSize: '0.78em',
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      whiteSpace: 'nowrap',
    }
    const buttonStyle = {
      padding: '5px 12px',
      borderRadius: '7px',
      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    // 左侧栏的小图标。标签「小印」由 sidebar.panellist 的 label 渲染，这里只画图形。
    function CopilotPanelIcon(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 2.5, y: 5.2, width: 11, height: 6.3, rx: 1.4 }),
        h('path', { d: 'M5 5.2V3.4h6v1.8' }),
        h('path', { d: 'M5.6 8.6h4.8' }),
      )
    }

    /**
     * 「小印」管理页：群聊白名单。
     *
     * 勾选 = 纳入小印的查找范围（chats.excluded = 0），取消 = 排除（= 1）。
     * 只改台账里的标记，不删文件、不重刷索引；读的是本机 127.0.0.1 上的插件路由，
     * 所以台账网页服务没开着也能用。
     */
    function GroupManagerPage(props) {
      const layout = props ? props.layout : undefined
      const [state, setState] = react.useState({ status: 'loading', error: '', db: '', counts: null, chats: [] })
      const [query, setQuery] = react.useState('')
      const [onlyExcluded, setOnlyExcluded] = react.useState(false)
      const [busy, setBusy] = react.useState('')
      const [policyOpen, setPolicyOpen] = react.useState(false)
      const [policyMode, setPolicyMode] = react.useState('hybrid')
      const [policyDays, setPolicyDays] = react.useState('10')
      const [policyPin, setPolicyPin] = react.useState(true)
      const [policy, setPolicy] = react.useState({ status: 'idle', error: '', data: null, message: '' })
      const [snapAvailable, setSnapAvailable] = react.useState(false)

      const load = async () => {
        setState((prev) => ({ ...prev, status: 'loading', error: '' }))
        try {
          const res = await fetch(LEDGER_ROUTE, { cache: 'no-store', credentials: 'same-origin' })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
          setState({
            status: 'ready',
            error: '',
            db: asText(data.db),
            counts: data.counts || null,
            chats: Array.isArray(data.chats) ? data.chats : [],
          })
        } catch (error) {
          setState({
            status: 'error',
            error: asText(error && error.message ? error.message : error),
            db: '',
            counts: null,
            chats: [],
          })
        }
      }

      react.useEffect(() => { void load() }, [])

      const toggle = async (chat) => {
        if (busy) return
        const next = !chat.excluded
        setBusy(chat.username)
        setState((prev) => ({ ...prev, error: '' }))
        try {
          const res = await fetch(LEDGER_EXCLUDE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            credentials: 'same-origin',
            body: JSON.stringify({ username: chat.username, excluded: next }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
          setState((prev) => {
            const chats = prev.chats.map((item) => item.username === chat.username ? { ...item, excluded: next } : item)
            const nextGroups = chats.filter((item) => item.isGroup)
            const nextDirects = chats.filter((item) => !item.isGroup)
            return {
              ...prev,
              chats,
              counts: {
                chats: chats.length,
                groups: nextGroups.length,
                included: nextGroups.filter((item) => !item.excluded).length,
                excluded: nextGroups.filter((item) => item.excluded).length,
                directs: nextDirects.length,
                directsIncluded: nextDirects.filter((item) => !item.excluded).length,
                directsExcluded: nextDirects.filter((item) => item.excluded).length,
              },
            }
          })
        } catch (error) {
          setState((prev) => ({ ...prev, error: `没切成功：${asText(error && error.message ? error.message : error)}` }))
        } finally {
          setBusy('')
        }
      }

      const policyQuery = () => `?days=${encodeURIComponent(policyDays)}&mode=${encodeURIComponent(policyMode)}&pin=${policyPin ? '1' : '0'}`

      const previewPolicy = async () => {
        setPolicy({ status: 'loading', error: '', data: null, message: '' })
        try {
          const res = await fetch(`${LEDGER_POLICY_ROUTE}${policyQuery()}`, { cache: 'no-store', credentials: 'same-origin' })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
          setPolicy({ status: 'ready', error: '', data, message: '' })
          setSnapAvailable(Boolean(data.snapshotAvailable))
        } catch (error) {
          setPolicy({ status: 'error', error: asText(error && error.message ? error.message : error), data: null, message: '' })
        }
      }

      const applyPolicy = async () => {
        if (policy.status === 'applying') return
        setPolicy((prev) => ({ ...prev, status: 'applying', error: '', message: '' }))
        try {
          const res = await fetch(LEDGER_POLICY_APPLY_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            credentials: 'same-origin',
            body: JSON.stringify({ days: Number(policyDays), mode: policyMode, pinOrderChats: policyPin }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
          setPolicy({
            status: 'done',
            error: '',
            data: null,
            message: Number(data.changed) > 0 ? `已应用：${data.changed} 个会话被调整` : (data.message || '没有需要改动的会话'),
          })
          setSnapAvailable(Boolean(data.snapshot))
          await load()
        } catch (error) {
          setPolicy((prev) => ({ ...prev, status: 'error', error: asText(error && error.message ? error.message : error) }))
        }
      }

      const undoPolicy = async () => {
        setPolicy((prev) => ({ ...prev, status: 'undoing', error: '', message: '' }))
        try {
          const res = await fetch(LEDGER_POLICY_UNDO_ROUTE, { method: 'POST', cache: 'no-store', credentials: 'same-origin' })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
          setPolicy({ status: 'idle', error: '', data: null, message: `已撤销：恢复 ${data.changed} 个会话` })
          setSnapAvailable(false)
          await load()
        } catch (error) {
          setPolicy((prev) => ({ ...prev, status: 'error', error: asText(error && error.message ? error.message : error) }))
        }
      }

      const counts = state.counts || { chats: 0, groups: 0, included: 0, excluded: 0, directs: 0, directsIncluded: 0, directsExcluded: 0 }
      const needle = query.trim().toLowerCase()
      const matchesFilter = (item) => {
        if (onlyExcluded && !item.excluded) return false
        if (!needle) return true
        return `${item.name} ${item.note} ${item.username} ${item.preview}`.toLowerCase().includes(needle)
      }
      // 排序：已选中的在前 → 未选中的在后 → 文件数从多到少 → 名字（中文按拼音，数字按大小）。
      const nameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
      const byStatusThenFilesThenName = (a, b) =>
        (Number(Boolean(a.excluded)) - Number(Boolean(b.excluded)))
        || (Number(b.files) || 0) - (Number(a.files) || 0)
        || nameCollator.compare(a.name, b.name)
      const groups = state.chats.filter((item) => item.isGroup).filter(matchesFilter).sort(byStatusThenFilesThenName)
      const directs = state.chats.filter((item) => !item.isGroup).filter(matchesFilter).sort(byStatusThenFilesThenName)

      const back = () => {
        try {
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
        } catch { /* 布局还没就绪时忽略 */ }
      }

      const rowStyle = (chat) => ({
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '10px 12px',
        marginBottom: '8px',
        borderRadius: '10px',
        cursor: 'pointer',
        border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
        background: chat.excluded ? 'color-mix(in srgb, currentColor 4%, transparent)' : 'transparent',
        opacity: chat.excluded ? 0.74 : 1,
      })

      const renderRow = (chat) => h('label', { key: chat.username, style: rowStyle(chat) },
        h('input', {
          type: 'checkbox',
          checked: !chat.excluded,
          disabled: busy === chat.username,
          onChange: () => { void toggle(chat) },
          style: { marginTop: '3px', width: '16px', height: '16px', accentColor: '#4f8cff' },
        }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600 } }, chat.name),
            chat.note ? h('span', { style: { ...chipStyle, fontSize: '0.74em' } }, chat.note) : null,
            h('span', { style: { opacity: 0.55, fontSize: '0.8em' } }, chat.files ? `${chat.files} 份文件` : '没有文件'),
            chat.excluded ? h('span', { style: { ...chipStyle, fontSize: '0.74em' } }, '已排除') : null,
            chat.pinned ? h('span', { style: { ...chipStyle, fontSize: '0.74em' } }, '置顶') : null,
          ),
          chat.preview
            ? h('div', {
              style: {
                opacity: 0.5,
                fontSize: '0.8em',
                marginTop: '2px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }, chat.preview)
            : null,
        ),
      )

      const renderSection = ({ title, hint, items, total, includedCount, emptyHint }) => h('div', { style: { marginBottom: '24px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' } },
          h('h3', { style: { margin: 0, fontSize: '1.02em', fontWeight: 650 } }, title),
          h('span', { style: { opacity: 0.6, fontSize: '0.82em' } }, `纳入 ${includedCount}/${total}，显示 ${items.length}`),
          h('span', { style: { opacity: 0.45, fontSize: '0.78em' } }, hint),
        ),
        items.length === 0
          ? h('div', { style: { opacity: 0.55, padding: '8px 2px', fontSize: '0.9em' } }, emptyHint)
          : h('div', null, items.map(renderRow)),
      )

      return h('div', {
        style: {
          height: '100%',
          overflowY: 'auto',
          padding: '28px 32px 56px',
          boxSizing: 'border-box',
          color: 'inherit',
          font: 'inherit',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' } },
          h('h2', { style: { margin: 0, fontSize: '1.4em', fontWeight: 650 } }, '小印 · 聊天白名单'),
          h('span', { style: chipStyle }, '只在这里找文件'),
          h('span', { style: { flex: 1 } }),
          h('button', { style: buttonStyle, onClick: back }, '← 回到会话'),
        ),
        h('p', { style: { margin: '0 0 16px', opacity: 0.68, fontSize: '0.9em', lineHeight: 1.6, maxWidth: 800 } },
          '勾选的会话＝小印会去里面找文件；取消勾选＝排除，台账搜索、微信搜索、新消息都不再出现它们，但记录不删、随时能勾回来。群聊只用来检索文件，小印不会往群里发消息或订单价格；个人聊天同理，只读不主动发。',
        ),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' } },
          h('span', { style: chipStyle }, `群聊 ${counts.groups} · 纳入 ${counts.included} / 排除 ${counts.excluded}`),
          h('span', { style: chipStyle }, `个人 ${counts.directs} · 纳入 ${counts.directsIncluded} / 排除 ${counts.directsExcluded}`),
          h('span', { style: { ...chipStyle, opacity: 0.65 } }, `台账 ${counts.chats} 个会话`),
        ),
        h('div', { style: { border: '1px solid color-mix(in srgb, currentColor 14%, transparent)', borderRadius: '10px', marginBottom: '14px' } },
          h('button', {
            type: 'button',
            onClick: () => setPolicyOpen((value) => !value),
            style: {
              display: 'flex', width: '100%', alignItems: 'center', gap: '8px',
              padding: '10px 12px', background: 'transparent', border: 'none',
              color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left',
            },
          },
            h('span', { style: { fontWeight: 600 } }, '一键策略'),
            h('span', { style: { opacity: 0.6, fontSize: '0.86em' } }, '按最近的订单来源圈定：群只留供过打印文件的，私聊只留有文件的'),
            h('span', { style: { flex: 1 } }),
            snapAvailable ? h('span', { style: { ...chipStyle, fontSize: '0.74em' } }, '可撤销') : null,
            h('span', { style: { opacity: 0.6, fontSize: '0.86em' } }, policyOpen ? '收起' : '展开'),
          ),
          policyOpen
            ? h('div', { style: { padding: '0 12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' } },
              h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
                h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '0.9em' } },
                  '口径',
                  h('select', {
                    value: policyMode,
                    onChange: (event) => setPolicyMode(event.target.value),
                    style: { ...inputStyle, width: 'auto', padding: '4px 8px' },
                  },
                    h('option', { value: 'hybrid' }, '混合（私聊按文件，群按订单）'),
                    h('option', { value: 'orders' }, '只按订单来源'),
                    h('option', { value: 'files' }, '按台账文件'),
                  ),
                ),
                h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '0.9em' } },
                  '窗口',
                  h('input', {
                    type: 'number', min: 1, max: 120, value: policyDays,
                    onChange: (event) => setPolicyDays(event.target.value),
                    style: { ...inputStyle, width: '76px', padding: '4px 8px' },
                  }),
                  '天',
                ),
                h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '0.9em', cursor: 'pointer' } },
                  h('input', { type: 'checkbox', checked: policyPin, onChange: (event) => setPolicyPin(event.target.checked) }),
                  '置顶供单群',
                ),
                h('span', { style: { flex: 1 } }),
                h('button', {
                  type: 'button', style: buttonStyle, disabled: policy.status === 'loading',
                  onClick: () => { void previewPolicy() },
                }, policy.status === 'loading' ? '分析中…' : '预览方案'),
                h('button', {
                  type: 'button', style: buttonStyle,
                  disabled: policy.status !== 'ready' || !policy.data || !policy.data.plan || !policy.data.plan.totals.changed,
                  onClick: () => { void applyPolicy() },
                }, policy.status === 'applying' ? '应用中…' : '应用方案'),
                snapAvailable
                  ? h('button', {
                    type: 'button', style: { ...buttonStyle, opacity: 0.85 }, disabled: policy.status === 'undoing',
                    onClick: () => { void undoPolicy() },
                  }, policy.status === 'undoing' ? '撤销中…' : '撤销上次')
                  : null,
              ),
              policy.error
                ? h('div', { style: { color: '#e5484d', fontSize: '0.88em', lineHeight: 1.5 } }, policy.error)
                : null,
              policy.message
                ? h('div', { style: { fontSize: '0.88em', lineHeight: 1.5, opacity: 0.85 } }, policy.message)
                : null,
              policy.data && policy.data.plan
                ? (() => {
                  const plan = policy.data.plan
                  const totals = plan.totals || {}
                  const attr = policy.data.attr || {}
                  const changes = plan.changes || []
                  const keep = changes.filter((item) => item.action === 'keep')
                  const drop = changes.filter((item) => item.action === 'exclude')
                  return h('div', { style: { fontSize: '0.86em', lineHeight: 1.6 } },
                    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
                      h('span', { style: chipStyle }, `群 ${totals.groupsIncluded || 0}/${totals.groups || 0}`),
                      h('span', { style: chipStyle }, `私聊 ${totals.directsIncluded || 0}/${totals.directs || 0}`),
                      h('span', { style: chipStyle }, `文件 ${totals.visibleFiles || 0}/${totals.files || 0}`),
                      h('span', { style: chipStyle }, `改动 ${totals.changed || 0}`),
                      h('span', { style: { ...chipStyle, opacity: 0.7 } },
                        `批次 ${attr.batches || 0} · 云端 ${attr.cloud || 0} · 图片 ${attr.image || 0} · 未归因 ${attr.unknown || 0}`),
                    ),
                    changes.length === 0
                      ? h('div', { style: { opacity: 0.7 } }, '当前标记已经符合这个口径，不需要改动。')
                      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                        keep.length > 0
                          ? h('div', null,
                            h('div', { style: { opacity: 0.7, marginBottom: '3px' } }, `将纳入 ${keep.length} 个（${plan.days} 天窗口）`),
                            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                              keep.slice(0, 24).map((item) => h('span', {
                                key: item.username,
                                style: { ...chipStyle, borderColor: 'color-mix(in srgb, #3fb950 45%, transparent)' },
                              }, `${item.name} · ${item.reason}`)),
                              keep.length > 24 ? h('span', { style: { ...chipStyle, opacity: 0.6 } }, `…另 ${keep.length - 24} 个`) : null,
                            ),
                          )
                          : null,
                        drop.length > 0
                          ? h('div', null,
                            h('div', { style: { opacity: 0.7, marginBottom: '3px' } }, `将排除 ${drop.length} 个`),
                            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                              drop.slice(0, 24).map((item) => h('span', {
                                key: item.username,
                                style: { ...chipStyle, opacity: 0.7 },
                              }, `${item.name} · ${item.reason}`)),
                              drop.length > 24 ? h('span', { style: { ...chipStyle, opacity: 0.6 } }, `…另 ${drop.length - 24} 个`) : null,
                            ),
                          )
                          : null,
                      ),
                  )
                })()
                : null,
              h('div', { style: { opacity: 0.55, fontSize: '0.78em', lineHeight: 1.6 } },
                '做法：先从打印机日志重建最近的打印批次，再按文件名对齐台账，判断文件是谁发的。云端上传、微信图片、你自己回传的加工件不计入任何会话。应用前会自动备份当前勾选，可一键撤销。'),
            )
            : null,
        ),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' } },
          h('input', {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: '过滤群名 / 昵称 / 备注 / 最后一条消息',
            style: { ...inputStyle, flex: '1 1 260px', maxWidth: '440px' },
          }),
          h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '0.88em', opacity: 0.8, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: onlyExcluded, onChange: (event) => setOnlyExcluded(event.target.checked) }),
            '只看已排除',
          ),
          h('span', { style: { flex: 1 } }),
          h('button', { style: buttonStyle, onClick: () => { void load() }, disabled: state.status === 'loading' },
            state.status === 'loading' ? '读取中…' : '刷新'),
        ),
        state.error
          ? h('div', {
            style: {
              padding: '10px 12px',
              marginBottom: '12px',
              borderRadius: '8px',
              fontSize: '0.9em',
              lineHeight: 1.5,
              border: '1px solid color-mix(in srgb, #e5484d 55%, transparent)',
              background: 'color-mix(in srgb, #e5484d 10%, transparent)',
            },
          }, state.error)
          : null,
        state.status === 'loading' && state.chats.length === 0
          ? h('div', { style: { opacity: 0.6, padding: '20px 0' } }, '正在读台账…')
          : h('div', null,
            renderSection({
              title: '群聊',
              hint: '群里被打印过的文件，才会进入小印的查找范围',
              items: groups,
              total: counts.groups,
              includedCount: counts.included,
              emptyHint: needle || onlyExcluded ? '没有匹配的群。' : '台账里还没有群。先让台账刷新一次索引。',
            }),
            renderSection({
              title: '个人聊天',
              hint: '按人找文件：勾选后小印能在这位好友的聊天里找',
              items: directs,
              total: counts.directs,
              includedCount: counts.directsIncluded,
              emptyHint: needle || onlyExcluded ? '没有匹配的个人聊天。' : '台账里还没有个人聊天记录。',
            }),
          ),
        h('div', { style: { marginTop: '18px', opacity: 0.5, fontSize: '0.78em', lineHeight: 1.7 } },
          state.db ? `台账：${state.db}` : '',
          state.db ? h('br') : null,
          '切换只改 chats.excluded 标记；不会删文件、不会重刷索引。',
        ),
      )
    }

    return {
      // 不写 'uiWorkspace'：inject 会让 fiber 等这个服务上线，而它由页面后注册，
      // 等不到就永远是 pending，apply 不执行。改成每次用 ctx.get 免 inject 读取。
      inject: ['slots'], // ui-copy-ignore
      apply(ctx) {
        let disposed = false
        let inflight = false

        // 插件行的配置页。key 规则：<包名>#<cordis.patch.yml 里的行 id>。
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
          { name: 'plugins.row.config', key: ROW_CONFIG_KEY },
          (slotProps) => slotProps && slotProps.view === 'summary'
            ? '称呼、唤醒词、提示词与热键'
            : h(SettingsPage, slotProps || {}),
        ))

        // 左侧栏的「小印」页：sidebar.panellist 是图标入口，main 是按同一个 id 取的主区页面。
        // 两个都注册才完整——少了 main，点图标会直接抛「找不到 main 组件」。
        ctx.effect(() => {
          const disposers = []
          const disposeAll = () => {
            for (const dispose of disposers.reverse()) {
              try { dispose() } catch { /* 卸载阶段忽略 */ }
            }
            disposers.length = 0
          }
          try {
            disposers.push(ctx.slots.inject('main', () => ctx.slots.register( // ui-copy-ignore
              {
                name: 'main', // ui-copy-ignore
                key: PANEL_ID,
                // main 组件只拿注入的 props；layout 用来「回到会话」。
                inject: () => ({ layout: ctx.get('layout') }), // ui-copy-ignore
              },
              (slotProps) => h(GroupManagerPage, slotProps || {}),
            )))
            disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register( // ui-copy-ignore
              {
                name: 'sidebar.panellist', // ui-copy-ignore
                id: PANEL_ID,
                // 插件 0、自动化任务 10、记忆 30，小印夹在中间。
                order: 20,
                label: () => '小印',
              },
              CopilotPanelIcon,
            )))
          } catch (error) {
            disposeAll()
            console.warn('[voice-copilot] 侧栏页没有注册成功:', error)
          }
          return disposeAll
        })

        /**
         * 切到指定会话。服务在旧宿主里可能不存在（那时侧栏还没有 uiWorkspace），
         * 也可能还没就绪——两种情况都只是「这次没跳成」，不能把异常抛给页面。
         *
         * 必须走 ctx.get：Cordis 的 ctx 是代理，读未 inject 的服务属性会抛
         * `cannot get property "uiWorkspace" without inject`，直接把整个条目打成 failed。
         * @returns {boolean} 是否真的叫到了
         */
        const openSession = (sessionId) => {
          const workspace = ctx.get('uiWorkspace') // ui-copy-ignore
          if (!workspace || typeof workspace.openSession !== 'function') return false
          try {
            workspace.openSession(sessionId)
            return true
          } catch (error) {
            console.warn('[voice-copilot] openSession failed:', error)
            return false
          }
        }

        const poll = async () => {
          if (disposed || inflight) return
          inflight = true
          try {
            const res = await fetch(ROUTE, { cache: 'no-store', credentials: 'same-origin' })
            if (!res.ok) return
            const data = await res.json()
            const sessionId = data && typeof data.sessionId === 'string' ? data.sessionId : ''
            if (!sessionId) return
            if (openSession(sessionId)) {
              console.log('[voice-copilot] switched to session', sessionId)
              try { window.focus() } catch { /* 桌面壳里由宿主抬窗，这里只是兜底 */ }
            } else {
              console.warn('[voice-copilot] uiWorkspace.openSession 不可用，会话没有切换')
            }
          } catch {
            /* 宿主还没起来或页面正在卸载：下一次再试 */
          } finally {
            inflight = false
          }
        }

        const timer = setInterval(() => { void poll() }, POLL_MS)
        ctx.effect(() => () => {
          disposed = true
          clearInterval(timer)
        })
      },
    }
  },
})
