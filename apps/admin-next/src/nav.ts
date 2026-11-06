import {
  Bell,
  BookText,
  Brain,
  Bug,
  Cpu,
  FileText,
  ImagePlus,
  Images,
  KeyRound,
  LayoutDashboard,
  LibraryBig,
  type LucideIcon,
  MessageSquare,
  MessagesSquare,
  Play,
  ScrollText,
  Search,
  Send,
  Settings,
  Shield,
  SlidersHorizontal,
  SlidersVertical,
  Sticker,
  TriangleAlert,
  UserCog,
  Zap,
} from 'lucide-react';
import type { layout as layoutEn } from '@/locales/en/layout.ts';

/** Every destination in the panel navigation. Kept literal so TanStack Router's typed navigation stays checked. */
export type NavTo =
  | '/'
  | '/warnings'
  | '/invocations'
  | '/contexts'
  | '/messages'
  | '/playground'
  | '/memories'
  | '/group-memories'
  | '/dictionary'
  | '/alarms'
  | '/stickers'
  | '/image-generate'
  | '/image-generations'
  | '/image-settings'
  | '/models'
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

export interface NavItemDefinition {
  readonly titleKey: NavItemKey;
  readonly to: NavTo;
  readonly icon: LucideIcon;
}

export interface NavGroupDefinition {
  readonly labelKey: NavGroupKey;
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
    items: [
      { titleKey: 'overview', to: '/', icon: LayoutDashboard },
      { titleKey: 'warnings', to: '/warnings', icon: TriangleAlert },
    ],
  },
  {
    labelKey: 'activity',
    items: [
      { titleKey: 'toolSessions', to: '/invocations', icon: Zap },
      { titleKey: 'contexts', to: '/contexts', icon: MessageSquare },
      { titleKey: 'messages', to: '/messages', icon: FileText },
      { titleKey: 'playground', to: '/playground', icon: Play },
    ],
  },
  {
    labelKey: 'agentData',
    items: [
      { titleKey: 'memories', to: '/memories', icon: Brain },
      { titleKey: 'groupMemories', to: '/group-memories', icon: LibraryBig },
      { titleKey: 'dictionary', to: '/dictionary', icon: BookText },
      { titleKey: 'alarms', to: '/alarms', icon: Bell },
    ],
  },
  {
    labelKey: 'media',
    items: [
      { titleKey: 'botStickerSets', to: '/stickers', icon: Sticker },
      { titleKey: 'imageGenerate', to: '/image-generate', icon: ImagePlus },
      { titleKey: 'imageGenerations', to: '/image-generations', icon: Images },
      { titleKey: 'imageSettings', to: '/image-settings', icon: Settings },
    ],
  },
  {
    labelKey: 'agentSetup',
    items: [
      { titleKey: 'models', to: '/models', icon: Cpu },
      { titleKey: 'prompts', to: '/prompts', icon: ScrollText },
      { titleKey: 'harness', to: '/harness', icon: SlidersHorizontal },
      { titleKey: 'searchSettings', to: '/search-settings', icon: Search },
    ],
  },
  {
    labelKey: 'telegram',
    items: [
      { titleKey: 'telegram', to: '/telegram', icon: Send },
      { titleKey: 'chats', to: '/chats', icon: MessagesSquare },
      { titleKey: 'botAdmins', to: '/admins', icon: Shield },
    ],
  },
  {
    labelKey: 'system',
    items: [
      { titleKey: 'apiKeys', to: '/api-keys', icon: KeyRound },
      { titleKey: 'developer', to: '/developer', icon: Bug },
      { titleKey: 'settings', to: '/settings', icon: UserCog },
      { titleKey: 'preferences', to: '/preferences', icon: SlidersVertical },
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
