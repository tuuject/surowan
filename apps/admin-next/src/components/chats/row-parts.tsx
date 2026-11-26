import { IconButton } from '@tuuject/koi-react/button';
import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { Fragment, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KvList, MonoValue, RowActions, TechText, ToneBadge } from '@/components/business';
import { ChatRowMenu } from '@/components/chats/chat-row-menu';
import {
  type ChatFact,
  type ChatFacts,
  chatStatus,
  isGroupChat,
  type SettingsSide,
  shownSettings,
  shownSide,
  type SummarySource,
} from '@/components/chats/facts';
import { EditIcon } from '@/components/icons';
import type { ChatEntry, ChatSettingsView, ChatsView } from '@/lib/api/chats.ts';

/**
 * The pieces of one allowlisted Chat that the wide table and the narrow list
 * both show. Values a Chat inherits are quiet (muted, marked inherited); values
 * it sets itself keep the full text color, so differences between Chats stand
 * out when scanning down the list.
 */

export interface ChatRowHandlers {
  readonly onEdit: (chat: ChatEntry) => void;
  readonly onSchedule: (chat: ChatEntry) => void;
  readonly onProactive: (chat: ChatEntry) => void;
  readonly onDecisionGate: (chat: ChatEntry) => void;
  readonly onGroupMemory: (chat: ChatEntry) => void;
  readonly onMcp: (chat: ChatEntry) => void;
  readonly onRemove: (chat: ChatEntry) => void;
}

const quiet = css({ color: 'text-muted' });

/** Identical lines are valid (two equal windows); an occurrence tally keeps keys unique and stable. */
function keyedLines(lines: readonly string[]): readonly { readonly key: string; readonly text: string }[] {
  const seen = new Map<string, number>();
  return lines.map((text) => {
    const occurrence = seen.get(text) ?? 0;
    seen.set(text, occurrence + 1);
    return { key: occurrence === 0 ? text : `${text}#${occurrence}`, text };
  });
}

/** A field the file and the running process disagree on shows the running value underneath. */
export function RunningNote({ value }: { readonly value: string | null }): ReactElement | null {
  const { t } = useTranslation();
  return value === null ? null : (
    <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted', overflowWrap: 'anywhere' })}>
      {t('pages.chats.runningNote', { value })}
    </p>
  );
}

/**
 * Marks a value taken from the global settings, or a summary that mixes global
 * fields with the Chat's own; a default nobody configured needs no mark.
 */
function InheritedMark({ source }: { readonly source: SummarySource }): ReactElement | null {
  const { t } = useTranslation();
  if (source !== 'global' && source !== 'mixed') {
    return null;
  }
  return (
    <span className={css({ color: 'text-muted', fontFamily: 'sans' })}>
      {source === 'global' ? t('pages.chats.inheritedSuffix') : t('pages.chats.partlyInheritedSuffix')}
    </span>
  );
}

/** Space-separated tokens that each stay on one line; the spaces stay plain so copying keeps the text. */
function Tokens({ text }: { readonly text: string }): ReactElement {
  const tokens = keyedLines(text.split(' '));
  return (
    <>
      {tokens.map((token, index) => (
        <Fragment key={token.key}>
          {index === 0 ? null : ' '}
          <span className={css({ whiteSpace: 'nowrap' })}>{token.text}</span>
        </Fragment>
      ))}
    </>
  );
}

/** An effective value, line by line, weighted by where it comes from. */
export function FactValue({
  fact,
  lines = fact.lines,
  source = fact.source,
  more,
}: {
  readonly fact: ChatFact;
  readonly lines?: readonly string[];
  /** The compact summary passes its own source when it names more fields than `lines`. */
  readonly source?: SummarySource;
  readonly more?: string | undefined;
}): ReactElement {
  const keyed = keyedLines(lines);
  // A partly inherited summary still differs from the global settings, so it keeps full color.
  const own = source === 'chat' || source === 'mixed';
  return (
    <div className={cx(css({ minWidth: '0', overflowWrap: 'anywhere' }), own ? undefined : quiet)}>
      {keyed.map((line, index) => (
        // Lines follow the table's direction; only their content is isolated, so an id in
        // an Arabic page or Arabic free text in an English one keeps the column's alignment.
        <p key={line.key} className={css({ margin: '0' }, fact.prose === true ? { whiteSpace: 'pre-wrap' } : {})}>
          {fact.tokens === true ? (
            <Tokens text={line.text} />
          ) : fact.mono === true ? (
            <TechText className={css({ fontFamily: 'mono' })}>{line.text}</TechText>
          ) : (
            <bdi>{line.text}</bdi>
          )}
          {index === keyed.length - 1 ? <InheritedMark source={source} /> : null}
        </p>
      ))}
      {more === undefined ? null : <p className={cx(css({ margin: '0' }), quiet)}>{more}</p>}
    </div>
  );
}

/**
 * Label and value pairs in two columns; the narrow list adds the model as its
 * first row. `labels` lists every label any row may show: an invisible,
 * zero-height pseudo-element sizes the label column to the widest of them, so
 * values start at the same edge in every Chat, not just within one. Being
 * generated content, it stays out of the text and the accessibility tree.
 */
export function FactRows({
  rows,
  labels,
}: {
  readonly rows: readonly { readonly key: string; readonly label: string; readonly value: ReactNode }[];
  readonly labels: readonly string[];
}): ReactElement {
  return (
    <dl
      data-label-sizer={labels.join('\n')}
      className={css({
        display: 'grid',
        gridTemplateColumns: 'max-content minmax(0, 1fr)',
        columnGap: '4',
        margin: '0',
        minWidth: '0',
        // Spacing rides on the rows, not `rowGap`: the sizer's own row must add no height.
        '& > dt:not(:first-of-type), & > dd:not(:first-of-type)': { paddingBlockStart: '2' },
        '&::after': {
          content: 'attr(data-label-sizer)',
          gridColumn: '1',
          whiteSpace: 'pre',
          height: '0',
          overflow: 'hidden',
          visibility: 'hidden',
        },
      })}
    >
      {rows.map((row) => (
        <Fragment key={row.key}>
          <dt className={css({ color: 'text-muted' })}>{row.label}</dt>
          <dd className={css({ margin: '0', minWidth: '0' })}>{row.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Name first; id, kind, topic scope and status (in the narrow list) underneath. */
export function ChatIdentity({
  row,
  facts,
  status,
}: {
  readonly row: ChatEntry;
  readonly facts: ChatFacts;
  readonly status?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const settings = shownSettings(row);
  const topics = settings === null ? null : facts.topics(settings);
  const topicsText = (value: ChatSettingsView): string =>
    value.topic_ids === null
      ? t('pages.chats.allTopics')
      : t('pages.chats.topicsLimited', { ids: value.topic_ids.join(facts.separator) });
  return (
    <div className={css({ minWidth: '0' })}>
      <p className={cx(css({ margin: '0', overflowWrap: 'anywhere' }), row.title === null ? quiet : undefined)}>
        <bdi>{row.title ?? t('pages.chats.unknownChat')}</bdi>
      </p>
      <div
        className={css({
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          columnGap: '3',
          rowGap: '1',
          minWidth: '0',
          textStyle: 'small',
          color: 'text-muted',
        })}
      >
        <MonoValue value={row.id} />
        <span>{facts.typeLabel(row)}</span>
        {/* An unrestricted scope only says something about groups. */}
        {settings === null || topics === null || (topics.source !== 'chat' && !isGroupChat(row)) ? null : (
          <span className={topics.source === 'chat' ? css({ color: 'text' }) : undefined}>{topicsText(settings)}</span>
        )}
        {status}
      </div>
      {row.runtime_chat_id !== row.id ? (
        <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
          {t('pages.chats.migratedTo', { id: row.runtime_chat_id })}
        </p>
      ) : null}
      <RunningNote value={facts.runningDiff(row, topicsText)} />
    </div>
  );
}

/** The model's name, then its provider and thinking effort; the full identifier sits in the full settings. */
export function ChatModelSummary({
  row,
  facts,
}: {
  readonly row: ChatEntry;
  readonly facts: ChatFacts;
}): ReactElement | null {
  const settings = shownSettings(row);
  if (settings === null) {
    return null;
  }
  const model = facts.model(settings);
  // A thinking effort set on its own stands out even when the model itself is inherited.
  const thinkingStandsOut = model.thinkingSource === 'chat' && model.modelSource !== 'chat';
  const thinkingInherited = model.thinkingSource !== 'chat' && model.modelSource === 'chat';
  return (
    <div className={css({ minWidth: '0' })}>
      <p
        title={model.id}
        className={cx(css({ margin: '0', overflowWrap: 'anywhere' }), model.modelSource === 'chat' ? undefined : quiet)}
      >
        <bdi>{model.name}</bdi>
        <InheritedMark source={model.modelSource} />
      </p>
      <p
        className={css({
          margin: '0',
          display: 'flex',
          flexWrap: 'wrap',
          columnGap: '3',
          textStyle: 'small',
          color: 'text-muted',
        })}
      >
        <TechText className={css({ overflowWrap: 'anywhere' })}>{model.provider}</TechText>
        <span className={thinkingStandsOut ? css({ color: 'text' }) : undefined}>
          {model.thinking}
          {thinkingInherited ? <InheritedMark source="global" /> : null}
        </span>
      </p>
      <RunningNote
        value={facts.runningDiff(row, (value) => {
          const running = facts.model(value);
          return `${running.id}${facts.separator}${running.thinking}`;
        })}
      />
    </div>
  );
}

/** The policy lines worth a glance: schedules, enabled features and whatever this Chat sets itself. */
export function compactPolicyRows(
  row: ChatEntry,
  facts: ChatFacts,
): readonly { readonly key: string; readonly label: string; readonly value: ReactNode }[] {
  const side = shownSide(row);
  if (side === null) {
    return [];
  }
  return facts.policy(row, side).flatMap((fact) =>
    fact.compact === null
      ? []
      : [
          {
            key: fact.key,
            label: fact.label,
            value: (
              <FactValue
                fact={fact}
                lines={fact.compact}
                source={fact.compactSource ?? fact.source}
                more={fact.compactMore}
              />
            ),
          },
        ],
  );
}

function compactPolicyText(row: ChatEntry, facts: ChatFacts, side: SettingsSide): string {
  return facts
    .policy(row, side)
    .flatMap((fact) => (fact.compact === null ? [] : [`${fact.label} ${fact.compact.join(facts.separator)}`]))
    .join(facts.separator);
}

/** The running policy summary, while a change to it waits for the file to apply. */
export function PolicyRunningNote({
  row,
  facts,
}: {
  readonly row: ChatEntry;
  readonly facts: ChatFacts;
}): ReactElement | null {
  return <RunningNote value={facts.runningDiff(row, (_, side) => compactPolicyText(row, facts, side))} />;
}

export function ChatPolicySummary({
  row,
  facts,
}: {
  readonly row: ChatEntry;
  readonly facts: ChatFacts;
}): ReactElement {
  const rows = compactPolicyRows(row, facts);
  return (
    <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
      {rows.length === 0 ? <span className={quiet}>—</span> : <FactRows rows={rows} labels={facts.compactLabels} />}
      <PolicyRunningNote row={row} facts={facts} />
    </div>
  );
}

export function ChatStatusBadge({ row }: { readonly row: ChatEntry }): ReactElement {
  const { t } = useTranslation();
  const status = chatStatus(row);
  return (
    <ToneBadge tone={status === 'active' ? 'success' : 'warning'}>
      {status === 'removalPending'
        ? t('pages.chats.removalPending')
        : status === 'additionPending'
          ? t('pages.chats.additionPending')
          : status === 'changesPending'
            ? t('pages.chats.changesPending')
            : t('pages.chats.active')}
    </ToneBadge>
  );
}

/** Edit stays one click away; everything else, removal last, waits in the row menu. */
export function ChatActions({
  row,
  view,
  handlers,
  inset = false,
}: {
  readonly row: ChatEntry;
  readonly view: ChatsView;
  readonly handlers: ChatRowHandlers;
  /**
   * In the narrow list the buttons stay inside the block; in a table cell they
   * reach into its padding so the last icon lines up with the column header.
   */
  readonly inset?: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  // A Chat already removed from the file only waits for the restart.
  if (row.saved === null) {
    return null;
  }
  const actions = (
    <>
      <IconButton
        variant="ghost"
        color="secondary"
        onClick={() => handlers.onEdit(row)}
        label={t('common.edit')}
        icon={<EditIcon />}
      />
      <ChatRowMenu
        row={row}
        onSchedule={handlers.onSchedule}
        onProactive={handlers.onProactive}
        onDecisionGate={handlers.onDecisionGate}
        onGroupMemory={handlers.onGroupMemory}
        onMcp={handlers.onMcp}
        onRemove={handlers.onRemove}
        // The allowlist never goes empty: the last saved Chat cannot be removed.
        removeDisabled={view.items.filter((item) => item.saved !== null).length <= 1}
      />
    </>
  );
  return inset ? (
    <div className={css({ display: 'flex', flexShrink: '0', alignItems: 'center' })}>{actions}</div>
  ) : (
    <RowActions>{actions}</RowActions>
  );
}

/**
 * Every setting of the shown side, each with its source and, when a change
 * waits to apply, the running value. A field only the running side has (the
 * file turned it off or removed it) still gets a row, so nothing the process
 * runs on is hidden.
 */
export function ChatSettingsDetails({
  row,
  facts,
}: {
  readonly row: ChatEntry;
  readonly facts: ChatFacts;
}): ReactElement | null {
  const { t } = useTranslation();
  const side = shownSide(row);
  const settings = shownSettings(row);
  if (side === null || settings === null) {
    return null;
  }
  const other: SettingsSide | null = side === 'saved' && row.active !== null ? 'active' : null;
  const shownFacts = facts.policy(row, side);
  const runningFacts = other === null ? [] : facts.policy(row, other);
  const running = (fact: ChatFact): string | null => {
    if (other === null) {
      return null;
    }
    const match = runningFacts.find((item) => item.key === fact.key);
    const text = match === undefined ? '—' : match.lines.join(facts.separator);
    return text === fact.lines.join(facts.separator) ? null : text;
  };
  const model = facts.model(settings);
  const runningModel = other === null || row.active === null ? null : facts.model(row.active);
  const topics = facts.topics(settings);
  const runningTopics = other === null || row.active === null ? null : facts.topics(row.active);
  const diff = (saved: string, active: string | undefined): string | null =>
    active === undefined || active === saved ? null : active;
  const items = [
    ...(isGroupChat(row) || topics.source === 'chat'
      ? [
          {
            label: topics.label,
            value: (
              <>
                <FactValue fact={topics} />
                <RunningNote value={diff(topics.lines.join(''), runningTopics?.lines.join(''))} />
              </>
            ),
          },
        ]
      : []),
    {
      label: t('pages.chats.colAgentModel'),
      value: (
        <>
          <div className={model.modelSource === 'chat' ? undefined : quiet}>
            <p className={css({ margin: '0' })}>
              <bdi>{model.name}</bdi>
              <InheritedMark source={model.modelSource} />
            </p>
            <MonoValue value={model.id} className={css({ textStyle: 'small', color: 'text-muted' })} />
          </div>
          <RunningNote value={diff(model.id, runningModel?.id)} />
        </>
      ),
    },
    {
      label: t('pages.chats.thinkingLabel'),
      value: (
        <>
          <p className={cx(css({ margin: '0' }), model.thinkingSource === 'chat' ? undefined : quiet)}>
            {model.thinkingLevel}
            <InheritedMark source={model.thinkingSource} />
          </p>
          <RunningNote value={diff(model.thinkingLevel, runningModel?.thinkingLevel)} />
        </>
      ),
    },
    ...shownFacts.map((fact) => ({
      label: fact.label,
      value: (
        <>
          <FactValue fact={fact} />
          <RunningNote value={running(fact)} />
        </>
      ),
    })),
    ...runningFacts
      .filter((fact) => !shownFacts.some((item) => item.key === fact.key))
      .map((fact) => ({
        label: fact.label,
        value: (
          <>
            <p className={cx(css({ margin: '0' }), quiet)}>—</p>
            <RunningNote value={fact.lines.join(facts.separator)} />
          </>
        ),
      })),
  ];
  return (
    <div data-chat-details="">
      <KvList items={items} />
    </div>
  );
}
