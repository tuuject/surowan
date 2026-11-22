/**
 * UI strings the docs screenshot specs navigate by.
 *
 * The specs run the panel in `zh-CN` and `en`, so every label, heading and
 * button name they look up exists in both languages. The strings are copied
 * verbatim from `apps/admin-next/src/locales/<locale>/` (the panel's source of
 * truth): if a catalog changes, the screenshot run fails on the missing label
 * instead of quietly capturing the wrong state. Structural hooks (ids,
 * `data-model-list`, `role="dialog"`) are preferred wherever they exist.
 */
import type { DocsLocale } from '../e2e/docs-locale.ts';

export interface DocsLabels {
  readonly nav: {
    readonly mainNavigation: string;
    readonly overview: string;
  };
  readonly auth: {
    readonly loginTitle: string;
    readonly codeSignIn: string;
    readonly code: string;
    readonly signIn: string;
  };
  readonly common: {
    readonly save: string;
    readonly cancel: string;
  };
  readonly overview: {
    readonly storedMessages: string;
    readonly botStatus: string;
    readonly recentInvocations: string;
    readonly warningsNone: string;
  };
  readonly telegram: {
    readonly title: string;
    readonly connected: string;
    readonly disabled: string;
    readonly tokenConfigured: string;
    readonly tokenMissing: string;
    readonly tokenLabel: string;
    readonly save: string;
    readonly saved: string;
    readonly clear: string;
  };
  readonly chats: {
    readonly title: string;
    readonly chatColumn: string;
    readonly active: string;
    readonly private: string;
  };
  readonly keychain: {
    readonly title: string;
    readonly nameColumn: string;
    readonly usedByColumn: string;
    readonly unused: string;
  };
  readonly apiKeys: {
    readonly title: string;
    readonly create: string;
    readonly createConfirm: string;
    readonly name: string;
    readonly mode: string;
    readonly saveTitle: string;
    readonly done: string;
  };
  readonly passkeys: {
    readonly title: string;
    readonly add: string;
    readonly nameLabel: string;
    readonly registerConfirm: string;
    readonly registered: string;
    readonly passwordStatus: string;
    readonly empty: string;
  };
  readonly models: {
    readonly providersTitle: string;
    readonly modelsTitle: string;
    readonly provider: (alias: string) => string;
    readonly checkHealth: (model: string) => string;
    readonly healthOk: string;
    readonly modelReply: string;
  };
  readonly roles: {
    readonly pageDescription: string;
    readonly save: string;
    readonly saved: string;
    readonly unchanged: string;
    readonly pending: (count: number) => string;
    readonly discard: string;
    readonly thinkingEffort: string;
    readonly agentTitle: string;
    readonly visionTitle: string;
    readonly toolTitle: string;
  };
  readonly prompts: {
    readonly globalScope: string;
    readonly promptLabel: string;
    readonly save: string;
    readonly historyTitle: string;
    readonly applied: string;
    readonly external: string;
  };
  readonly playground: {
    readonly title: string;
    readonly roomsHeading: string;
    readonly holdOn: string;
    readonly pending: (count: number) => string;
    readonly release: (count: number) => string;
    readonly runsHeading: string;
    readonly runsEmpty: string;
    readonly audit: string;
    readonly composer: string;
    readonly send: string;
    readonly timelineHeading: string;
    readonly completed: string;
  };
}

const EN: DocsLabels = {
  nav: {
    mainNavigation: 'Main navigation',
    overview: 'Overview',
  },
  auth: {
    loginTitle: 'Surowan admin sign-in',
    codeSignIn: 'Sign in with a one-time code',
    code: 'One-time code',
    signIn: 'Sign in',
  },
  common: {
    save: 'Save',
    cancel: 'Cancel',
  },
  overview: {
    storedMessages: 'Stored messages',
    botStatus: 'Bot status',
    recentInvocations: 'Recent invocations',
    warningsNone: 'No warnings need attention.',
  },
  telegram: {
    title: 'Telegram settings',
    connected: 'Connected',
    disabled: 'Disabled',
    tokenConfigured: 'A token is configured.',
    tokenMissing: 'No token is configured.',
    tokenLabel: 'New Bot Token',
    save: 'Save token',
    saved: 'Telegram token saved',
    clear: 'Clear token',
  },
  chats: {
    title: 'Chat allowlist',
    chatColumn: 'Chat',
    active: 'Active',
    private: 'Private',
  },
  keychain: {
    title: 'Keychain',
    nameColumn: 'Name',
    usedByColumn: 'Used by',
    unused: 'Unused',
  },
  apiKeys: {
    title: 'API keys',
    create: 'Create API key',
    createConfirm: 'Create key',
    name: 'Name',
    mode: 'Mode',
    saveTitle: 'Save your API key',
    done: 'Done',
  },
  passkeys: {
    title: 'Passkeys',
    add: 'Add passkey',
    nameLabel: 'Passkey name',
    registerConfirm: 'Register passkey',
    registered: 'Passkey registered',
    passwordStatus: 'Password',
    empty: 'No passkeys registered yet.',
  },
  models: {
    providersTitle: 'Providers',
    modelsTitle: 'Models',
    provider: (alias) => `Provider ${alias}`,
    checkHealth: (model) => `Test whether ${model} replies`,
    healthOk: 'OK',
    modelReply: 'Model reply',
  },
  roles: {
    pageDescription:
      "Choose the model for each of the bot's jobs and how hard it thinks. Saved changes apply right away.",
    save: 'Save',
    saved: 'All changes saved',
    unchanged: 'No unsaved changes',
    pending: (count) => `${String(count)} unsaved change${count === 1 ? '' : 's'}`,
    discard: 'Discard changes',
    thinkingEffort: 'Thinking effort',
    agentTitle: 'Agent model',
    visionTitle: 'Vision model',
    toolTitle: 'Tool Model',
  },
  prompts: {
    globalScope: 'Global prompt',
    promptLabel: 'Prompt',
    save: 'Save and apply',
    historyTitle: 'Version history',
    applied: 'Applied',
    external: 'External',
  },
  playground: {
    title: 'Playground',
    roomsHeading: 'Rooms',
    holdOn: 'Hold on',
    pending: (count) => `${String(count)} pending`,
    release: (count) => `Release ${String(count)}`,
    runsHeading: 'Runs',
    runsEmpty: 'No runs yet.',
    audit: 'Audit',
    composer: 'Message',
    send: 'Send',
    timelineHeading: 'Timeline',
    completed: 'Completed',
  },
};

const ZH: DocsLabels = {
  nav: {
    mainNavigation: '主导航',
    overview: '概览',
  },
  auth: {
    loginTitle: '塑料碗管理端登录',
    codeSignIn: '使用一次性码登录',
    code: '一次性码',
    signIn: '登录',
  },
  common: {
    save: '保存',
    cancel: '取消',
  },
  overview: {
    storedMessages: '已存储消息',
    botStatus: '机器人状态',
    recentInvocations: '最近运行',
    warningsNone: '没有需要关注的警告。',
  },
  telegram: {
    title: 'Telegram 设置',
    connected: '正常',
    disabled: '停用',
    tokenConfigured: '已配置 Token。',
    tokenMissing: '未配置 Token。',
    tokenLabel: '新的机器人 Token',
    save: '保存 Token',
    saved: 'Telegram Token 已保存',
    clear: '清空 Token',
  },
  chats: {
    title: '会话白名单',
    chatColumn: '会话',
    active: '生效中',
    private: '私聊',
  },
  keychain: {
    title: '密钥',
    nameColumn: '名字',
    usedByColumn: '被使用于',
    unused: '未使用',
  },
  apiKeys: {
    title: 'API 密钥',
    create: '创建 API 密钥',
    createConfirm: '创建密钥',
    name: '名称',
    mode: '权限',
    saveTitle: '保存 API 密钥',
    done: '完成',
  },
  passkeys: {
    title: '通行密钥',
    add: '添加通行密钥',
    nameLabel: '通行密钥名称',
    registerConfirm: '注册通行密钥',
    registered: '通行密钥已注册',
    passwordStatus: '密码',
    empty: '还没有注册通行密钥。',
  },
  models: {
    providersTitle: '供应商',
    modelsTitle: '模型',
    provider: (alias) => `供应商 ${alias}`,
    checkHealth: (model) => `测试 ${model} 能否正常回复`,
    healthOk: '正常',
    modelReply: '模型回复',
  },
  roles: {
    pageDescription: '为机器人的三项工作分别选择模型和思考强度，保存后立即生效。',
    save: '保存',
    saved: '所有更改已保存',
    unchanged: '没有未保存的更改',
    pending: (count) => `${String(count)} 项未保存的更改`,
    discard: '放弃更改',
    thinkingEffort: '思考强度',
    agentTitle: '主模型',
    visionTitle: '图片识别模型',
    toolTitle: '工具模型',
  },
  prompts: {
    globalScope: '全局提示词',
    promptLabel: '提示词',
    save: '保存并应用',
    historyTitle: '版本历史',
    applied: '已应用',
    external: '外部',
  },
  playground: {
    title: '虚拟群聊',
    roomsHeading: '房间',
    holdOn: '暂存中',
    pending: (count) => `待处理 ${String(count)}`,
    release: (count) => `放行 ${String(count)} 条`,
    runsHeading: '运行',
    runsEmpty: '还没有运行。',
    audit: '审计',
    composer: '消息',
    send: '发送',
    timelineHeading: '时间线',
    completed: '已完成',
  },
};

export const DOCS_LABELS: Record<DocsLocale, DocsLabels> = {
  'zh-CN': ZH,
  en: EN,
};

export function docsLabels(locale: DocsLocale): DocsLabels {
  return DOCS_LABELS[locale];
}
