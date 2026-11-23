# dsh-electric-sheep

[English](README.md) | 中文

## 概述

为 DeepSeek Harness 的 profile 增加一个每日复盘会话。每天一次，或执行 `/sleep` 时，一个隔离会话复盘上次睡眠以来有活动的会话，并重写 `$DSH_HOME/sleep/` 下的笔记。之后每个工作会话都以一个 `<system-reminder>` 块携带这些笔记启动。

睡眠会话运行在自己的 `sleep` preset 下。该 preset 不挂载 agent instructions，也不挂载任何项目工具，因此该会话只看到 7 个睡眠工具。

## 目录

- [环境要求](#requirements)
- [安装](#install)
- [你会得到什么](#what-you-get)
- [配置](#configuration)
- [`/sleep` 命令](#the-sleep-command)
- [笔记的位置](#where-the-notes-live)
- [已知限制](#known-limitations)
- [链接](#links)

-----

<a id="requirements"></a>
## 环境要求

- DeepSeek Harness `0.2.3-alpha.2` 或更新版本。包在 `engines.dsh` 中声明了这一下限。
- 一个组合了存储提供方、会话查询服务，以及（要用 `/sleep` 时）命令注册表的 profile。标准的 `web` 和 `headless` profile 满足这些条件。
- 构建后的 JavaScript 所导入的 `@deepseek-ai/*` 包是本包的 peer。每个 DSH 安装都提供它们，因此安装时不需要额外下载。

`cordis.patch.yml` 中的两行还引用了 `@deepseek-ai/dsh-agent-preset`、`@deepseek-ai/dsh-persona` 和 `@deepseek-ai/dsh-compaction-basic`。这些包同样由 DSH 安装提供。

<a id="install"></a>
## 安装

把包安装到 profile：

```sh
dsh plugin --profile web add https://github.com/AngryRaccoon77/dsh-electric-sheep
```

然后启用该 bundle。在 Web 中打开侧边栏的**插件**页，选择**立即启用**。也可以把 `"dsh-electric-sheep"` 加入 profile `package.json` 的 `dsh.profile.bundles`。启用 HMR 时选择即时生效；否则重启应用。

安装某个固定提交：

```sh
dsh plugin --profile web add "https://github.com/AngryRaccoon77/dsh-electric-sheep#<commit>"
```

把 `<commit>` 换成完整的 40 位提交 sha。插件管理器按固定的提交识别 Git bundle，因此固定安装的版本不会自行移到更新的提交。

在**插件 → dsh-electric-sheep → 移除**中卸载，或执行 `dsh plugin --profile web remove dsh-electric-sheep`。

<a id="what-you-get"></a>
## 你会得到什么

[`cordis.patch.yml`](cordis.patch.yml) 插入两行。

| 行 | 增加的内容 |
|---|---|
| `sleep` | 宿主运行时，发布为 `ctx.sleep`，提供 `config`、`state`、`stateError`、`activeSessionId`、`activeRun`、`nextSlot()`、`startNow()` 和 `runNow()` |
| `preset-sleep` | `sleep` agent preset：一个 `@deepseek-ai/dsh-persona` 前缀、遮蔽继承宿主工具的隔离行，以及隔离的 `@deepseek-ai/dsh-compaction-basic` |

- 运行时按计划或按需执行，任一时刻最多一次睡眠尝试。
- 时隙来自 `timeZone` 中的 `time`。Host 停机期间错过的时隙在启动后补跑一次，已经记录过计划决定的本地日期不再运行。
- 计划运行要求至少 `minSessions` 个非睡眠会话在 `lastSleepAt` 之后有活动。无事可复盘的一天只记录日期，不创建会话。
- 睡眠会话在任何发起 agent 之外创建，命名为 `Sleep · <本地日期>`，并在首次请求前获得 `reasoningEffort`。运行时会按路由模型核对该强度：模型声明了该级别就用它，另有默认值时改用默认值，完全没有声明强度时保留适配器默认值。每次降级都会记录日志。工作会话保留用户自己的模型选择。
- 一条 `agent/pre-step` 守卫把工作区 instructions 挡在每个睡眠会话之外，因此无论 profile 把 `dsh-agent-instructions` 挂成 preset 行还是宿主行，隔离都成立。
- 一个 `agent/pre-step` 监听器把已保存的笔记重新加载到每个工作会话。

<a id="configuration"></a>
## 配置

`sleep` 行接受以下字段。随附的 patch 设置了这里列出的每个默认值；要修改时，改动 patch 的 `config` 块。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dir` | 必填 | 存放笔记的目录；随附 patch 设为 `dshHomePath('sleep')` |
| `enabled` | `true` | 每日时隙是否可自行启动运行；`/sleep` 忽略此项 |
| `time` | `'03:00'` | `timeZone` 中的每日时隙，格式 `HH:mm` |
| `timeZone` | 宿主时区，否则 `UTC` | 时隙遵循的 IANA 时区 |
| `minSessions` | `1` | 计划运行要求的上次睡眠后有活动的非睡眠会话数；`0` 表示总是运行 |
| `injectMaxBytes` | `16384` | 笔记块内联携带的字节上限，包含每条笔记的标题与路径 |
| `maxSourceBytes` | `1048576` | 单次读取笔记返回的字节上限，也是单次写入笔记接受的字节上限 |
| `inspectMaxBytes` | `4194304` | 一次注入过程为区分文本与二进制笔记而读取的笔记内容上限 |
| `inspectMaxEntries` | `1024` | 一次注入过程为列出笔记树而检查的目录项上限 |
| `presetId` | `'sleep'` | 睡眠会话挂载的 preset；必须与 `preset-sleep` 行一致 |
| `reasoningEffort` | `'max'` | 路由模型声明时，为睡眠会话模型选择的推理强度 |

配置值违反契约时，插件会在加载时以带码的诊断停止。空 `dir`、不是 `HH:mm` 的 `time`，以及不是 IANA 时区的 `timeZone` 都会这样失败，因此不会有运行按运行时无法使用的值启动。

<a id="the-sleep-command"></a>
## `/sleep` 命令

profile 组合了命令注册表时，`/sleep` 响应以下三种调用。

| 调用 | 作用 |
|---|---|
| `/sleep` | 启动一次手动运行，并以运行它的会话作答 |
| `/sleep now` | 同上 |
| `/sleep status` | 报告日程、上次结果、下一个时隙、正在进行的运行，以及笔记目录 |

手动运行忽略 `enabled` 和 `minSessions`，因为是用户主动要求的。`/sleep` 在运行有了会话后立即作答，因此耗时数分钟的复盘不会占住输入框。`/sleep status` 报告该运行如何结束。

<a id="where-the-notes-live"></a>
## 笔记的位置

`dir` 字段指定笔记目录。随附 patch 把它设为 `dshHomePath('sleep')`，即 `$DSH_HOME/sleep`；未设置 `DSH_HOME` 时是 `~/.dsh/sleep`。运行时在激活时以仅用户可访问的权限（`0700`）创建该目录，它创建的每个子目录也使用同一模式。

笔记是该目录下的纯文本文件。睡眠会话通过 7 个工具写入它们：`sleep_list_sessions`、`sleep_read_session`、`sleep_notes_list`、`sleep_notes_read`、`sleep_notes_write`、`sleep_notes_move` 和 `sleep_notes_delete`。工作会话用自己的 `read` 工具读取同一批文件，因为提醒块会按绝对路径列出没有装进内联预算的每条笔记。

笔记属于 DSH home，不属于某个工作区。每个工作区读取同一批笔记。

<a id="known-limitations"></a>
## 已知限制

- **不随 DSH 一起分发**——该 bundle 既不在 `OPTIONAL_BUNDLES` 中，也不在插件管理器的 Official 组中，并且没有声明官方图标。请按上文从本仓库安装。
- **每个 Host 同一时刻只运行一次**——在另一次运行占用槽时触发的计划时隙会被拒绝，该本地日期在 Host 重启前视为已决定。共享同一个 `DSH_HOME` 的两个 Host 各自拥有运行槽、定时器和决定日期，却共享笔记目录：它们可能为同一天各启动一次运行、互相覆盖笔记并保存互相冲突的结果。协调它们需要本包并不拥有的跨进程锁。
- **派生自 base 的 profile 中的全局 agent instructions**——挂成宿主行的 instructions 加载器会应用到每个 agent，因此仅靠 preset 无法把 `AGENTS.md` 挡在睡眠会话之外。运行时的 instructions 守卫会移除该加载器贡献的每条消息，无论消息由谁组合；它还读取该 agent 组合的 preset，因此从选择器启动的会话同样被覆盖。会话的笔记块不受影响：守卫只丢弃 instructions 加载器产生的消息。
- **笔记路径仍可能输掉替换竞争**——规范路径在每次文件系统调用之前会再次核对。Node 没有提供相对描述符的操作，因此在最后一次核对与调用之间的间隙里把祖先目录换成符号链接，仍可能让调用被重定向；平台或文件系统不报告文件标识时完全无法发现该重定向。笔记目录以仅用户可访问的权限（`0700`）创建，这限制了能实施该替换的人。
- **只有全局笔记**——笔记目录属于 DSH home 而不是某个工作区。项目级层次尚未实现。
- **没有设置页**——时隙、时区和字节上限都是 profile 配置。`/sleep status` 报告当前值；修改它们需要编辑 `cordis.patch.yml`。
- **睡眠会话无法读取项目文件**——该 preset 不挂载任何文件系统或 shell 工具，其隔离行遮蔽全局工具。运行时的 7 个工具只读取会话转写和笔记目录。
- **睡眠 preset 可选择**——每个已注册的 preset 都会出现在 agent preset 选择器中。以 `Sleep` 启动的会话有意只得到复盘 persona、隔离和别的什么都没有：没有项目工具、没有睡眠工具、没有 instructions，也没有笔记块。7 个工具由运行时在它自己创建的会话中注册。
- **`lastSleepAt` 需要已完成且未取消的轮次**——被中止、失败、触及输出上限或被取消的睡眠会让边界停在原处，因此下次尝试重读同一批工作会话。

<a id="links"></a>
## 链接

- 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- DSH 文档：[docs](https://github.com/deepseek-ai/deepseek-harness/tree/main/docs)
- 本插件的问题反馈：[AngryRaccoon77/dsh-electric-sheep/issues](https://github.com/AngryRaccoon77/dsh-electric-sheep/issues)
- 许可证：[MIT](LICENSE)
