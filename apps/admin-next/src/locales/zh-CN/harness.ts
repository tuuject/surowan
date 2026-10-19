import type { harness as harnessEn } from '../en/harness.ts';

export const harness: typeof harnessEn = {
  description:
    'Agent harness 的运行上限与发送行为。保存会写入 config.jsonc 并立即应用：之后开始的 Invocation 使用新值，运行中的 Invocation 继续用启动时的值。',
  elsewhere: 'Agent 模型与 thinking 档位在 <models>Models</models> 页；系统提示在 <prompts>Prompts</prompts> 页。',
  loadFailed: '加载 Harness 设置失败',
  save: '保存并应用',
  saving: '保存中…',
  discard: '放弃修改',
  unchanged: '没有未保存的修改',
  pending_one: '{{count}} 项未保存修改',
  pending_other: '{{count}} 项未保存修改',
  invalid: '请先修正标出的字段再保存。',
  running: '运行中：{{value}}',
  noLimit: '不限制',
  noLimitPlaceholder: '留空表示不限制',
  on: '开',
  off: '关',
  errors: {
    integer: '请输入整数',
    number: '请输入数字',
    min: '不能小于 {{min}}',
    max: '不能大于 {{max}}',
    greaterThan: '必须大于 {{min}}',
  },
  groups: {
    budget: {
      title: '预算与并发',
      description: '所有 Chat 共享的全局安全上限。',
    },
    send: {
      title: '发送行为',
      description: 'send 工具在消息发往 Telegram 之前执行的规则。',
    },
    rateLimits: {
      title: '限流',
      description: '防止长生命周期运行刷屏的节流。',
    },
    context: {
      title: 'Conversation Context',
      description: '持久 transcript 的保留、裁剪与等待方式。',
    },
    memory: {
      title: '记忆审核',
      description: 'Memories 页何时把记忆标为需要审核。',
    },
  },
  fields: {
    'daily_budget.max_tokens': {
      label: '每日 Token 预算',
      description:
        'Agent 与聊天触发的读图共享的全局每日 Token 上限，用于熔断失控循环。实时读取：调低后下一次模型调用即被拦截。',
    },
    max_concurrency: {
      label: '最大并发 Invocation',
      description: '同时运行的 Invocation 上限。',
    },
    history_messages: {
      label: '历史消息条数',
      description: '每个新 Invocation 冻结进 history 快照的消息条数。',
    },
    context_stop_ratio: {
      label: 'Context 收尾比例',
      description: '估算输入达到模型上下文窗口的这一比例后，运行只剩一轮只带 send 的收尾，然后结束。',
    },
    send_max_text_length: {
      label: '最大文本长度',
      description: '单次 send 的文本字符上限（1–4096）。',
    },
    send_disallow_blank_lines: {
      label: '禁止空行',
      description: '拒绝包含空行的文本，段落只能用单个换行分隔。',
    },
    send_nudge_enabled: {
      label: 'Send 提醒',
      description: '模型即将带着普通文本停止、且本批从未调用 send 时，提醒它用 send 发送。',
    },
    send_barrier_enabled: {
      label: 'Send 屏障',
      description: '一轮里第一次 send 前若有新消息正在收集，先拦下这次发送，让模型读完新消息再回复。',
    },
    allow_reply_message_multiple_times: {
      label: '允许对同一消息多次回复',
      description: '关闭按消息的 Reply 去重；授权、预算与限流照常生效。',
    },
    send_duplicate_guard_enabled: {
      label: '重复发送保护',
      description:
        '拒绝与同一 Invocation 内已发出内容完全一致的文本或贴纸，以及把上一条的内容换个引用目标重发；拒绝超过 3 次即停止本次运行。',
    },
    'rate_limits.sends_per_window': {
      label: '窗口内发送上限',
      description: '每个 Chat 在滑动窗口内允许的 Telegram 发送次数，失败的尝试同样计数。',
    },
    'rate_limits.window_seconds': {
      label: '窗口长度（秒）',
      description: '发送滑动窗口的长度。',
    },
    'rate_limits.turns_per_injection': {
      label: '每次注入的 turn 上限',
      description: '自最近一次注入批次以来允许的 turn 数，超过即结束运行。',
    },
    'context.retained_sends_target': {
      label: '保留发送目标',
      description: 'GC 裁剪后保留的发送次数，必须小于保留上限。',
    },
    'context.retained_sends_max': {
      label: '保留发送上限',
      description: '保留窗内发送次数超过此值时触发 GC。',
    },
    'context.hard_token_ratio': {
      label: '硬 Token 比例',
      description: '强制触发 GC 的上下文窗口比例，不能超过 Context 收尾比例。',
    },
    'context.ref_ttl_hours': {
      label: '引用有效期（小时）',
      description: '图片、贴纸与 Reply 引用的有效期。保存后新签发或续期的引用使用新值，已有引用保留原到期时间。',
    },
    'context.idle_grace_seconds': {
      label: '空闲等待（秒）',
      description: '运行自然结束后继续等待下一批消息的时长。0 关闭长生命周期运行；否则不能小于 Bucket 窗口。',
    },
    'context.max_wall_clock_seconds': {
      label: '最长运行时间（秒）',
      description: '单次运行的墙上时钟上限，必须大于空闲等待。',
    },
    'context.agent_cache_size': {
      label: 'Agent 缓存数',
      description: '内存中缓存 agent 实例的 Conversation 数（LRU）。调小后在下一次缓存时逐出，不会丢历史。',
    },
    memory_ttl_warning_days: {
      label: '长 TTL 警告（天）',
      description: '剩余寿命超过该天数的记忆会在 Memories 页标出。',
    },
  },
};
