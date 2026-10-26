# Surowan — 20261026 内置多服务商网络搜索

## 背景

需求来自 issue #35，设计稿是 `doc/design/20261026-web-search.md`。目标：让模型在不知道具体 URL 时先搜索，拿到标题、URL 与摘要，再按需用 `web_fetch` 读正文。搜索不抓正文，减少单次上下文与成本。

必须满足的约束（按设计稿）：

- 沿用内部能力的调用、校验与审计方式（走 `execute`，不走直接暴露的 Tool）。
- 支持 Tavily、Brave、Exa、Firecrawl、DeepSeek、SearXNG、You.com，可配置多个引擎。
- 每家服务商作为独立插件，依赖网络搜索插件；插件框架要支持依赖声明与扩展点。
- 每个引擎都有 LLM 可见的备注，说明它适合搜什么。
- 面板可实时改配置；未配置、关闭或全部禁用时能力与 Skill 索引都不可见。
- 按请求冻结配置；禁用部分引擎时运行中的 Invocation 收到 steer；禁用全部时立刻停止运行中的 Invocation。

## 主要变更

### 1. 插件框架：依赖、扩展点、条件可用

`src/plugins/plugin.ts` 原先只有 `definePlugin`/`loadPlugins`，只支持 id 唯一性、hosts 与 contextInjectors。新增：

- `defineExtensionPoint<T>(name, identify?)` / `contribute(point, value)`：带类型的扩展契约；`identify` 让 `loadPlugins` 对同一标识的重复贡献直接报错（服务商标识就靠它保证唯一）。
- `AgentPlugin.dependencies`：被依赖的插件必须以更靠前的位置出现，否则报错（自依赖、未知依赖、顺序倒置、成环都覆盖）。
- `AgentPlugin.extensionPoints` / `extensions`：只能向自己的直接依赖发布的扩展点贡献；扩展点名唯一，且必须形如 `<owner>.<contract>`。
- `AgentPlugin.available(config, extensions)`：插件级可用性。不可用时能力与 Skill 一起消失，避免两处各写一遍判断。
- `InvocationScope` 新增 `readConfig()`（热更新后的当前配置）、`secrets`、`steer()`、`extensions()`，`LoadedPlugins` 新增 `skillAvailable` 与 `extensions`。

类型上踩过一个坑：`ExtensionPoint<T>` 里的 `identify` 是逆变的，直接写 `ExtensionPoint<unknown>` 会让所有具体扩展点都不兼容。于是拆出擦除版 `ExtensionPointLike` / `ExtensionContributionLike`（`identify: (value: never) => string`）供 `AgentPlugin` 使用，具体类型只出现在 `contribute` 与读取侧。

### 2. 服务商规格与七个插件

`src/platform/web-search.ts` 是共享规则与纯函数（目录、默认值、校验、URL 过滤），不 import 任何插件模块 —— 配置校验器可以在没有插件上下文时退回到内置目录。`src/plugins/web-search/extension.ts` 定义 `WEB_SEARCH_PROVIDERS` 扩展点与 `SearchProviderSpec`（`rule` + `build` + `parse`）。

七个服务商各一个插件文件，只做三件事：请求构造、响应解析、规格引用。共用读取逻辑（多形状字段名）放在 `providers/shared.ts`。

`builtin.ts` 的顺序就是加载顺序：`web-search` 在最前，七个服务商随后。

### 3. `web_search` 能力

- 输入 `{ action?, query?, engine?, count? }`；`action: "list"` 返回当前引擎与备注，用于配置在运行中变化后刷新。
- 每次调用读一次当前配置，冻结引擎、服务商、地址、密钥、条数、超时；查询按服务商上限裁剪（按字符，不切碎代理对）。
- 引擎选择三态：选到 / 存在但已禁用 / 不存在。禁用态通过 `scope.steer()` 注入提醒（要求重新读取引擎列表），不存在只报错不 steer。
- 审计 `tool_calls` 行在引擎与密钥确定后才开，因此记录的是**实际使用**的引擎与服务商；早期失败写 `reject` 行。
- 结果清洗：标题与摘要清控制字符与换行（防止伪造结果行），URL 只接受绝对 HTTP(S)、去 fragment 与凭据；单条摘要 600 字符、整段 24 KiB、响应 256 KiB、重定向一律拒绝、失败响应体不读。
- 错误分类：401/403（无密钥服务商给「检查 JSON 输出」提示）、402/432/433、429、5xx、其余 4xx、重定向、响应过大、超时、Invocation 到期、密钥无法解析、响应无法解析、网络失败。

### 4. 配置与校验四条路径

`WebSearchSectionSchema` 只校验形状；跨字段规则在 `validateWebSearchSection`：服务商必须已注册、必需/禁止的密钥、SearXNG 必填地址、地址合法性、结果条数边界、URL 正则编译。

已注册服务商集合从插件来，因此 `loadConfig`、`validateFileConfig`、`validateSemantics` 都接受可选的 `searchProviders`；`ConfigReloader` 保存一个集合，读文件、写文件、apply 候选校验共用，`serve` 启动前先用 `loadPlugins(BUILTIN_PLUGINS)` 取得集合。

`web_search` 整段加入热更新白名单（`web_search`、`web_search.*`）。

### 5. 可用性与运行中行为

- `skillAvailable` 与 `capabilities` 都用同一个 `available()`，所以 Skill 索引与能力永远同步。
- 能力装配时按当前配置判定；`scope.readConfig()` 让每次调用仍能看到最新配置（运行中的 Invocation 保留旧 Tool 集合，但调用本身会返回 `search_disabled` 或 `engine_disabled`）。
- `serve-run.ts` 的 `onPublished` 比较前后可用性：从可用变不可用时 `abortInvocations` 所有 running Invocation（原因 `web_search_disabled`）。逻辑抽到 `runtime/web-search-availability.ts` 以便单测。
- steer 通道：`CapabilityToolFactory` 新增可选的第四个参数 `{ steer }`；`run-agent.ts` 先建 sink，能力构造时注入，agent 建好后绑定 `agent.steer(...)`。

### 6. 面板

- 新增 `GET/PUT /api/search/config`（`ingress/admin/routes/search.ts` + `ingress/admin/search.ts`）。读端点只给 `key_configured` 布尔值；写端点支持新密钥（写 key jar）、`keep_api_key` 保留原引用、`key_source` 复用 DeepSeek 模型 Provider 密钥，删除引擎后无引用条目由 `writeConfigEdits` 自然回收。
- 新增页面 `/search-settings`：总开关、引擎增删改（服务商、ID、地址、条数、超时、备注、密钥来源）、URL 正则列表与测试框（粘贴 URL 高亮命中，不发请求）。保存前本地校验与服务端规则一致。
- 中英文案补齐；侧栏 Manage 新增 Web search 入口。

### 7. 文档

- `agent-doc/`：架构（插件契约、`web_search` 信任边界）、配置（新增 `web_search` 章节与热更新行）、Agent 流程（`web_search` 一节）、面板（端点、页面、E2E 覆盖）、验证（`test/web-search/` 覆盖清单）。
- 用户文档：新增 `guides/web-search.md`，并更新 `guides/extensions.md`、`configure/config-file.md`、`reference/config.md`、`examples/config.example.jsonc`（注释形式的示例，不改变默认行为）。

## 验证

- `pnpm run check` 通过（tsc、cli、admin-next、docs）。
- `test/web-search/` 六个文件 62 个用例：工具行为与服务商解析、配置校验、插件契约、可用性中止、面板读写。
- `test/plugins.test.ts` 增加依赖、顺序、自依赖、成环、扩展点唯一性、未声明贡献与重复标识的用例。
- `apps/admin-next/e2e/22-search-settings.e2e.ts`：面板不回显密钥、保存开关、添加引擎并保存新密钥、非法正则阻止保存。全量 E2E 189 通过。
- 全量 `pnpm test` 通过。

## 已知限制

- 服务商的真实端点只在单测里用假响应验证；没有对真实 API 做计费调用。
- DeepSeek 的搜索端点按其公开形态实现，实际服务若使用不同路径，需要部署者用 `endpoint` 覆盖。
- SearXNG 依赖实例启用 JSON 输出；未启用时返回 403，工具会提示检查 JSON 输出。