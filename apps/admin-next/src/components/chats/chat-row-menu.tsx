import { useNavigate } from '@tanstack/react-router';
import { IconButton } from '@tuuject/koi-react/button';
import { Menu } from '@tuuject/koi-react/menu';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlarmIcon,
  BookOpenIcon,
  BrainIcon,
  ChatTextIcon,
  ClockIcon,
  GateIcon,
  LibraryIcon,
  MoreIcon,
  PulseIcon,
  PuzzleIcon,
  ScrollIcon,
  SparklesIcon,
} from '@/components/icons';
import type { ChatEntry } from '@/lib/api/chats.ts';

export interface ChatRowMenuProps {
  readonly row: ChatEntry;
  readonly onSchedule: (chat: ChatEntry) => void;
  readonly onProactive: (chat: ChatEntry) => void;
  readonly onDecisionGate: (chat: ChatEntry) => void;
  readonly onGroupMemory: (chat: ChatEntry) => void;
  readonly onMcp: (chat: ChatEntry) => void;
}

/**
 * The row's "More actions" menu: per-Chat settings for groups, the MCP binding
 * for every Chat, and dated quick links into the audit pages.
 */
export function ChatRowMenu({
  row,
  onSchedule,
  onProactive,
  onDecisionGate,
  onGroupMemory,
  onMcp,
}: ChatRowMenuProps): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const quickLink = (
    value: string,
    label: string,
    icon: React.ReactNode,
    to: string,
    chatId: string,
    activate: () => void,
  ) => ({
    value,
    label,
    icon,
    href: `${to}?chat=${encodeURIComponent(chatId)}`,
    onSelect: (_itemValue: string, _item: unknown, details: { readonly event: Event }) => {
      const event = details.event as MouseEvent;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      activate();
    },
  });
  return (
    <Menu
      placement="bottom-end"
      // Koi's separator bleeds past the scrollable body with negative inline margins, which turns
      // `overflow-y: auto` into `overflow-x: auto` and shows a horizontal scrollbar. Inset it instead.
      classNames={{ separator: css({ marginInline: '0' }) }}
      trigger={
        <IconButton variant="ghost" color="secondary" label={t('pages.chats.moreActions')} icon={<MoreIcon />} />
      }
      items={[
        ...(row.id.startsWith('-')
          ? [
              {
                label: t('pages.chats.settingsGroup'),
                items: [
                  {
                    value: 'active-hours',
                    label: t('pages.chats.editActiveHours'),
                    icon: <ClockIcon />,
                    onSelect: () => onSchedule(row),
                  },
                  {
                    value: 'proactive',
                    label: t('pages.chats.editProactiveReply'),
                    icon: <SparklesIcon />,
                    onSelect: () => onProactive(row),
                  },
                  {
                    value: 'decision-gate',
                    label: t('pages.chats.editDecisionGate'),
                    icon: <GateIcon />,
                    onSelect: () => onDecisionGate(row),
                  },
                  {
                    value: 'group-memory',
                    label: t('pages.chats.editGroupMemory'),
                    icon: <LibraryIcon />,
                    onSelect: () => onGroupMemory(row),
                  },
                ],
              },
              'separator' as const,
            ]
          : []),
        {
          value: 'mcp',
          label: t('pages.chats.editMcp'),
          icon: <PuzzleIcon />,
          onSelect: () => onMcp(row),
        },
        {
          label: t('pages.chats.quickLinks'),
          items: [
            quickLink(
              'prompts',
              t('layout.nav.prompts'),
              <ScrollIcon />,
              '/prompts',
              row.id,
              () => void navigate({ to: '/prompts', search: { chat: row.id } }),
            ),
            quickLink(
              'dictionary',
              t('layout.nav.dictionary'),
              <BookOpenIcon />,
              '/dictionary',
              row.runtime_chat_id,
              () => void navigate({ to: '/dictionary', search: { chat: row.runtime_chat_id } }),
            ),
            quickLink(
              'memories',
              t('layout.nav.memories'),
              <BrainIcon />,
              '/memories',
              row.runtime_chat_id,
              () => void navigate({ to: '/memories', search: { chat: row.runtime_chat_id } }),
            ),
            quickLink(
              'group-memories',
              t('layout.nav.groupMemories'),
              <LibraryIcon />,
              '/group-memories',
              row.runtime_chat_id,
              () => void navigate({ to: '/group-memories', search: { chat: row.runtime_chat_id } }),
            ),
            quickLink(
              'messages',
              t('layout.nav.messages'),
              <ChatTextIcon />,
              '/messages',
              row.runtime_chat_id,
              () => void navigate({ to: '/messages', search: { chat: row.runtime_chat_id } }),
            ),
            quickLink(
              'invocations',
              t('layout.nav.toolSessions'),
              <PulseIcon />,
              '/invocations',
              row.runtime_chat_id,
              () => void navigate({ to: '/invocations', search: { chat: row.runtime_chat_id } }),
            ),
            quickLink(
              'alarms',
              t('layout.nav.alarms'),
              <AlarmIcon />,
              '/alarms',
              row.runtime_chat_id,
              () => void navigate({ to: '/alarms', search: { chat: row.runtime_chat_id } }),
            ),
          ],
        },
      ]}
    />
  );
}
