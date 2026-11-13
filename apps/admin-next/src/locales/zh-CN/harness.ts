import type { harness as harnessEn } from '../en/harness.ts';

export const harness: typeof harnessEn = {
  loadFailed: '加载运行参数失败',
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
  sections: {
    navigation: '表单分区',
    jump: '跳转到分区',
    invalid: '，有待修正项',
    changed: '，有未保存修改',
  },
  errors: {
    integer: '请输入整数',
    number: '请输入数字',
    min: '不能小于 {{min}}',
    max: '不能大于 {{max}}',
    greaterThan: '必须大于 {{min}}',
    lines: '至少填写一行',
    option: '请选择列表中的选项',
  },
  groups: {
    budget: {
      title: '预算与并发',
    },
    send: {
      title: '发送行为',
    },
    rateLimits: {
      title: '限流',
    },
    context: {
      title: '上下文',
    },
    proactiveReply: {
      title: '主动回复',
    },
  },
  fields: {
    'daily_budget.max_tokens': {
      label: '每日 Token 预算',
      description: '回复与看图共用的每日 Token 上限。调低后从下一次模型调用起生效。',
    },
    max_concurrency: {
      label: '最多同时运行',
      description: '可以同时进行的运行数量。',
    },
    history_messages: {
      label: '历史消息条数',
      description: '每次新运行带上的历史消息条数。',
    },
    context_stop_ratio: {
      label: '上下文收尾比例',
      description: '输入占到模型上下文长度的这一比例后，运行只再回复一次就结束。',
    },
    send_max_text_length: {
      label: '最大文本长度',
      description: '单条消息的字符上限（1–4096）。',
    },
    send_disallow_blank_lines: {
      label: '禁止空行',
      description: '拒绝包含空行的文本，段落只能用单个换行分隔。',
    },
    send_nudge_enabled: {
      label: '发送提醒',
      description: '模型什么都没发出就要结束时，提醒它把回复发出去。',
    },
    send_barrier_enabled: {
      label: '等待新消息',
      description: '发送前又有新消息进来时，先让模型读完新消息再回复。',
    },
    allow_reply_message_multiple_times: {
      label: '允许对同一消息多次回复',
      description: '允许对同一条消息回复多次，预算与限流照常生效。',
    },
    send_duplicate_guard_enabled: {
      label: '重复发送保护',
      description: '拒绝在同一次运行里重复发送相同的文本或贴纸；被拒绝超过 3 次就停止这次运行。',
    },
    send_empty_text_strategy: {
      label: '无文本发送策略',
      description: '模型发出没有文字的文本消息时怎么处理。',
      options: {
        reject: '拒绝这次调用',
        silent_success: '静默成功（不发送）',
        random_text: '发送随机兜底文本',
      },
    },
    send_empty_text_fallback_texts: {
      label: '兜底文本',
      description: '一行一条，每次随机选一条发送。',
    },
    'rate_limits.sends_per_window': {
      label: '窗口内发送上限',
      description: '每个会话在一个窗口内最多发送的消息数，发送失败也计数。',
    },
    'rate_limits.window_seconds': {
      label: '窗口长度（秒）',
      description: '统计发送次数的时间窗口。',
    },
    'rate_limits.turns_per_injection': {
      label: '每批消息的轮次上限',
      description: '每收到一批新消息后最多进行的轮次，超过就结束运行。',
    },
    'context.retained_sends_target': {
      label: '保留发送目标',
      description: '清理上下文后保留的发送次数，必须小于保留上限。',
    },
    'context.retained_sends_max': {
      label: '保留发送上限',
      description: '上下文里的发送次数超过这个值时开始清理。',
    },
    'context.hard_token_ratio': {
      label: '强制清理比例',
      description: '上下文占到模型上下文长度的这一比例时强制清理，不能超过上下文收尾比例。',
    },
    'context.ref_ttl_hours': {
      label: '引用有效期（小时）',
      description: '图片、贴纸与回复引用的有效期，只影响之后签发的引用。',
    },
    'context.idle_grace_seconds': {
      label: '空闲等待（秒）',
      description: '运行结束后继续等待下一批消息的时长。填 0 表示不等待；否则不能短于消息批次的最长等待时间。',
    },
    'context.max_wall_clock_seconds': {
      label: '最长运行时间（秒）',
      description: '单次运行的最长时间，必须大于空闲等待。',
    },
    'context.agent_cache_size': {
      label: '内存缓存数',
      description: '在内存中保留的上下文数量。调小不会丢失历史。',
    },
    'proactive_reply.enabled': {
      label: '启用主动回复调度',
      description: '开启后，没有直接叫到机器人的群聊消息要抽中才有回复机会；关闭时每批都有机会。私聊不受影响。',
    },
    'proactive_reply.base_probability': {
      label: '首次机会',
      description: '命中后第一次抽样的概率，取值 0–1（0.2 即 20%）。',
    },
    'proactive_reply.increment': {
      label: '每次增加',
      description: '每次未命中后概率增加的量，取值 0–1；命中后重新计算。',
    },
    'proactive_reply.hard_pity': {
      label: '最多尝试次数',
      description: '到这一次必定命中。',
    },
  },
};
