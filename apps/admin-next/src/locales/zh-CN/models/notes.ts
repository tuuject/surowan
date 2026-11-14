export const feedback = {
  savedRestartRequired: '已保存，需要重启',
  restartWaiting_one: '{{count}} 项设置需要重启后生效。',
  restartWaiting_other: '{{count}} 项设置需要重启后生效。',
  appliedAndWaiting_one: '{{applied}} 项已生效，{{count}} 项需要重启后生效。',
  appliedAndWaiting_other: '{{applied}} 项已生效，{{count}} 项需要重启后生效。',
  applied: '已生效',
  appliedDetail_one: '{{count}} 项设置已生效。',
  appliedDetail_other: '{{count}} 项设置已生效。',
  saved: '已保存',
  savedDescription: '已保存到配置文件',
  writeConflict: '你编辑期间，配置被别处改过了。已重新读取，请再试一次。',
};

export const match = {
  matched: '参数参考了 models.dev 上 {{provider}} 的 {{model}}',
  crossProviderNote: '（列在其他供应商名下）',
  fuzzyNote: '（名称相近但不完全一致，请逐项核对）',
};

export const source = {
  missing: '未查到',
  from: '来自 {{source}}',
  crossProvider: 'models.dev（列在其他供应商名下）',
  fuzzy: 'models.dev（名称相近的模型）',
  highestPrice: 'models.dev（取所列最高价格）',
  reasoningDefault: '未查到，按不支持思考添加',
  costDefault: '未查到，按 0 添加',
};

export const switchConfirm = {
  title: '终止进行中的运行并切换？',
  description:
    '正在使用当前模型的运行：{{count}} 次。切换会立即终止它们，它们正在处理的消息不会再得到回复。之前委派的任务不受影响，之后的消息由新模型处理。',
  confirm: '终止并切换',
  stopped_one: '已终止 {{count}} 次进行中的运行。',
  stopped_other: '已终止 {{count}} 次进行中的运行。',
};

export const validation = {
  idRequired: '模型 ID 不能为空',
  inputRequired: '请至少选择一种输入：文字或图片',
  positiveInteger: '请填写正整数',
  maxTokensExceeds: '最长输出不能超过上下文长度',
  costRequired: '四项价格都要填写（免费填 0）',
};
