import type { ComponentType } from 'react';
import {
  ActivityIcon,
  DatabaseIcon,
  MediaIcon,
  MonitorIcon,
  SettingsIcon,
  SlidersIcon,
  TelegramIcon,
} from '@/components/icons';
import type { layout as layoutEn } from '@/locales/en/layout.ts';

/** Every destination in the panel navigation. Kept literal so TanStack Router's typed navigation stays checked. */
export type NavTo =
  | '/'
  | '/warnings'
  | '/invocations'
  | '/reviews'
  | '/contexts'
  | '/messages'
  | '/playground'
  | '/memories'
  | '/group-memories'
  | '/dictionary'
  | '/alarms'
  | '/recurring-alarms'
  | '/stickers'
  | '/image-generate'
  | '/image-generations'
  | '/image-settings'
  | '/models'
  | '/providers'
  | '/prompts'
  | '/harness'
  | '/search-settings'
  | '/telegram'
  | '/chats'
  | '/admins'
  | '/api-keys'
  | '/developer'
  | '/settings'
  | '/preferences';

export type NavGroupKey = keyof typeof layoutEn.navGroups;
export type NavItemKey = keyof typeof layoutEn.nav;

/** A page. Children drop the icon and indent under their group instead (Koi NavMenu spec). */
export interface NavItemDefinition {
  readonly titleKey: NavItemKey;
  readonly to: NavTo;
}

export interface NavGroupDefinition {
  readonly labelKey: NavGroupKey;
  /** A 16px Font Awesome Solid icon in `currentColor`. */
  readonly icon: ComponentType<{ size?: number }>;
  readonly items: readonly NavItemDefinition[];
}

/**
 * The single navigation source, in the same groups, order and routes as the
 * pre-Koi sidebar. It drives the desktop sidebar, the horizontal bar and the
 * mobile drawer; each root route's page title still comes from the i18n
 * catalog, so switching language re-labels every surface.
 */
export const NAV_GROUPS: readonly NavGroupDefinition[] = [
  {
    labelKey: 'monitor',
    icon: MonitorIcon,
    items: [
      { titleKey: 'overview', to: '/' },
      { titleKey: 'warnings', to: '/warnings' },
    ],
  },
  {
    labelKey: 'activity',
    icon: ActivityIcon,
    items: [
      { titleKey: 'toolSessions', to: '/invocations' },
      { titleKey: 'reviews', to: '/reviews' },
      { titleKey: 'contexts', to: '/contexts' },
      { titleKey: 'messages', to: '/messages' },
      { titleKey: 'playground', to: '/playground' },
    ],
  },
  {
    labelKey: 'agentData',
    icon: DatabaseIcon,
    items: [
      { titleKey: 'memories', to: '/memories' },
      { titleKey: 'groupMemories', to: '/group-memories' },
      { titleKey: 'dictionary', to: '/dictionary' },
      { titleKey: 'alarms', to: '/alarms' },
      { titleKey: 'recurringAlarms', to: '/recurring-alarms' },
    ],
  },
  {
    labelKey: 'media',
    icon: MediaIcon,
    items: [
      { titleKey: 'imageGenerate', to: '/image-generate' },
      { titleKey: 'imageGenerations', to: '/image-generations' },
      { titleKey: 'imageSettings', to: '/image-settings' },
    ],
  },
  {
    labelKey: 'agentSetup',
    icon: SlidersIcon,
    items: [
      { titleKey: 'models', to: '/models' },
      { titleKey: 'providers', to: '/providers' },
      { titleKey: 'prompts', to: '/prompts' },
      { titleKey: 'harness', to: '/harness' },
      { titleKey: 'searchSettings', to: '/search-settings' },
    ],
  },
  {
    labelKey: 'telegram',
    icon: TelegramIcon,
    items: [
      { titleKey: 'telegram', to: '/telegram' },
      { titleKey: 'chats', to: '/chats' },
      { titleKey: 'botAdmins', to: '/admins' },
      { titleKey: 'botStickerSets', to: '/stickers' },
    ],
  },
  {
    labelKey: 'system',
    icon: SettingsIcon,
    items: [
      { titleKey: 'apiKeys', to: '/api-keys' },
      { titleKey: 'developer', to: '/developer' },
      { titleKey: 'settings', to: '/settings' },
      { titleKey: 'preferences', to: '/preferences' },
    ],
  },
];

/** The nav row to mark for a pathname, including entity detail pages under a list route. */
export function activeNavValue(pathname: string): string {
  if (pathname === '/') {
    return '/';
  }
  let active = pathname;
  let length = 0;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.to === '/') {
        continue;
      }
      if ((pathname === item.to || pathname.startsWith(`${item.to}/`)) && item.to.length > length) {
        active = item.to;
        length = item.to.length;
      }
    }
  }
  return active;
}
