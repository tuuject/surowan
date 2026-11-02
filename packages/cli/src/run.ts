import process from 'node:process';
import { parseCli, parseTimeout, resolveCli } from './args/index.ts';
import type { Command, FirstClassCommand, ParsedCli } from './args/types.ts';
import { AdminClient, isRecord, parseEndpoint } from './client.ts';
import { type CliIo, executeCommand } from './commands.ts';
import { clearCredentials, credentialsPath, readCredentials, writeCredentials } from './credentials.ts';
import { CliError, usageError } from './errors.ts';
import { promptLoginField, readLoginKey } from './login.ts';
import { panelLogin } from './panel/login.ts';
import { runPanelCommand } from './panel/run.ts';
import { PANEL_SPECS } from './panel/specs/index.ts';

export const USAGE = `surowan-utils - Surowan Admin Panel 与 Admin API 工具客户端

用法:
  surowan-utils login [--endpoint <url>] [--json]
  surowan-utils login --username <name> [--password-stdin | --password <pw>] [--endpoint <url>] [--json]
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
  session show|cancel, account update, passkey list|delete, password delete
  api-key list|create|revoke
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
  --api-key <key>     API key（覆盖 SUROWAN_API_KEY 与登录文件）；只授权只读检查与 Invocation 重放
  --session <token>   面板 Session Token（覆盖 SUROWAN_SESSION 与登录文件）；与面板浏览器同权限
  --api-key-stdin     仅 login：读取标准输入至 EOF，接受单行 API key，不回显
  --username <name>   仅 login：改用面板账号登录，换取 Session Token（可用 --password-stdin）
  --password-stdin    仅 login：从标准输入读取面板密码，不回显
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
  登录文件 ~/.config/surowan-utils/credentials.json（未加密）保存 endpoint 与一份凭据：
  面板登录写入 Session Token，--api-key / SUROWAN_API_KEY 写入 API key。
  API key 只能读检查视图与重放 Invocation；面板命令需要面板 Session。
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

export interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly io?: CliIo;
  readonly homeDir?: string;
}

export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo();
  const secrets: Array<string | undefined> = [env.SUROWAN_API_KEY, ...argumentKeys(argv)];
  try {
    const parsed = parseCli(argv);
    if (parsed.help) {
      io.stdout(`${USAGE}\n`);
      return 0;
    }
    const path = credentialsPath(options.homeDir);
    if (parsed.command?.kind === 'login') {
      return await login(parsed, env, io, path, secrets);
    }
    if (parsed.command?.kind === 'commands-list') {
      io.stdout(renderCommands(parsed.json));
      return 0;
    }
    const explicitEndpoint = parsed.endpointRaw ?? env.SUROWAN_ENDPOINT;
    const explicitKey = parsed.apiKeyRaw ?? env.SUROWAN_API_KEY ?? env.SUROWAN_SESSION;
    const saved = explicitEndpoint !== undefined && explicitKey !== undefined ? undefined : await readCredentials(path);
    secrets.push(saved?.apiKey, saved?.session);
    const resolved = resolveCli(parsed, env, saved);
    secrets.push(resolved.apiKey, resolved.session);
    const client = new AdminClient({
      baseUrl: resolved.endpoint,
      ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
      ...(resolved.session === undefined ? {} : { session: resolved.session }),
      defaultTimeoutMs: resolved.timeoutMs,
    });
    // Everything except `invocation list` writes JSON documents, so string
    // tokens can be redacted without touching the document structure.
    const output = redactingIo(io, secrets, resolved.json || resolved.command.kind !== 'list');
    if (resolved.command.kind === 'doctor') {
      const raw = await client.get('api/invocations', new URLSearchParams({ limit: '1' }));
      if (
        !isRecord(raw) ||
        !Array.isArray(raw.items) ||
        (raw.next_cursor !== null && typeof raw.next_cursor !== 'string')
      ) {
        throw new CliError('invalid_response', 'doctor expected an invocation list response from the Admin API');
      }
      const result = {
        status: 'ok',
        endpoint: resolved.endpoint.href,
        credential: client.credentialKind,
        credential_sources: resolved.credentialSources,
      };
      output.stdout(
        resolved.json
          ? `${JSON.stringify(result)}\n`
          : `Login is valid; Admin API connection and authentication succeeded (${resolved.endpoint.href}).\n`,
      );
      return 0;
    }
    if (resolved.command.kind === 'login') {
      throw usageError('invalid_command', 'login cannot execute an invocation request');
    }
    if (resolved.command.kind === 'panel') {
      // A token from --session or SUROWAN_SESSION is not the stored one, and
      // the file may hold another endpoint's credential: rotating or ending
      // that token must leave the file alone.
      const ownsStoredCredential = resolved.credentialSources.credential === 'file';
      return await runPanelCommand(
        resolved.command,
        {
          json: resolved.json,
          io: output,
          timeoutMs: resolved.timeoutMs,
          redact: (text) => redactSecrets(text, secrets),
        },
        client,
        {
          currentToken: resolved.session,
          save: async (token) => {
            if (!ownsStoredCredential) {
              // The new token cannot be printed (output is redacted) and the
              // supplied one is already revoked, so the caller must log in.
              output.stderr(
                `${JSON.stringify({
                  warning: 'session_not_stored',
                  message:
                    'the server rotated the session; the supplied token is revoked and the new one was not stored; run surowan-utils login',
                })}\n`,
              );
              return;
            }
            // The endpoint must be the one that issued the token; `resolved`
            // already normalized and validated it.
            await writeCredentials(path, { endpoint: resolved.endpoint.href, session: token });
          },
          clear: async () => {
            if (ownsStoredCredential) {
              await clearCredentials(path);
            }
          },
        },
      );
    }
    return await executeCommand(
      assertFirstClass(resolved.command),
      {
        json: resolved.json,
        io: output,
        timeoutMs: resolved.timeoutMs,
        redact: (text) => redactSecrets(text, secrets),
      },
      client,
    );
  } catch (error) {
    return reportError(error, io, secrets);
  }
}

async function login(
  parsed: ParsedCli,
  env: Record<string, string | undefined>,
  io: CliIo,
  path: string,
  secrets: Array<string | undefined>,
): Promise<number> {
  if (parsed.command?.kind !== 'login') {
    throw usageError('invalid_command', 'expected login');
  }
  const timeoutMs = parseTimeout(parsed.timeoutRaw, false);
  let endpointRaw = parsed.endpointRaw ?? env.SUROWAN_ENDPOINT;
  if (endpointRaw === undefined) {
    endpointRaw = await promptLoginField('Admin API endpoint: ', false, timeoutMs);
  }
  const endpoint = parseEndpoint(endpointRaw).href;
  if (parsed.command.username !== undefined) {
    // The credentials file holds exactly one kind; mixing them would hide
    // which surface the operator just authorized.
    if (parsed.apiKeyRaw !== undefined || env.SUROWAN_API_KEY !== undefined) {
      throw usageError(
        'conflicting_credentials',
        'a panel login cannot be combined with an API key; the credentials file holds one credential',
      );
    }
    return await panelLoginFlow(parsed, endpoint, io, path, timeoutMs, secrets);
  }
  let apiKey = parsed.apiKeyRaw ?? env.SUROWAN_API_KEY;
  if (parsed.command.apiKeyStdin && apiKey !== undefined) {
    throw usageError('conflicting_key_input', '--api-key-stdin cannot be combined with --api-key or SUROWAN_API_KEY');
  }
  if (parsed.command.apiKeyStdin) {
    apiKey = await readLoginKey(timeoutMs);
  } else if (apiKey === undefined) {
    apiKey = await promptLoginField('API key (hidden): ', true, timeoutMs);
  }
  secrets.push(apiKey);
  await writeCredentials(path, { endpoint, apiKey });
  const output = redactingIo(io, secrets, parsed.json);
  output.stdout(
    parsed.json
      ? `${JSON.stringify({ status: 'saved', endpoint, credential: 'api_key', credentials_file: path })}\n`
      : 'API key saved. It authorizes inspection and replay; run `login --username <name>` for the full panel surface.\n',
  );
  return 0;
}

/**
 * Panel login: the password is exchanged for a session token, which is stored
 * instead of an API key. The token authorizes exactly what the browser panel
 * authorizes, which is what makes the panel write surface reachable here.
 */
async function panelLoginFlow(
  parsed: ParsedCli,
  endpoint: string,
  io: CliIo,
  path: string,
  timeoutMs: number,
  secrets: Array<string | undefined>,
): Promise<number> {
  if (parsed.command?.kind !== 'login' || parsed.command.username === undefined) {
    throw usageError('invalid_command', 'expected a panel login');
  }
  let password = parsed.command.password;
  if (parsed.command.passwordStdin) {
    password = await readLoginKey(timeoutMs);
  } else if (password === undefined) {
    password = await promptLoginField('Panel password (hidden): ', true, timeoutMs);
  }
  secrets.push(password);
  const client = new AdminClient({ baseUrl: parseEndpoint(endpoint), defaultTimeoutMs: timeoutMs });
  const result = await panelLogin(client, { username: parsed.command.username, password });
  secrets.push(result.session);
  await writeCredentials(path, { endpoint, session: result.session });
  const output = redactingIo(io, secrets, parsed.json);
  output.stdout(
    parsed.json
      ? `${JSON.stringify({ status: 'saved', endpoint, credential: 'session', username: result.username, credentials_file: path })}\n`
      : `Panel session saved for ${result.username}. Run surowan-utils doctor to verify connection and authentication.\n`,
  );
  return 0;
}

/** `commands` lists the panel surface so an operator can see what is reachable. */
function renderCommands(json: boolean): string {
  if (json) {
    return `${JSON.stringify(
      PANEL_SPECS.map((spec) => ({
        command: spec.command,
        method: spec.method,
        path: `/api/${spec.path}`,
        revision: spec.revision ?? null,
        confirm: spec.confirm ?? null,
        summary: spec.summary,
      })),
    )}\n`;
  }
  const width = Math.max(...PANEL_SPECS.map((spec) => spec.command.length));
  return `${PANEL_SPECS.map((spec) => `${spec.command.padEnd(width)}  ${spec.method.padEnd(6)} ${spec.summary}`).join(
    '\n',
  )}\n`;
}

/**
 * `runCli` handles `login`, `commands` and every panel route before reaching
 * this point; the assertion keeps the compiler honest about the remainder.
 */
function assertFirstClass(command: Command): FirstClassCommand {
  if (
    command.kind === 'panel' ||
    command.kind === 'commands-list' ||
    command.kind === 'login' ||
    command.kind === 'doctor'
  ) {
    throw usageError('invalid_command', `${command.kind} is not an Admin API command`);
  }
  return command;
}

/** parseArgs can fail before ParsedCli exists; retain even raw key flags for redaction. */
function argumentKeys(argv: readonly string[]): string[] {
  const keys: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token?.startsWith('--api-key=')) {
      keys.push(token.slice('--api-key='.length));
    } else if (token === '--api-key' && argv[index + 1] !== undefined) {
      keys.push(argv[index + 1] ?? '');
    }
  }
  return keys;
}

/** Redact JSON string tokens without touching structural quotes, braces or numbers. */
function redactingIo(io: CliIo, secrets: readonly (string | undefined)[], jsonOutput: boolean): CliIo {
  return {
    stdout: (text) =>
      io.stdout(
        jsonOutput
          ? text.replace(/"(?:\\.|[^"\\])*"/g, (token) =>
              JSON.stringify(redactSecrets(JSON.parse(token) as string, secrets)),
            )
          : redactSecrets(text, secrets),
      ),
    stderr: (text) => io.stderr(redactSecrets(text, secrets)),
  };
}

function reportError(error: unknown, io: CliIo, secrets: readonly (string | undefined)[]): number {
  const cli = error instanceof CliError ? error : undefined;
  // A server-provided error string becomes the CliError code; it is just as
  // capable of echoing the key as the message is.
  const code = redactSecrets(cli?.code ?? 'internal_error', secrets);
  const rawMessage = cli?.message ?? (error instanceof Error ? error.message : 'unexpected failure');
  io.stderr(`${JSON.stringify({ error: code, message: redactSecrets(rawMessage, secrets) })}\n`);
  return cli?.exitCode ?? 1;
}

/**
 * The API key must never appear in output, even if a server echoes it back.
 * Also used for files the CLI persists (the media manifest), so both stdout and
 * on-disk metadata share one redaction contract.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) {
      continue;
    }
    // Replace the JSON-escaped form first: inside a JSON document that is the
    // form actually written, and an escaped match cannot cut through a
    // structural quote (a raw match on a key ending in `\` can).
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) {
      redacted = redacted.split(escaped).join('[redacted]');
    }
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
