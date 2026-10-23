import type { warnings as warningsEn } from '../../en/pages/warnings.ts';

export const warnings: typeof warningsEn = {
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
  loadMore: '加载更多',
  noStanding: '当前没有常态警告。',
  noEvents: '还没有事件警告。',
  missingFields: '缺少：{{fields}}',
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
    openInvocations: '打开调用记录',
    openSettings: '打开设置',
  },
  codes: {
    developer_payload_recording: {
      title: '正在记录原始请求报文',
      body: '开发者录制已开启，模型的请求与响应快照会写入 SQLite。不再需要时请到开发者页关闭。',
    },
    agent_model_missing: {
      title: '未配置 agent 模型',
      body: 'Bot 仍会接收消息，但在全局 agent 的 Provider、模型与 thinking level 全部配置之前不会启动任何 Invocation。',
    },
    vision_model_missing: {
      title: '未配置 vision 模型',
      body: '在 vision 的 Provider 与模型都配置之前，图片理解与后台 Sticker 索引不可用。',
    },
    invocation_failure_rate: {
      title: 'Invocation 失败率超过阈值',
      body: '最近 {{total}} 次完成的 Invocation 中有 {{failed}} 次失败（{{rate}}%），超过 {{threshold}}% 的阈值。',
    },
    admin_login_failures: {
      title: '连续管理员登录失败',
      body: '面板已连续发生 {{count}} 次用户名/密码错误。',
    },
    unknown: {
      title: '未知警告：{{code}}',
      body: '当前面板版本没有该警告代码的模板；以下是原始变量。',
    },
  },
};
