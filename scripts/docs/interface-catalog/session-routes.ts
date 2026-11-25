import type { EndpointSpec } from '@surowan/admin-surface';

/**
 * The `/api` routes the admin-surface specs do not model. Each entry names the
 * code that serves it, so a removed or renamed route fails the catalog test
 * instead of leaving a published page describing something the server no longer
 * answers.
 */

type HttpMethod = EndpointSpec['method'];

/**
 * One `/api` route that is not in the admin-surface specs: either a route only
 * a panel session reaches (`/api/keychain*`, `/api/live*`), a route every
 * programmatic credential is refused (`/api/auth/*`, `/api/api-keys*`), or the
 * one unauthenticated write (pairing claim). `source` points at the code that
 * implements it, so a deleted route fails the catalog test instead of leaving a
 * stale row behind.
 */
export interface SessionRoute {
  readonly method: HttpMethod;
  readonly path: string;
  /** `session` = a panel cookie is required; `public` = no credential at all. */
  readonly access: 'session' | 'public';
  readonly body: 'required' | 'optional' | 'none';
  readonly response: 'json' | 'binary' | 'text';
  readonly zh: string;
  readonly en: string;
  /**
   * The code that serves this exact method and path. Every needle must appear in
   * the file; at least one carries the method check, so removing one branch of a
   * shared handler (the keychain routes all match `segments[0] === 'keychain'`)
   * fails the catalog test instead of leaving a stale row.
   */
  readonly source: { readonly file: string; readonly needles: readonly string[] };
}

const AUTH_ROUTE_FILE = 'src/ingress/admin/routes/auth.ts';
const KEYCHAIN_ROUTE_FILE = 'src/ingress/admin/routes/keychain.ts';
const LIVE_ROUTE_FILE = 'src/ingress/admin/routes/live.ts';
const ADMIN_INDEX_FILE = 'src/ingress/admin/index.ts';

export const SESSION_ONLY_ROUTES: readonly SessionRoute[] = [
  {
    method: 'POST',
    path: '/api/auth/login',
    access: 'public',
    body: 'required',
    response: 'json',
    zh: '用管理员用户名与密码登录，`{ username, password }`；连续失败按 TCP 对端地址锁定',
    en: 'Sign in with `{ username, password }`; repeated failures lock the TCP peer address',
    source: { file: AUTH_ROUTE_FILE, needles: ["route === 'auth/login' && request.method === 'POST'"] },
  },
  {
    method: 'POST',
    path: '/api/auth/pairing',
    access: 'public',
    body: 'required',
    response: 'json',
    zh: '用服务器 `pairing create --web` 打印的一次性码登录，`{ code }`',
    en: 'Sign in with the one-time code printed by `pairing create --web`; body is `{ code }`',
    source: { file: AUTH_ROUTE_FILE, needles: ["route === 'auth/pairing' && request.method === 'POST'"] },
  },
  {
    method: 'POST',
    path: '/api/auth/passkeys/login/options',
    access: 'public',
    body: 'none',
    response: 'json',
    zh: '开始 Passkey 登录：返回 WebAuthn 选项并设置 5 分钟的挑战 Cookie',
    en: 'Start passkey sign-in: returns the WebAuthn options and sets a five-minute challenge cookie',
    source: {
      file: AUTH_ROUTE_FILE,
      needles: ["route === 'auth/passkeys/login/options' && request.method === 'POST'"],
    },
  },
  {
    method: 'POST',
    path: '/api/auth/passkeys/login/verify',
    access: 'public',
    body: 'required',
    response: 'json',
    zh: '校验 Passkey 断言并颁发面板 Session Cookie；需要 options 调用下发的 5 分钟挑战 Cookie，且 `Origin` 必须是 `admin.public_url` 配置的来源',
    en: 'Verify the passkey assertion and issue the panel session cookie; needs the five-minute challenge cookie set by the options call, and an `Origin` equal to the configured `admin.public_url`',
    source: {
      file: AUTH_ROUTE_FILE,
      needles: [
        "route === 'auth/passkeys/login/verify' && request.method === 'POST'",
        "passkeys.checkOrigin(request.headers.get('origin'))",
      ],
    },
  },
  {
    method: 'POST',
    path: '/api/auth/passkeys/register/options',
    access: 'session',
    body: 'none',
    response: 'json',
    zh: '为已登录账号开始注册新 Passkey',
    en: 'Start registering a new passkey for the signed-in account',
    source: {
      file: AUTH_ROUTE_FILE,
      needles: ["route === 'auth/passkeys/register/options' && request.method === 'POST'"],
    },
  },
  {
    method: 'POST',
    path: '/api/auth/passkeys/register/verify',
    access: 'session',
    body: 'required',
    response: 'json',
    zh: '提交 WebAuthn 注册结果并保存 Passkey；同样需要注册 options 下发的挑战 Cookie 与配置的 `Origin`',
    en: 'Submit the WebAuthn registration response and store the passkey; also needs the challenge cookie from the registration options call and the configured `Origin`',
    source: {
      file: AUTH_ROUTE_FILE,
      needles: [
        "route === 'auth/passkeys/register/verify' && request.method === 'POST'",
        "passkeys.checkOrigin(request.headers.get('origin'))",
      ],
    },
  },
  {
    method: 'PUT',
    path: '/api/api-keys/:id',
    access: 'session',
    body: 'required',
    response: 'json',
    zh: '改一条 API key 的权限模式，密钥值不变，`{ mode }`',
    en: 'Change one API key permission mode without changing its value; body is `{ mode }`',
    source: {
      file: AUTH_ROUTE_FILE,
      needles: ["segments[0] === 'api-keys' && segments.length === 2 && request.method === 'PUT'"],
    },
  },
  {
    method: 'POST',
    path: '/api/api-keys/:id/rotate',
    access: 'session',
    body: 'none',
    response: 'json',
    zh: '为同一条 API key 签发新值，旧值立即失效',
    en: 'Issue a new value for the same API key; the old value stops working immediately',
    source: {
      file: AUTH_ROUTE_FILE,
      needles: [
        "segments[0] === 'api-keys' && segments.length === 3 && segments[2] === 'rotate' && request.method === 'POST'",
      ],
    },
  },
  {
    method: 'GET',
    path: '/api/keychain',
    access: 'session',
    body: 'none',
    response: 'json',
    zh: '列出 Keychain 条目名与引用位置，永不返回值',
    en: 'List keychain entry names and where they are referenced; values never appear',
    source: {
      file: KEYCHAIN_ROUTE_FILE,
      needles: [
        "if (route === 'keychain') {",
        "if (request.method === 'GET') {",
        'return await snapshotResponse(reloader);',
      ],
    },
  },
  {
    method: 'POST',
    path: '/api/keychain',
    access: 'session',
    body: 'required',
    response: 'json',
    zh: '新建条目 `{ name, value }`；名称为 1–64 位字母、数字、`_` 或 `-`，成功返回 201',
    en: 'Create an entry from `{ name, value }`; the name is 1–64 letters, digits, `_` or `-`; answers 201',
    source: {
      file: KEYCHAIN_ROUTE_FILE,
      needles: ["if (route === 'keychain') {", "if (request.method === 'POST') {", 'const name = typeof body.name'],
    },
  },
  {
    method: 'POST',
    path: '/api/keychain/purge',
    access: 'session',
    body: 'required',
    response: 'json',
    zh: '删除不再被任何位置引用的条目，`{ names: string[] }`',
    en: 'Delete entries nothing references any more; body is `{ names: string[] }`',
    source: {
      file: KEYCHAIN_ROUTE_FILE,
      needles: ["route === 'keychain/purge' && request.method === 'POST'"],
    },
  },
  {
    method: 'PUT',
    path: '/api/keychain/:name',
    access: 'session',
    body: 'required',
    response: 'json',
    zh: '原地轮换一个条目的值并应用，`{ value }`',
    en: 'Rotate one entry in place and apply the new value; body is `{ value }`',
    source: {
      file: KEYCHAIN_ROUTE_FILE,
      needles: ['const rest = segments.slice(NAME_SEGMENT)', "if (request.method === 'PUT') {"],
    },
  },
  {
    method: 'DELETE',
    path: '/api/keychain/:name',
    access: 'session',
    body: 'none',
    response: 'json',
    zh: '删除一个未被引用的条目',
    en: 'Delete one entry that nothing references',
    source: {
      file: KEYCHAIN_ROUTE_FILE,
      needles: ['const rest = segments.slice(NAME_SEGMENT)', "if (request.method === 'DELETE') {"],
    },
  },
  {
    method: 'GET',
    path: '/api/live/invocations',
    access: 'session',
    body: 'none',
    response: 'text',
    zh: 'Invocation 列表的 Server-Sent Events 流，只在指纹变化时推送',
    en: 'Server-Sent Events stream for the invocation list; pushes only when the fingerprint changes',
    source: {
      file: LIVE_ROUTE_FILE,
      needles: ["if (request.method !== 'GET') {", "segments.length === 2 && segments[1] === 'invocations'"],
    },
  },
  {
    method: 'GET',
    path: '/api/live/invocations/:id',
    access: 'session',
    body: 'none',
    response: 'text',
    zh: '单次 Invocation 详情的 Server-Sent Events 流',
    en: 'Server-Sent Events stream for one invocation detail',
    source: {
      file: LIVE_ROUTE_FILE,
      needles: ["if (request.method !== 'GET') {", "segments.length === 3 && segments[1] === 'invocations'"],
    },
  },
  {
    method: 'POST',
    path: '/api/pairing/claim',
    access: 'public',
    body: 'required',
    response: 'json',
    zh: '配对客户端领取一次性码 `{ code, public_key, proof }`；这是唯一签发客户端凭据的写接口',
    en: 'A paired client claims a one-time code with `{ code, public_key, proof }`; the only write that issues a client credential',
    source: {
      file: ADMIN_INDEX_FILE,
      needles: [
        "request.method === 'POST' && segments.length === 2 && segments[0] === 'pairing' && segments[1] === 'claim'",
      ],
    },
  },
];

const ROUTE_KEY = (method: string, path: string): string => `${method} ${path}`;

/** Session-only routes by `METHOD /api/path`, the spelling the page groups use. */
export const SESSION_ROUTE_BY_KEY: ReadonlyMap<string, SessionRoute> = new Map(
  SESSION_ONLY_ROUTES.map((route) => [ROUTE_KEY(route.method, route.path), route]),
);
