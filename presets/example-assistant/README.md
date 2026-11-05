# 示例助手 · 一个 agent preset 的最小骨架

这是可选的第二个 bundle（`@local/dsh-preset-example`），跟根目录的语音插件互不依赖：装不装它都不影响语音功能。它演示的是「怎么给 DSH 加一个自己的会话模式」——一条 `@deepseek-ai/dsh-agent-preset` 声明、一段人设、一组按需挂载的工具，以及一个默认关闭的 MCP 能力行。

代码总共就两个文件：

```
presets/example-assistant/
├── package.json        # bundle 清单：dsh.bundle.patch 指向下面的 YAML
├── cordis.patch.yml    # 全部内容都在这
└── README.md
```

## 装上之后会发生什么

- DSH 的 agent 预设列表里多一个「示例助手」（id `example-assistant`，order 5）。
- 它**只对安装之后新建、并且在会话里明确选了这个预设的 agent 生效**，不会改任何现有预设，也不会改默认预设。
- 它不装第三方依赖、不常驻子进程：MCP 那一行默认 `disabled: true`，没打开之前不会 spawn 任何东西。

## 一个 preset 由什么组成

`cordis.patch.yml` 里只有一条 `insert`，条目名就是 preset 插件本身：

```yaml
- insert:
    - id: preset-example
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: example-assistant      # 唯一 id，语音插件的「语音会话预设」填它
        name: 示例助手              # 界面上显示的名字
        description: ...
        order: 5
        plugins: [...]             # 这个模式里可用的全部能力
```

`config.plugins` 是这个模式的全集，**没写进来的能力就是没有**（模型调不到不存在的工具，也不会假装会）。示例里给了四类：

| 类别 | 行 | 说明 |
| --- | --- | --- |
| 身份 | `dsh-persona` | 人设只能挂在 preset 组装内部，写在别处不生效 |
| 上下文 | `dsh-agent-instructions`、`dsh-time-context` | 项目说明文件 + 当前时间 |
| 本机工具 | `dsh-tool-pwsh`、`dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-jobs`、`dsh-tool-ask-user` | 读写、搜索、跑命令、后台作业、反问用户 |
| 可选 | `dsh-mcp-client` | 外部 MCP stdio 服务，默认关闭 |
| 上下文管理 | `cordis:group`（compaction） | 手动 `/compact` + 工具结果剪枝 |

## 安装

```text
plugin_manager install_bundle(target: "<本目录绝对路径>")
```

装完**完全退出并重启桌面端**（只刷新页面不够），再新建会话选「示例助手」。想让语音会话跑在这个模式里，在插件页的「语音会话预设」里填 `example-assistant`。

回滚：在插件页禁用（或卸载）这个 bundle，重启即可；它没有写入任何 repo 外的状态。

## 改造指南

1. **改成你自己的**：换 `id`、`name`、`description`，把人设 `prefix` 整段替换。id 一旦改掉，语音插件里填的旧值要同步改。
2. **删工具**：不需要命令行就把 `tool-pwsh` 整行删掉；不需要后台作业就删 `tool-jobs`。少挂一个工具就少一段工具说明，模型也更不容易乱用。
3. **开 MCP**：把 `mcp-example` 的 `disabled: true` 删掉，填好 `command` / `args` / `env`。`env` 建议只放环境变量名与占位值，真值走本机环境，别写进仓库。
4. **跨平台**：示例用 `disabled: !!js process.platform !== 'win32'` 给 pwsh 行做门控；在 mac/linux 上换成 `dsh-tool-bash` 之类的对应行。
5. **别把私有内容写回来**：业务文案、客户数据、本机绝对路径、凭证都不要进这个目录。私有的 preset 放在 `presets/private-*/` 之类的路径，由 `.gitignore` 挡住。

## 两个刻意的设计取舍

**MCP 行放在 preset 内部，而不是 profile 级。** 放在里面，`serverName` 只在这个预设的会话作用域里预留，其它预设看不到这批工具，也不会在别的会话里常驻一个子进程；放在 profile 级则是全局可见、全局常驻。示例默认关闭，是为了让「装好即能用」和「接了外部服务」这两件事解耦。

**`compaction-basic` 的 `auto: false`。** 如果本机还装了在 ACP 层接管压缩的外部件（billion-context 之类），它会自己负责压缩；这里关掉自动压缩，避免两个压缩器同时改上下文。手动 `/compact` 与工具结果剪枝不受影响，仍然可用。如果你没装那类外部件、想让它自动压，把 `auto` 改回 `true` 即可。
