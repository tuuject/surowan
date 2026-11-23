---
title: 配置生命周期
description: 缺省与 null、全局到 Chat 的继承、文件与运行快照的区别、显式应用、热应用与重启边界，以及废弃字段的告警。
---

# 配置生命周期

配置文件只是「想要的状态」。进程启动时读一次，之后只有在显式应用时才会重新读。每次应用都会把文件里的变更分成三类：能立刻生效的、必须重启才生效的、以及 `serve` 根本不读的。这一页说明这套规则，字段本身的类型与默认值见[配置字段参考](fields.md)。

## 三个层次

| 层次 | 含义 |
| --- | --- |
| 文件 | 磁盘上的 `config.jsonc` 与它引用的 Prompt 文件、`key.json`。面板与手工编辑改的都是这里。 |
| 已生效配置（运行快照） | 当前进程正在用的那份配置。它与文件可以不同：只要还有待重启字段，或文件改了没应用，两者就不一致。 |
| 已保存但待重启 | 文件里已经改了，但只有重启才会进入运行快照的字段。 |

面板「设置」页把这三层摆在一起：**配置版本**（每应用一次加一）、**生效哈希**、**文件哈希**，以及待重启与最近错误。两个哈希相等就是「与文件一致」，否则是「文件有改动」。

配置哈希 = 配置文件原始字节 + 所有 Prompt 文件内容的 SHA-256。`check-config` 打印的 `config_hash`、`serve_started` 日志里的 `config_hash` 与面板显示的是同一个值，可以直接比对。

## 缺省与 null

- 可选段整段省略就是「没配置」：`telegram` 省略即停用 Telegram，`vision` 省略即没有视觉模型，`image` 省略即图片生成禁用。
- `agent` 与 `vision` 除了省略，还可以写 `null`，与省略等价。`agent: {}` 也合法，其余字段都走默认值，但模型三元组（`provider`/`model`/`thinking_level`）仍不完整，于是不会发起任何 Invocation。
- 段存在时，段内必填字段仍然必填。比如写了 `telegram` 就必须写 `process_bot_messages`、`bucket_window_seconds` 和 `chats`，`token` 是例外，可以省略。
- 省略字段不等于没有行为，大多数字段有默认值，见下节。

## 默认值从哪来

默认值有两个来源，生成页把它们分开标注：

- **Schema 声明默认**：Schema 节点上的 `default`，目前只出现在少数布尔字段上（例如 `developer.record_model_payloads`）。
- **运行时默认**：省略字段时解析代码实际使用的值，来自 `AGENT_DEFAULTS`、`VISION_DEFAULTS`、`TELEGRAM_DEFAULTS`、`DECISION_GATE_DEFAULTS`、`PROACTIVE_REPLY_DEFAULTS` 等常量。是否生效取决于解析范围：`agent` 与 `vision` 段由解析函数逐字段补齐，所以运行时消费者读到的永远是具体值。`telegram` 段内的必填字段（如 `bucket_window_seconds`）只在整段缺失时才有默认值，段存在时没有「省略」这一说。

没有一个统一默认值的字段（例如 `vision.thinking_level` 由所选模型决定，`tool_model` 省略时继承全局 Agent）不会在生成页里写默认值，规则写在对应的人工说明页。

## 继承：全局 → Chat → Topic

| 配置 | 继承规则 |
| --- | --- |
| `agent.provider` / `model` / `thinking_level` | 全局是默认值，`telegram.chats[]` 可逐项覆盖；`provider` 与 `model` 必须成对写，`thinking_level` 可单独写。Topic 使用所属 Chat 的设置。 |
| `telegram.participation` | 时段整体替换（Chat 写了 `active_windows` 就用 Chat 的），关键词追加到全局列表，注意力窗口长度按 Chat 覆盖全局。 |
| `telegram.proactive_reply` | 逐字段继承：Chat 只写它要改的字段。 |
| `telegram.decision_gate` | 六个行为字段（`enabled`、`mode`、`threshold`、`history_messages`、`pending_messages`、`instructions`）逐字段继承；`model`、`base_url`、`api_key`、`timeout_ms` 是全局字段，不能写在 Chat 上。 |
| `dictionary.injection_mode` | Chat 的 `dictionary_injection_mode` 覆盖全局，省略即继承。 |
| `telegram.chats[].group_memory` | 只存在于 Chat 级，没有全局默认。 |
| `telegram.chats[].mcp` | 只存在于 Chat 级：只能收窄某个已配置 Server 的工具集合，不能覆盖连接设置。 |
| `tool_model` | 省略时继承**全局** Agent 三元组，不跟任何 Chat 覆盖，见[Tool Model 配置](tool-model.md)。 |

私聊（正数 Chat ID）不受 `participation`、`proactive_reply`、`decision_gate` 影响，在这三类字段上显式配置会被 `check-config` 拒绝。

## 显式应用：没有文件监视器

手改文件本身不产生任何效果。把它交给运行中的进程有三种方式：

1. 面板「设置」页的「应用配置文件」按钮（对应 `POST /api/config/apply`）。
2. 面板里任何写配置的保存操作：Providers、Models、Prompts、Chats、Harness tuning、Telegram 设置等页面都是「先写文件，再应用」，只写数据库的设置（记忆、辞典、闹钟等）与配置无关。
3. Telegram 命令：`/model`、`/effort`、`/ignoreme`、`/unignoreme`、`/allowlist` 写入文件后同样会应用一次。

启动时读一次文件，`serve` 之后不会再看磁盘。所以「保存成功」与「已生效」是两件事，面板用生效哈希与文件哈希区分它们。

## 部分应用与待重启

一次应用是「文件里的热字段 + 运行快照里仍生效的重启字段」拼成的候选配置：

- 热字段立刻生效，并出现在结果的 `applied` 列表里。
- 重启字段保留运行快照里的旧值，写进 `restartRequired` 列表，面板显示「需要重启」，重启后才会一起生效。
- `paths.backups` 与 `retention.backup_copies` 属于第三类，`serve` 不读它们，下一次 `backup` 才用新值，面板显示「不影响运行中的服务」。
- 待重启状态不会因为之后只改热字段而清空。把待重启字段改回原值再应用，待重启列表才会消失。

候选配置会再校验一次。文件本身合法、但与仍在运行的重启字段组合起来不合法时，应用失败并返回 `candidate_invalid`，错误里列出待重启路径，文件留在磁盘上，重启后与那些字段一起生效。

每次成功应用都写一条 `config_reloaded` 日志，带 `generation`、`active_hash`、`file_hash`、`applied`、`restart_required`、`outside_serve`，失败写 `config_reload_failed`，带错误码与脱敏后的错误信息。失败码有 `config_invalid`（文件本身不合法）、`candidate_invalid`（与待重启字段冲突）、`model_unusable`（模型缺失或不可用）、`secret_unresolved`（新增或连接字段变化的 Provider 无法解析 SecretRef）、`publish_incomplete`（配置已发布，但发布钩子失败，再应用一次会重试）。

## 行为矩阵

下表是代表性的变更。`hot` 表示下一次显式应用就生效，`restart` 表示写进文件但要重启，`outside_serve` 表示只有 `backup` 读。`test/docs/lifecycle.test.ts` 用真实的配置差异计算逐行校验这些结论。

| 变更 | 生效方式 | 说明 |
| --- | --- | --- |
| 新增 `telegram.chats[]` 条目 | hot | 入库白名单、参与策略与 Chat 配置解析都读发布后的配置；新 Chat 没有历史需要保护。 |
| 删除 `telegram.chats[]` 条目 | hot | 发布时停止该 Chat 的运行中 Invocation 与长任务（`telegram_chat_removed`），之后的 Update 被拒绝。**不删除**已存数据，删数据是面板/API 的删除操作。 |
| `telegram.chats[].topic_ids` | restart | Topic 范围变更需要重启；未重启时新 Topic 的消息仍按旧范围处理。 |
| `telegram.chats[].timezone` | restart | 时段按 Chat 时区解析，时区本身要重启才换。 |
| `telegram.chats[].provider` / `model` / `thinking_level` | hot | 按群模型覆盖；下一次 Invocation 用新值。 |
| `telegram.chats[].instructions_file`（路径或文件内容） | hot | 内容变化会改变稳定系统提示的哈希，该 Conversation 的 Context 在下次运行时重建。 |
| `telegram.chats[].ignored_user_ids` | hot | 下一条实时或追赶的 Update 使用新名单，不追溯删除已有消息与 Context。 |
| `telegram.chats[].participation` / `proactive_reply` / `decision_gate` | hot | 每次判定/抽样/决策都从已发布配置重新解析。 |
| `telegram.chats[].group_memory` | hot | 下一次 sleeping 扫描使用新值；开关状态变化会中止该 Chat 的运行并重建 Context。 |
| `telegram.chats[].mcp` | hot | 绑定收窄会停跑该 Chat、重建 Context 再续跑；纯增宽不打断运行。 |
| `telegram.chats[].dictionary_injection_mode` | hot | 下一次 Invocation 生效。 |
| `agent.system_prompt_file`（路径或文件内容） | hot | 影响所有 Conversation 的稳定系统提示，相关 Context 在下次运行时重建。 |
| 其余 `agent.*` | hot | 下一次 Invocation 使用新值；`daily_budget.max_tokens` 调低后下一次模型调用即被拦截。 |
| `providers.*` | hot | 连接字段变化的 Provider 重新解析 SecretRef；只改模型列表则沿用已有连接。文件里引用的模型必须仍然有效。 |
| `mcp.servers` | hot | 后台建连，失败发布为 `degraded` 并按退避重试；受影响的 Chat 停跑、重建 Context 后续跑。 |
| `telegram.decision_gate` 与 `telegram.chats[].decision_gate` | hot | 每次决策重新解析设置与凭据引用，改阈值、换模型、换地址都不需要重启。 |
| `telegram.bucket_window_seconds` / `bucket_max_seconds` / `bucket_bump_seconds` | hot | 只作用于之后新开的批次，正在收集的批次按开桶时的节拍走完。 |
| `telegram.sticker_sets` | hot | 发布时对账存储；增删集合会中止运行中的 Telegram Invocation，只改 `alias`/`note` 不中止。 |
| `telegram.admins` | hot | 下一次命令执行就用新名单。 |
| `telegram.token` | hot | 连接管理器跟随解析出的 Token，轮换或清空都不需要重启。 |
| `telegram.process_bot_messages` | restart | 是否处理其他 Bot 的消息，要重启才换。 |
| `models_dev` / `models_dev.api_url` | hot | 面板下一次查询模型元数据时使用新地址（每个地址独立缓存一小时）。 |
| `retention.online_days` | hot | `serve` 的周期清理（启动时与每 24 小时）在每次运行时读取当前窗口。 |
| `retention.warning_read_days` | restart | 警告清理在进程启动时读取。 |
| `retention.backup_copies`、`paths.backups` | outside_serve | 只有 `backup` 与迁移前备份轮换读它们。 |
| `vision.provider` / `model` / `thinking_level` / `max_output_tokens` | hot | 下一次图片分析使用新模型与级别。 |
| `vision.max_concurrency` / `prompt_version` / `daily_budget` | restart | 并发信号量、缓存版本与 Sticker 索引预算在服务构造时读取。 |
| `image` 整段 | hot | 每次应用重新解析 image SecretRef 并原子发布新的图片快照；段被剥离或删除等于禁用。 |
| `dictionary`、`tool_model`、`web_search`、`developer` | hot | 下一次 Invocation / 辅助调用 / 搜索设置与开关读取新值。 |
| `web_fetch` | restart | 网页读取的地址与格式开关在能力构造时读取。 |
| `admin.*` | restart | 监听地址、端口、静态目录、`public_url` 与 Session 时长都要重启。 |
| `data_dir`、`timezone`、`paths.database`、`paths.media_cache` | restart | 进程级路径与默认时区。 |

表格之外还有一类变更不经过字段差异：**Keychain 轮换**。`key.json` 里的条目被原地替换时配置文件一字未动，应用仍会比较每个被引用条目的值摘要（内存里的 SHA-256，不落盘、不进日志），发现变化就重建使用它的 Provider 连接、按热路径重连对应的 MCP Server、重新读取 Telegram Token、重新准备图片快照。因此轮换密钥也是一次显式应用的事，不需要重启，见[密钥与路径](secrets.md)。

## 废弃字段

三个兼容字段（`agent.memory_ttl_warning_days`、`agent.send_empty_text_fallback_enabled`、`vision.background_sticker_concurrency`）与 `mcp.servers[].required` 仍被 Schema 接受，但运行时完全不读：

- 加载时会有一条警告，`check-config` 的 `warnings` 与 `serve` 的 `config_warnings` 日志都会列出字段路径。
- 面板「警告」页把它们作为常态警告持续显示，直到从文件里删除。
- 增删改这些字段按热应用处理，不需要重启，唯一变化是警告随之出现或消失。

完整清单与替代写法见[配置字段参考的废弃字段表](fields.md)。
