import type { preferences as preferencesEn } from '../../en/pages/preferences.ts';

/** Mirrors `en/pages/preferences.ts` key for key; the annotation fails the build on drift. */
export const preferences: typeof preferencesEn = {
  themeLabel: '主题',
  languageLabel: '语言',
  displayTitle: '显示',
  displayDescription: '只保存在当前浏览器；其他浏览器和管理员各自保留自己的选择。',
  configKeysLabel: '显示 config.jsonc 键名',
  configKeysDescription: '在每个设置项下显示配置路径（如 agent.context.ref_ttl_hours），方便与 config.jsonc 对照。',
};
