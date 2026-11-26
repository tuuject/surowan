import { ErrorIcon, SearchIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import type { TFunction } from 'i18next';
import { type ReactElement, type ReactNode, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { StateBadge, TechText } from '@/components/business';
import {
  AlarmIcon,
  BookOpenIcon,
  BrainIcon,
  ChatTextIcon,
  disclosureChevronClass,
  LibraryIcon,
  NextIcon,
  PulseIcon,
  ScrollIcon,
  WrenchIcon,
} from '@/components/icons.tsx';
import { ReviewableItem } from '@/components/review/comment-note.tsx';
import type { InvocationDetail } from '@/lib/api/invocations.ts';
import type { ChatItem, ChatStep, StepAction, StepSummary } from '@/lib/invocation-chat.ts';
import { timelineEventKey } from '@/lib/timeline.ts';
import { useReviewStore } from '@/stores/review.ts';
import { AgentStepFooter, ModelStepFooter, ToolStepFooter } from './step-details';

type StepsItem = Extract<ChatItem, { readonly kind: 'steps' }>;

/**
 * A native disclosure that mounts its content on first open and keeps it, so a
 * half-written comment survives closing. Starts open when asked to, e.g. to
 * show a saved comment inside.
 */
export function ChatDisclosure({
  summary,
  defaultOpen,
  children,
}: {
  readonly summary: ReactNode;
  readonly defaultOpen: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [opened, setOpened] = useState(defaultOpen);
  return (
    <details
      open={open}
      data-chat-disclosure=""
      className={css({ minWidth: '0' })}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) {
          setOpened(true);
        }
      }}
    >
      <summary
        className={css({
          display: 'inline-flex',
          alignItems: 'center',
          gap: '2',
          maxWidth: '100%',
          color: 'text-muted',
          cursor: 'pointer',
          listStyle: 'none',
          borderRadius: 'lg',
          transitionProperty: 'color',
          transitionDuration: 'fast',
          '&::-webkit-details-marker': { display: 'none' },
          _hover: { color: 'text' },
          _focusVisible: { outline: '2px solid', outlineColor: 'focus-ring', outlineOffset: '2px' },
        })}
      >
        <NextIcon size={sizes['icon-sm']} className={disclosureChevronClass} />
        {summary}
      </summary>
      {opened ? <div className={css({ marginBlockStart: '3', minWidth: '0' })}>{children}</div> : null}
    </details>
  );
}

function summaryText(t: TFunction, summary: StepSummary, visibleSteps: number): string {
  const parts = [
    summary.tools > 0 ? t('invocations.invocationDetail.chat.summaryTools', { count: summary.tools }) : null,
    summary.skills > 0 ? t('invocations.invocationDetail.chat.summarySkills', { count: summary.skills }) : null,
    summary.failedModelCalls > 0
      ? t('invocations.invocationDetail.chat.summaryFailedModelCalls', { count: summary.failedModelCalls })
      : null,
    summary.privateTexts > 0
      ? t('invocations.invocationDetail.chat.summaryPrivateTexts', { count: summary.privateTexts })
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0
    ? t('invocations.invocationDetail.chat.summarySteps', { count: visibleSteps })
    : parts.join(t('invocations.invocationDetail.chat.summarySeparator'));
}

const nameClass = css({ fontFamily: 'mono' });

type NamedStepKey =
  | 'invocations.invocationDetail.chat.skill'
  | 'invocations.invocationDetail.chat.tool'
  | 'invocations.invocationDetail.chat.toolHelp'
  | 'invocations.invocationDetail.chat.modelCall';

function StepLabel({ action, step }: { readonly action: StepAction; readonly step: ChatStep }): ReactElement {
  const { t } = useTranslation();
  const named = (key: NamedStepKey, name: string): ReactElement => (
    <Trans i18nKey={key} values={{ name }} components={{ name: <TechText className={nameClass} /> }} />
  );
  switch (action.kind) {
    case 'skill':
      return named('invocations.invocationDetail.chat.skill', action.name);
    case 'tool':
      return named('invocations.invocationDetail.chat.tool', action.name);
    case 'tool_help':
      return named('invocations.invocationDetail.chat.toolHelp', action.name);
    case 'tool_search':
      return <span dir="auto">{t('invocations.invocationDetail.chat.toolSearch', { query: action.query })}</span>;
    case 'private_text':
      return <>{t('invocations.invocationDetail.agentRoles.assistantLabel')}</>;
    case 'nudge':
      return <>{t('invocations.invocationDetail.agentRoles.harnessNudgeLabel')}</>;
    case 'tool_result':
      return <>{t('invocations.invocationDetail.agentRoles.toolResultLabel')}</>;
    case 'agent_note':
      return <TechText className={nameClass}>{action.role}</TechText>;
    case 'model_call': {
      const name = step.event.kind === 'model_call' ? `${step.event.model.provider}/${step.event.model.model}` : '';
      // A failed call is marked by its icon and state badge.
      return named('invocations.invocationDetail.chat.modelCall', name);
    }
  }
}

function stepIcon(action: StepAction): ReactElement {
  const props = { size: sizes['icon-sm'], className: css({ flexShrink: '0' }) };
  switch (action.kind) {
    case 'skill':
      return <LibraryIcon {...props} />;
    case 'tool':
      return <WrenchIcon {...props} />;
    case 'tool_search':
      return <SearchIcon {...props} />;
    case 'tool_help':
      return <BookOpenIcon {...props} />;
    case 'private_text':
      return <BrainIcon {...props} />;
    case 'nudge':
      return <AlarmIcon {...props} />;
    case 'tool_result':
      return <ScrollIcon {...props} />;
    case 'agent_note':
      return <ChatTextIcon {...props} />;
    case 'model_call':
      return action.failed ? <ErrorIcon {...props} /> : <PulseIcon {...props} />;
  }
}

function StepFooter({ step }: { readonly step: ChatStep }): ReactElement {
  switch (step.event.kind) {
    case 'tool_call':
      return <ToolStepFooter tool={step.event.tool} result={step.result} at={step.event.at} />;
    case 'model_call':
      return <ModelStepFooter model={step.event.model} at={step.event.at} />;
    case 'agent_message':
      return <AgentStepFooter message={step.event.message} at={step.event.at} />;
  }
}

function stepState(step: ChatStep): string | null {
  switch (step.event.kind) {
    case 'tool_call':
      return step.event.tool.state;
    case 'model_call':
      return step.event.model.state;
    case 'agent_message':
      return null;
  }
}

function StepRow({
  invocation,
  step,
}: {
  readonly invocation: InvocationDetail;
  readonly step: ChatStep;
}): ReactElement {
  const state = stepState(step);
  return (
    <li>
      <ReviewableItem
        invocation={invocation}
        event={step.event}
        position={step.position}
        footer={
          // Indented by the icon and its gap, so the body lines up with the title text.
          <div className={css({ width: '100%', minWidth: '0', paddingInlineStart: '6' })}>
            <StepFooter step={step} />
          </div>
        }
      >
        <span
          className={css({
            display: 'inline-flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: '2',
            rowGap: '1',
            minWidth: '0',
            textStyle: 'body',
          })}
        >
          {stepIcon(step.action)}
          <span className={css({ overflowWrap: 'anywhere' })}>
            <StepLabel action={step.action} step={step} />
          </span>
          {state !== null && state !== 'success' ? <StateBadge state={state} /> : null}
        </span>
      </ReviewableItem>
    </li>
  );
}

/**
 * Everything the model did between two replies, collapsed to one line. Steps a
 * reader rarely needs stay hidden unless a review comment is attached to them.
 */
export function StepGroup({
  invocation,
  item,
}: {
  readonly invocation: InvocationDetail;
  readonly item: StepsItem;
}): ReactElement | null {
  const { t } = useTranslation();
  const comments = useReviewStore((state) => state.invocations[invocation.id]?.comments);
  const commented = (step: ChatStep): boolean => comments?.[timelineEventKey(step.event)] !== undefined;
  const visible = item.steps.filter((step) => !step.secondary || commented(step));
  if (visible.length === 0) {
    return null;
  }
  return (
    <ChatDisclosure summary={summaryText(t, item.summary, visible.length)} defaultOpen={visible.some(commented)}>
      <ol
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '3',
          marginInlineStart: '2',
          paddingInlineStart: '4',
          borderInlineStartWidth: '1px',
          borderColor: 'divider',
        })}
      >
        {visible.map((step) => (
          <StepRow key={timelineEventKey(step.event)} invocation={invocation} step={step} />
        ))}
      </ol>
    </ChatDisclosure>
  );
}
