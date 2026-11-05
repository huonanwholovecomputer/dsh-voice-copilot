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
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' } },
          h('input', {
            type: 'checkbox', checked: draft.wake,
            onChange: (event) => setField('wake', event.target.checked),
          }),
          h('span', null, '监听唤醒词'),
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
