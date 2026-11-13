import type { warnings as warningsEn } from '../../en/pages/warnings.ts';

export const warnings: typeof warningsEn = {
  pageDescription: '需要处理的常态警告，以及事件警告的历史记录。',
  standingTitle: '常态警告',
  eventsTitle: '事件警告',
  unreadCount: '{{count}} 条未读',
  unread: '未读',
  standing: '常态',
  markRead: '标为已读',
  markedRead: '警告已标为已读',
  clearHistory: '清空警告历史',
  clearTitle: '清空全部事件警告？',
  clearDescription: '所有事件警告（无论已读还是未读）都会被删除。常态警告在条件解除前仍会显示。此操作无法撤销。',
  clearConfirm: '清空警告',
  cleared: '已清空 {{count}} 条警告',
  loadFailed: '加载警告失败',
  noStanding: '当前没有常态警告。',
  noEvents: '还没有事件警告。',
  missingFields: '缺少：{{fields}}',
  invalidApiKeys: '非法密钥：{{keys}}',
  lastFailedAt: '最近失败：{{time}}',
  createdAt: '创建于 {{time}}',
  updatedAt: '更新于 {{time}}',
  readAt: '已读于 {{time}}',
  severity: {
    warning: '警告',
    critical: '严重',
  },
  actions: {
    openDeveloper: '打开开发者页',
    openModels: '打开模型页',
    openInvocations: '打开运行记录',
    openSettings: '打开设置',
    openTelegram: '打开 Telegram 设置',
    openApiKeys: '打开 API 密钥',
  },
  codes: {
    developer_payload_recording: {
      title: '正在记录原始请求报文',
      body: '开发者录制已开启，模型的请求与响应快照会写入数据库。不再需要时请到开发者页关闭。',
    },
    agent_model_missing: {
      title: '未配置主模型',
      body: '机器人仍会接收消息，但在模型页设置主模型和思考强度之前不会开始任何运行。',
    },
    vision_model_missing: {
      title: '未配置图片识别模型',
      body: '在模型页设置图片识别模型之前，看图与贴纸索引都不可用。',
    },
    invocation_failure_rate: {
      title: '运行失败率超过阈值',
      body: '最近 {{total}} 次完成的运行中有 {{failed}} 次失败（{{rate}}%），超过 {{threshold}}% 的阈值。',
    },
    admin_login_failures: {
      title: '连续管理员登录失败',
      body: '面板已连续 {{count}} 次登录失败，用户名或密码错误。',
    },
    telegram_network_error: {
      title: '未能成功连接 Telegram 服务器',
      body: '机器人会持续重试，Telegram 恢复后会自动重连。',
    },
    telegram_config_error: {
      title: 'Telegram 配置异常',
      unauthorized: '你的 Telegram Token 已被吊销或无效',
      conflict: '这个 Telegram Token 正在被其他程序使用',
      token_unreadable: '无法读取 Telegram Token',
      body: {
        unknown: '当前 Token 配置无法启动 Telegram。',
        unauthorized: '请到 Telegram 页换一个 @BotFather 提供的有效机器人 Token。',
        conflict: '另一个进程正在用这个 Token 收消息。请停掉它，或换一个 Token。',
        token_unreadable: '无法读取配置的 Token 来源，请检查保存的 Token、环境变量或命令。',
      },
    },
    api_key_invalid_permissions: {
      title: 'API 密钥权限无效',
      body: '有 API 密钥的权限无效，暂时无法使用。请到 API 密钥页为它们保存一个权限模式。',
    },
    unknown: {
      title: '未知警告：{{code}}',
      body: '当前面板版本没有这个警告的模板，下面是原始数据。',
    },
  },
};
