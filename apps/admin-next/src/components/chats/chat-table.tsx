import { Link } from '@tanstack/react-router';
import {
  Activity,
  AlarmClock,
  BookOpen,
  Brain,
  Clock,
  ExternalLink,
  MessageSquareText,
  Pencil,
  Sparkles,
  Speech,
  Trash2,
} from 'lucide-react';
import { type ColumnSpec, FLUSH_TABLE_CLASS, MonoValue, TableShell, ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { effectiveWindows, summarizeWindows } from '@/lib/participation';
import { useTranslation } from 'react-i18next';
import type { ChatEntry, ChatSettingsView, ChatsView, ParticipationWindow } from '@/lib/api/chats.ts';

/** A field the file and the running process disagree on shows the running value underneath. */
function RunningNote({ value }: { readonly value: string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  return value === null ? null : (
    <p className="text-muted-foreground text-xs">{t('pages.chats.runningNote', { value })}</p>
  );
}

function runningDiff(row: ChatEntry, text: (settings: ChatSettingsView) => string): string | null {
  if (row.saved === null || row.active === null) {
    return null;
  }
  const running = text(row.active);
  return running === text(row.saved) ? null : running;
}

/** Stable identity of a window for React keys: content only, days flattened. */
function windowKey(window: ParticipationWindow): string {
  return `${window.start}-${window.end}-${window.days === undefined ? 'daily' : window.days.join('')}`;
}

interface ActiveHoursLine {
  readonly key: string;
  readonly text: string;
}

export function ChatTable({
  view,
  onEdit,
  onSchedule,
  onProactive,
  onRemove,
}: {
  readonly view: ChatsView;
  readonly onEdit: (chat: ChatEntry) => void;
  readonly onSchedule: (chat: ChatEntry) => void;
  readonly onProactive: (chat: ChatEntry) => void;
  readonly onRemove: (chat: ChatEntry) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  // A Chat removed from the file is still running until restart: show what it runs.
  const shown = (row: ChatEntry): ChatSettingsView | null => row.saved ?? row.active;
  const topicsText = (settings: ChatSettingsView): string =>
    settings.topic_ids === null ? t('pages.chats.allTopics') : settings.topic_ids.join(', ');
  const modelText = (settings: ChatSettingsView): string =>
    `${settings.effective.provider} / ${settings.effective.model}`;
  const modelSource = (settings: ChatSettingsView): string =>
    `${settings.provider === null ? t('pages.chats.defaultModel') : t('pages.chats.chatOverride')} · ${t('pages.chats.thinkingShort', { level: settings.effective.thinking_level })}${
      settings.thinking_level === null ? t('pages.chats.inheritedSuffix') : ''
    }`;
  const windowSummary = (window: ParticipationWindow): string =>
    summarizeWindows([window], {
      dayLabels: t('pages.chats.weekdaysShort').split(','),
      dailyLabel: t('pages.chats.daily'),
    });
  const proactiveText = (settings: ChatSettingsView): string => {
    const values = settings.effective_proactive_reply;
    if (!values.enabled) {
      return t('pages.chats.proactiveOffSummary');
    }
    const summary = t('pages.chats.proactiveSummary', {
      base: Number((values.base_probability * 100).toFixed(2)),
      increment: Number((values.increment * 100).toFixed(2)),
      pity: values.hard_pity,
    });
    return settings.proactive_reply === null ? t('pages.chats.proactiveInheritSummary', { summary }) : summary;
  };
  // One line per period keeps the allowlist table narrow with many windows.
  // Keys pair the window content with a duplicate tally: identical windows are
  // valid config, and the tally keeps keys unique and stable under reorders.
  const activeHoursLines = (settings: ChatSettingsView): readonly ActiveHoursLine[] => {
    const lines: ActiveHoursLine[] = [];
    const seen = new Map<string, number>();
    const push = (text: string, key = text): void => {
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      lines.push({ key: occurrence === 0 ? key : `${key}#${occurrence}`, text });
    };
    if (settings.participation === null) {
      const globalWindows = view.global_participation?.active_windows;
      if (globalWindows === undefined || globalWindows.length === 0) {
        push(t('pages.chats.activeHoursUnrestricted'));
      } else {
        push(t('pages.chats.activeHoursFollowsGlobal'));
        for (const window of globalWindows) {
          push(windowSummary(window), windowKey(window));
        }
      }
      return lines;
    }
    const explicit = settings.participation.active_windows;
    if (explicit === undefined) {
      push(t('pages.chats.activeHoursFollowsGlobal'));
      for (const window of effectiveWindows(settings.participation, view.global_participation)) {
        push(windowSummary(window), windowKey(window));
      }
      return lines;
    }
    if (explicit.length === 0) {
      push(t('pages.chats.activeHoursTriggerOnly'));
      return lines;
    }
    for (const window of explicit) {
      push(windowSummary(window), windowKey(window));
    }
    return lines;
  };
  const columns: readonly ColumnSpec<ChatEntry>[] = [
    {
      key: 'chat',
      title: t('pages.chats.colChat'),
      render: (row) => (
        <div className="space-y-1">
          <p className={row.title === null ? 'text-muted-foreground font-medium' : 'font-medium'}>
            {row.title ?? t('pages.chats.unknownChat')}
          </p>
          <p className="text-muted-foreground text-xs">
            <span className="font-mono">{row.id}</span> ·{' '}
            {row.type ?? (row.id.startsWith('-') ? t('pages.chats.group') : t('pages.chats.private'))}
          </p>
          {row.runtime_chat_id !== row.id ? (
            <p className="text-muted-foreground text-xs">{t('pages.chats.migratedTo', { id: row.runtime_chat_id })}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'topics',
      title: t('pages.chats.colTopics'),
      render: (row) => {
        const settings = shown(row);
        return settings === null ? null : (
          <div className="space-y-1">
            <p className={settings.topic_ids === null ? 'text-muted-foreground' : 'tabular-nums'}>
              {topicsText(settings)}
            </p>
            <RunningNote value={runningDiff(row, topicsText)} />
          </div>
        );
      },
    },
    {
      key: 'model',
      title: t('pages.chats.colAgentModel'),
      render: (row) => {
        const settings = shown(row);
        return settings === null ? null : (
          <div className="space-y-1">
            <MonoValue value={modelText(settings)} />
            <p className="text-muted-foreground text-xs">{modelSource(settings)}</p>
            <RunningNote
              value={runningDiff(
                row,
                (item) =>
                  `${modelText(item)} · ${t('pages.chats.thinkingShort', { level: item.effective.thinking_level })}`,
              )}
            />
          </div>
        );
      },
    },
    {
      key: 'activeHours',
      title: t('pages.chats.colActiveHours'),
      // Private chats never gate, so they have no schedule to show or edit.
      render: (row) => {
        const settings = shown(row);
        return settings === null || !row.id.startsWith('-') ? null : (
          <div className="space-y-1">
            {activeHoursLines(settings).map((line) => (
              <p key={line.key} className="text-sm">
                {line.text}
              </p>
            ))}
            <RunningNote
              value={runningDiff(row, (item) =>
                activeHoursLines(item)
                  .map((line) => line.text)
                  .join(' · '),
              )}
            />
          </div>
        );
      },
    },
    {
      key: 'proactive',
      title: t('pages.chats.colProactive'),
      // Private chats have no proactive path: every message is already directed at the bot.
      render: (row) => {
        const settings = shown(row);
        return settings === null || !row.id.startsWith('-') ? null : (
          <div className="space-y-1">
            <p className="text-sm">{proactiveText(settings)}</p>
            <RunningNote value={runningDiff(row, proactiveText)} />
          </div>
        );
      },
    },
    {
      key: 'status',
      title: t('pages.chats.colStatus'),
      render: (row) =>
        row.saved === null ? (
          <ToneBadge tone="warning">{t('pages.chats.removalPending')}</ToneBadge>
        ) : row.active === null ? (
          <ToneBadge tone="warning">{t('pages.chats.additionPending')}</ToneBadge>
        ) : JSON.stringify(row.saved) !== JSON.stringify(row.active) ? (
          <ToneBadge tone="warning">{t('pages.chats.changesPending')}</ToneBadge>
        ) : (
          <ToneBadge tone="success">{t('pages.chats.active')}</ToneBadge>
        ),
    },
    {
      key: 'actions',
      title: t('pages.chats.colActions'),
      align: 'right',
      render: (row) =>
        row.saved === null ? null : (
          <div className="flex items-center justify-end gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('pages.chats.quickLinks')}
                  title={t('pages.chats.quickLinks')}
                >
                  <ExternalLink />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to="/prompts" search={{ chat: row.id }}>
                    <Speech />
                    {t('layout.nav.prompts')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/dictionary" search={{ chat: row.runtime_chat_id }}>
                    <BookOpen />
                    {t('layout.nav.dictionary')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/memories" search={{ chat: row.runtime_chat_id }}>
                    <Brain />
                    {t('layout.nav.memories')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/messages" search={{ chat: row.runtime_chat_id }}>
                    <MessageSquareText />
                    {t('layout.nav.messages')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/invocations" search={{ chat: row.runtime_chat_id }}>
                    <Activity />
                    {t('layout.nav.toolSessions')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/alarms" search={{ chat: row.runtime_chat_id }}>
                    <AlarmClock />
                    {t('layout.nav.alarms')}
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {row.id.startsWith('-') ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t('pages.chats.editActiveHours')}
                title={t('pages.chats.editActiveHours')}
                onClick={() => onSchedule(row)}
              >
                <Clock />
              </Button>
            ) : null}
            {row.id.startsWith('-') ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t('pages.chats.editProactiveReply')}
                title={t('pages.chats.editProactiveReply')}
                onClick={() => onProactive(row)}
              >
                <Sparkles />
              </Button>
            ) : null}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('common.edit')}
              onClick={() => onEdit(row)}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              aria-label={t('pages.chats.remove')}
              disabled={view.items.filter((item) => item.saved !== null).length <= 1}
              onClick={() => onRemove(row)}
            >
              <Trash2 />
            </Button>
          </div>
        ),
    },
  ];
  return (
    <TableShell
      columns={columns}
      data={view.items}
      rowKey={(row) => row.id}
      className={FLUSH_TABLE_CLASS}
      emptyText={t('pages.chats.emptyChats')}
    />
  );
}
