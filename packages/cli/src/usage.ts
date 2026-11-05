export const USAGE = `surowan-utils - Surowan Admin Panel 与 Admin API 工具客户端

用法:
  surowan-utils login --endpoint <url> (--api-key <key> | --api-key-stdin) [--json]
  surowan-utils doctor [--json]
  surowan-utils commands [--json]
  surowan-utils models list [--json]
  surowan-utils config show [--source active|file] [--json]
  surowan-utils prompt get global [--source active|file] [--json]
  surowan-utils prompt get group --chat <id> [--source active|file] [--json]
  surowan-utils invocation list [--limit N] [--cursor ID] [--state STATE] [--chat ID] [--model ID] [--search <keyword>] [--at <time>] [--from <time>] [--to <time>] [--json]
  surowan-utils invocation get <id> [--json]
  surowan-utils invocation prompts <id> [--json]
  surowan-utils invocation preflight <id> [--before-send <send-id>] [--provider <alias> --model <id>] [--thinking-level <level>] [--json]
  surowan-utils invocation media <id> [--variant original|preview] [--json]
  surowan-utils invocation replay <id> [--before-send <send-id> --confirm-paid] [--provider <alias> --model <id>] [--thinking-level <level>] [--global-prompt <file|->] [--group-prompt <file|->] [--json]
  surowan-utils <panel command> [参数] [--set k=v]... [--json]

面板命令（与 Admin Panel 等价；surowan-utils commands 列出全部）:
  session cancel
  config apply|status, model set, vision set, thinking-level set, restart, wake
  provider list|create|update|delete|discover|lookup-metadata|health-check
  model add|update|delete, provider-preset list
  chat list|create|update|delete|participation|proactive-reply|group-memory
  prompt versions|version show|diff|save|restore|cancel-running
  dictionary list|chats|create|update|delete|settings|import|export|merge
  tool-model set, search show|update
  image status|config|model|prompt|asset|generation ...
  memo list|chats|create|update|delete|blob content
  group-memory list|messages|update|delete
  telegram show|token, warning list|read|clear, bot-admin list|add|remove
  developer show|update|clear-payloads, harness show|update
  room list|create|show|messages|send|participant|hold|release|asset|capabilities|invocations
  overview, usage, context list|show, message list|show, sticker-set list, sticker list, alarm list|cancel

全局选项:
  --endpoint <url>    Admin Panel 基地址（覆盖环境变量与登录文件）；明文 http 仅允许 loopback
  --api-key <key>     API key（覆盖 SUROWAN_API_KEY 与登录文件）；权限由该 key 的模式决定
  --api-key-stdin     仅 login：读取标准输入至 EOF，接受单行 API key，不回显
  --source <active|file>  config show / prompt get：读取运行时生效配置或配置文件（默认 active）
  --variant <original|preview>  仅 invocation media：下载原始文件或预览（默认 original）
  --provider <alias> --model <id>  仅 invocation preflight/replay：临时选用已启用模型，两项必须成对
  --thinking-level <level>  仅 invocation preflight/replay：临时思考级别（off|minimal|low|medium|high|xhigh|max）
  --global-prompt <file|->  仅 invocation replay：替换 global prompt；- 表示 stdin
  --group-prompt <file|->   仅 invocation replay：替换 group prompt（允许空）；- 表示 stdin
  --search <keyword>  仅 invocation list：按字面关键词过滤消息（1-100 字符，不解释通配符）
  --model <id>        仅 invocation list：按 agent 模型 ID 精确过滤（1-256 字符，与 --provider/--thinking-level 无关）
  --at <time>         仅 invocation list：筛选该时刻的 Invocation，与 --from/--to 互斥
  --from <time> / --to <time>  仅 invocation list：筛选时间范围
  --before-send <send-id>  仅 invocation preflight/replay：从该 telegram_sends 内部 id（已成功发送）之前开始回放
  --confirm-paid      仅 invocation replay：切片重放（--before-send）会真实调用模型并计费，需显式确认，否则在发请求前拒绝
  --timeout-ms <ms>   请求/每次输入超时；默认非 replay 命令 30000，replay 300000，不自动重试
  --json              输出稳定 JSON
  -h, --help          显示本帮助

面板命令通用选项:
  --set key=value        设置 body 字符串字段（支持 a.b 嵌套，可重复）
  --set-json key=<json>  设置 body 任意 JSON 字段（可重复）
  --body <json>          整个 body 文档
  --file <path>          从文件读取整个 body 文档（JSON）
  --if-match <revision>  显式指定 If-Match；省略时写入命令会先读取当前 revision
  --yes                  确认破坏性或计费操作（面板命令在缺少它时于发请求前拒绝）
  --dry-run              只打印将要发送的请求，不发送
  --output <path>        把二进制或文本响应写入文件（导出、图片）
  --timeout-ms <ms>      请求/每次输入超时；默认 30000，replay 300000，不自动重试

凭据与授权:
  登录文件 ~/.config/surowan-utils/credentials.json（未加密）保存 endpoint 与 API key。
  只读、读+改、读+耗、全部四种模式由 Admin Panel 创建/修改；账号与密钥管理不经过 CLI。
  doctor 用一次只读请求验证连接与鉴权，不调用模型。

其他:
  时间格式 YYYY-MM-DD[ |T]HH:mm[:ss[.1-3位]][Z|±HH:mm]；日期必须有效。不带 Z/offset 时由服务端按 --chat 对应群或全局时区解释。
  config show 与 prompt get 只读取脱敏后的配置与 prompt，不修改服务端状态。
  models list 只列当前生效、已注册且接受文本的模型及支持的 thinking_levels，不探测上游或调用模型。
  临时模型和思考级别不写配置；指定模型但未指定 thinking-level 时用目标模型支持的最低级别。预检与 POST 使用同一模型选择，未覆盖时继承当前群配置。
  invocation media 顺序下载到 mkdtemp 新建目录，stdout 输出 manifest，每个文件不超过 20MiB、总计不超过 100MiB 且至多 32 项。
  invocation list 默认保持旧输出；服务端返回 matched_messages 时人类可读输出会追加命中摘要。
  invocation replay 先请求 replay-preflight；不可重放或不允许 prompt 覆盖时不发送 replay 请求；--before-send 只选择回放边界，不属于 prompt 覆盖。切片重放必须显式给出 --confirm-paid：缺失时在读取 stdin 与发送任何请求前以 confirm_paid_required（退出码 2）拒绝；未切片的 replay 无需该 flag。
  退出码: 0 成功；1 请求、replay、超时或凭据文件失败；2 参数/输入/凭据不合法。错误以 JSON 写到 stderr。
`;
