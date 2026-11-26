import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { JsonViewer, TimeText } from '@/components/business';
import type { AgentMessageEntry, ModelCallEntry, ToolCallEntry } from '@/lib/api/invocations.ts';
import { formatCost, formatDuration, formatNumber } from '@/lib/format';
import type { ToolOutcome } from '@/lib/invocation-chat.ts';
import { type DisclosurePart, ItemMeta } from './chat-parts';
import { ToolResult } from './tool-result';

/** What sits under a step's title: its text, its meta line and the panels behind it. */

const textClass = css({ textStyle: 'body', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' });
const errorClass = css({ color: 'error-text' });

/** What a tool handed back to the model: structured parts as they render, else text in the JSON viewer. */
export function ToolOutcomeView({ result }: { readonly result: ToolOutcome }): ReactElement {
  return result.content !== null ? <ToolResult content={result.content} /> : <JsonViewer value={result.text} />;
}

export function ToolStepFooter({
  tool,
  result,
  at,
}: {
  readonly tool: ToolCallEntry;
  readonly result: ToolOutcome | null;
  readonly at: string;
}): ReactElement {
  const { t } = useTranslation();
  const parts: DisclosurePart[] = [
    {
      key: 'arguments',
      label: t('invocations.invocationDetail.toolCall.arguments'),
      render: () => <JsonViewer value={tool.arguments_json} />,
    },
  ];
  if (result !== null) {
    parts.push({
      key: 'result',
      label: t('invocations.invocationDetail.toolCall.result'),
      render: () => <ToolOutcomeView result={result} />,
    });
  }
  return (
    <ItemMeta
      parts={parts}
      meta={
        <>
          <TimeText value={at} />
          <span>
            {t('invocations.invocationDetail.toolCall.duration', { value: formatDuration(tool.duration_ms) })}
          </span>
          {tool.error_code === null ? null : (
            <span className={errorClass}>
              {t('invocations.invocationDetail.toolCall.error', { code: tool.error_code })}
            </span>
          )}
          {result === null ? <span>{t('invocations.invocationDetail.chat.noResult')}</span> : null}
        </>
      }
    />
  );
}

export function ModelStepFooter({ model, at }: { readonly model: ModelCallEntry; readonly at: string }): ReactElement {
  const { t } = useTranslation();
  const payloadsMissing = model.request_json === null && model.response_json === null;
  const parts: DisclosurePart[] =
    model.error_detail === null && payloadsMissing
      ? []
      : [
          {
            key: 'details',
            label: t('invocations.invocationDetail.modelCall.viewDetails'),
            render: () => <ModelCallPanel model={model} />,
          },
        ];
  return (
    <ItemMeta
      parts={parts}
      meta={
        <>
          <TimeText value={at} />
          <span>{t('invocations.invocationDetail.modelCall.attempt', { value: model.attempt })}</span>
          <span>{t('invocations.invocationDetail.modelCall.tokens', { value: formatNumber(model.total_tokens) })}</span>
          <span>{t('invocations.invocationDetail.modelCall.cost', { value: formatCost(model.cost) })}</span>
          <span>
            {t('invocations.invocationDetail.modelCall.duration', { value: formatDuration(model.duration_ms) })}
          </span>
          {model.error_code === null ? null : (
            <span className={errorClass}>
              {t('invocations.invocationDetail.modelCall.error', { code: model.error_code })}
            </span>
          )}
          {payloadsMissing ? <span>{t('invocations.invocationDetail.modelCall.rawUnavailable')}</span> : null}
        </>
      }
    />
  );
}

function ModelCallPanel({ model }: { readonly model: ModelCallEntry }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
      {model.error_detail === null ? null : (
        <div>
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>
            {t('invocations.invocationDetail.modelCall.fullErrorDetails')}
          </p>
          <pre
            className={css({
              textStyle: 'small',
              color: 'error-text',
              marginBlockStart: '1',
              maxHeight: '240px',
              overflow: 'auto',
              borderRadius: 'lg',
              borderWidth: '1px',
              borderColor: 'border',
              bg: 'surface-muted',
              padding: '2',
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
            })}
          >
            {model.error_detail}
          </pre>
        </div>
      )}
      {model.request_json === null ? null : (
        <JsonViewer
          value={model.request_json}
          initiallyCollapsed
          title={t('invocations.invocationDetail.modelCall.requestPayload')}
          downloadFileName={`model-call-${model.id}-request.json`}
        />
      )}
      {model.response_json === null ? null : (
        <JsonViewer
          value={model.response_json}
          initiallyCollapsed
          title={t('invocations.invocationDetail.modelCall.responseStatus')}
        />
      )}
    </div>
  );
}

/** An agent step: its text in the open, thinking or the passed-on tool result behind a toggle. */
export function AgentStepFooter({
  message,
  at,
}: {
  readonly message: AgentMessageEntry;
  readonly at: string;
}): ReactElement {
  const { t } = useTranslation();
  const isResult = message.role === 'tool_result';
  const parts: DisclosurePart[] = [];
  if (isResult) {
    parts.push({
      key: 'result',
      label: t('invocations.invocationDetail.agent.viewToolResult'),
      render: () =>
        message.result_content ? (
          <ToolResult content={message.result_content} />
        ) : (
          <p dir="auto" className={textClass}>
            {message.text}
          </p>
        ),
    });
  } else if (message.thinking_text.length > 0) {
    parts.push({
      key: 'thinking',
      label: t('invocations.invocationDetail.agent.thinkingLabel'),
      render: () => (
        <p dir="auto" className={textClass}>
          {message.thinking_text}
        </p>
      ),
    });
  }
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1', minWidth: '0' })}>
      {isResult ? null : message.text.length === 0 ? (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {t('invocations.invocationDetail.agent.noText')}
        </p>
      ) : (
        <p dir="auto" className={textClass}>
          {message.text}
        </p>
      )}
      <ItemMeta parts={parts} meta={<TimeText value={at} />} />
    </div>
  );
}
