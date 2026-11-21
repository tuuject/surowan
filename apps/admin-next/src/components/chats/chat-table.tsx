import { IconButton } from '@tuuject/koi-react/button';
import { TrashIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { thinkingLevelLabel } from '@/lib/format';
import { type ColumnSpec, MonoValue, RowActions, TableShell, ToneBadge } from '@/components/business';
import { ChatRowMenu } from '@/components/chats/chat-row-menu';
import { EditIcon } from '@/components/icons';
import type { ChatEntry, ChatSettingsView, ChatsView, ParticipationWindow } from '@/lib/api/chats.ts';
import { effectiveWindows, summarizeWindows } from '@/lib/participation';

/** A field the file and the running process disagree on shows the running value underneath. */
function RunningNote({ value }: { readonly value: string | null }): ReactElement | null {
  const { t } = useTranslation();
  return value === null ? null : (
    <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.chats.runningNote', { value })}</p>
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
  items = view.items,
  loading = false,
  onEdit,
  onSchedule,
  onProactive,
  onDecisionGate,
  onGroupMemory,
  onMcp,
  onRemove,
}: {
  readonly view: ChatsView;
  readonly items?: readonly ChatEntry[];
  readonly loading?: boolean;
  readonly onEdit: (chat: ChatEntry) => void;
  readonly onSchedule: (chat: ChatEntry) => void;
  readonly onProactive: (chat: ChatEntry) => void;
  readonly onDecisionGate: (chat: ChatEntry) => void;
  readonly onGroupMemory: (chat: ChatEntry) => void;
  readonly onMcp: (chat: ChatEntry) => void;
  readonly onRemove: (chat: ChatEntry) => void;
}): ReactElement {
  const { t } = useTranslation();
  // A Chat removed from the file is still running until restart: show what it runs.
  const shown = (row: ChatEntry): ChatSettingsView | null => row.saved ?? row.active;
  const topicsText = (settings: ChatSettingsView): string =>
    settings.topic_ids === null ? t('pages.chats.allTopics') : settings.topic_ids.join(', ');
  const modelText = (settings: ChatSettingsView): string =>
    `${settings.effective.provider} / ${settings.effective.model}`;
  const modelSource = (settings: ChatSettingsView): string =>
    `${settings.provider === null ? t('pages.chats.defaultModel') : t('pages.chats.chatOverride')}${t('common.separator')}${t('pages.chats.thinkingShort', { level: thinkingLevelLabel(settings.effective.thinking_level) })}${
      settings.thinking_level === null ? t('pages.chats.inheritedSuffix') : ''
    }`;
  const windowSummary = (window: ParticipationWindow): string =>
    summarizeWindows([window], {
      dayLabels: t('pages.chats.weekdaysShort').split(','),
      dailyLabel: t('pages.chats.daily'),
      separator: t('common.separator'),
    });
  const groupMemoryText = (settings: ChatSettingsView): string => {
    const memory = settings.group_memory;
    if (memory === null || !memory.enabled) {
      return t('pages.chats.groupMemoryOffSummary');
    }
    const summary = t('pages.chats.groupMemorySummary', { minutes: memory.idle_minutes ?? 30 });
    return (memory.thirty_hour_clock ?? 'off') === 'off'
      ? summary
      : `${summary}${t('common.separator')}${t('pages.chats.groupMemoryThirtyHourSummary')}`;
  };
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
  // Only the Chat's own overrides are visible here: the global values live on
  // the entry gate page, and the row says whether this Chat departs from them.
  const decisionGateText = (settings: ChatSettingsView): string => {
    const gate = settings.decision_gate;
    if (gate === null) {
      return t('pages.chats.decisionGateInheritSummary');
    }
    if (gate.enabled === false) {
      return t('pages.chats.decisionGateOffSummary');
    }
    if (gate.enabled === true) {
      // Only a mode this Chat sets is named; an inherited mode may be anything.
      if (gate.mode === 'enforce') {
        return t('pages.chats.decisionGateEnforceSummary');
      }
      if (gate.mode === 'shadow') {
        return t('pages.chats.decisionGateShadowSummary');
      }
      return t('pages.chats.decisionGateOnSummary');
    }
    return t('pages.chats.decisionGateCustomSummary');
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
    if (settings.participation?.ask_only ?? view.global_participation?.ask_only) {
      push(t('pages.chats.modeAskOnly'));
      return lines;
    }
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
        <div className={css({ minWidth: '0' })}>
          <p
            dir="auto"
            className={css({ margin: '0', truncate: true }, row.title === null ? { color: 'text-muted' } : {})}
          >
            {row.title ?? t('pages.chats.unknownChat')}
          </p>
          <p
            className={css({
              margin: '0',
              display: 'flex',
              minWidth: '0',
              overflow: 'hidden',
              gap: '2',
              textStyle: 'small',
              color: 'text-muted',
            })}
          >
            <MonoValue value={row.id} />
            <span>{row.type ?? (row.id.startsWith('-') ? t('pages.chats.group') : t('pages.chats.private'))}</span>
          </p>
          {row.runtime_chat_id !== row.id ? (
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('pages.chats.migratedTo', { id: row.runtime_chat_id })}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'topics',
      title: t('pages.chats.colTopics'),
      width: 112,
      render: (row) => {
        const settings = shown(row);
        return settings === null ? null : (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <p className={css({ margin: '0' }, settings.topic_ids === null ? { color: 'text-muted' } : {})}>
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
      // A provider / model pair is long and unbreakable: wrap it instead of clipping the id.
      className: css({ whiteSpace: 'normal' }),
      render: (row) => {
        const settings = shown(row);
        return settings === null ? null : (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <MonoValue value={modelText(settings)} />
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>{modelSource(settings)}</p>
            <RunningNote
              value={runningDiff(
                row,
                (item) =>
                  `${modelText(item)}${t('common.separator')}${t('pages.chats.thinkingShort', { level: thinkingLevelLabel(item.effective.thinking_level) })}`,
              )}
            />
          </div>
        );
      },
    },
    {
      key: 'activeHours',
      title: t('pages.chats.colActiveHours'),
      className: css({ whiteSpace: 'normal' }),
      // Private chats never gate, so they have no schedule to show or edit.
      render: (row) => {
        const settings = shown(row);
        return settings === null || !row.id.startsWith('-') ? null : (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            {activeHoursLines(settings).map((line) => (
              <p key={line.key} className={css({ textStyle: 'body' })}>
                {line.text}
              </p>
            ))}
            <RunningNote
              value={runningDiff(row, (item) =>
                activeHoursLines(item)
                  .map((line) => line.text)
                  .join(t('common.separator')),
              )}
            />
          </div>
        );
      },
    },
    {
      key: 'proactive',
      title: t('pages.chats.colProactive'),
      className: css({ whiteSpace: 'normal' }),
      // Private chats have no proactive path: every message is already directed at the bot.
      render: (row) => {
        const settings = shown(row);
        return settings === null || !row.id.startsWith('-') ? null : (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <p className={css({ textStyle: 'body' })}>{proactiveText(settings)}</p>
            <RunningNote value={runningDiff(row, proactiveText)} />
          </div>
        );
      },
    },
    {
      key: 'decisionGate',
      title: t('pages.chats.colDecisionGate'),
      className: css({ whiteSpace: 'normal' }),
      // Private chats never gate: every message is already directed at the bot.
      render: (row) => {
        const settings = shown(row);
        return settings === null || !row.id.startsWith('-') ? null : (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <p className={css({ textStyle: 'body' })}>{decisionGateText(settings)}</p>
            <RunningNote value={runningDiff(row, decisionGateText)} />
          </div>
        );
      },
    },
    {
      key: 'groupMemory',
      title: t('pages.chats.colGroupMemory'),
      width: 144,
      className: css({ whiteSpace: 'normal' }),
      render: (row) => {
        const settings = shown(row);
        return settings === null || !row.id.startsWith('-') ? null : (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <p className={css({ textStyle: 'body' })}>{groupMemoryText(settings)}</p>
            <RunningNote value={runningDiff(row, groupMemoryText)} />
          </div>
        );
      },
    },
    {
      key: 'status',
      title: t('pages.chats.colStatus'),
      width: 112,
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
      width: 140,
      paddingBlock: 'none',
      render: (row) =>
        row.saved === null ? null : (
          <RowActions>
            <IconButton
              variant="ghost"
              color="secondary"
              onClick={() => onEdit(row)}
              label={t('common.edit')}
              icon={<EditIcon />}
            />
            <ChatRowMenu
              row={row}
              onSchedule={onSchedule}
              onProactive={onProactive}
              onDecisionGate={onDecisionGate}
              onGroupMemory={onGroupMemory}
              onMcp={onMcp}
            />
            <IconButton
              variant="ghost"
              color="error"
              disabled={view.items.filter((item) => item.saved !== null).length <= 1}
              onClick={() => onRemove(row)}
              label={t('pages.chats.remove')}
              icon={<TrashIcon />}
            />
          </RowActions>
        ),
    },
  ];
  return (
    <TableShell
      columns={columns}
      data={items}
      rowKey={(row) => row.id}
      loading={loading}
      minWidth={1040}
      emptyText={t('pages.chats.emptyChats')}
    />
  );
}
