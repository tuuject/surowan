export const roles = {
  pageDescription: '为机器人的三项工作分别选择模型和思考强度，保存后立即生效。',
  form: {
    pending_one: '{{count}} 项未保存的更改',
    pending_other: '{{count}} 项未保存的更改',
    unchanged: '没有未保存的更改',
    saved: '所有更改已保存',
    save: '保存',
    saving: '保存中…',
    discard: '放弃更改',
    partial: '只保存了一部分：{{message}} 其余更改仍保留在页面上。',
    refreshFailed: '更改已提交，但页面未能重新读取配置：{{message}} 请刷新页面后再保存。',
    missingModel: '{{model}} 已不在配置中。请另选一个模型后再保存。',
    cardChanged: '有未保存的更改',
  },
  manageProviders: '管理供应商',
  addProvider: '添加供应商',
  noProvidersTitle: '还没有供应商',
  noProvidersDescription: '先到「供应商」页添加供应商并选好要用的模型，再回来给它们分配工作。',
  modelLabel: '模型',
  thinkingLabel: '思考强度',
  levelUnset: '未设置',
  unset: '未设置',
  notReasoning: '这个模型不支持调节思考强度',
  searchModels: '搜索模型',
  noMatchingModels: '没有匹配的模型',
  useAs: '用作',
  useAsAria: '把 {{model}} 用作',
  agent: {
    title: '主模型',
    short: '主模型',
    description: '阅读群聊和私聊消息，决定如何回复。未设置时机器人不会回复。',
    resetsNote: '切换模型时会重置为最低档',
  },
  vision: {
    title: '图片识别模型',
    short: '图片识别',
    description: '描述图片和贴纸，看图与贴纸索引都靠它。未设置时这两项不可用。',
  },
  tool: {
    title: '工具模型',
    short: '工具',
    description: '负责辞典融合、群聊记忆整理等后台任务。未单独设置时跟随主模型。',
    defaultGroup: '默认',
    inherit: '跟随主模型',
    levelInherited: '跟随主模型',
  },
};

export const kind = {
  builtin: '内置',
  custom: '自定义',
};

export const apiFormat = {
  openaiCompletions: 'OpenAI (Chat Completions)',
  openaiResponses: 'OpenAI (Responses)',
  anthropicMessages: 'Anthropic',
  googleGenerativeAi: 'Google',
};

export const modality = {
  text: '文字',
  image: '图片',
};

export const toolModel = {
  savedInherited: '工具模型现在跟随主模型',
  saved: '工具模型已切换，思考强度为 {{level}}',
  conflict: '你编辑期间设置被别处修改，页面已刷新，请重新选择。',
};
