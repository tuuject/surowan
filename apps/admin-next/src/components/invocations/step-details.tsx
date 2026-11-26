import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { JsonViewer, LazyDetails } from '@/components/business';
import type { AgentMessageEntry, ModelCallEntry, ToolCallEntry } from '@/lib/api/invocations.ts';
import { formatCost, formatDuration, formatNumber } from '@/lib/format';
import type { ToolOutcome } from '@/lib/invocation-chat.ts';
import { ToolResult } from './tool-result';

/** The bodies of the Overview's steps: what a reader opens a step to check. */

const metaClass = css({
  textStyle: 'small',
  color: 'text-muted',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: '3',
  rowGap: '1',
});

const textClass = css({ textStyle: 'body', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' });

/** A tool step's body: its timing and error at a glance, arguments and result on demand. */
export function ToolStepDetails({
  tool,
  result,
}: {
  readonly tool: ToolCallEntry;
  readonly result: ToolOutcome | null;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
      <p className={metaClass}>
        <span>{t('invocations.invocationDetail.toolCall.duration', { value: formatDuration(tool.duration_ms) })}</span>
        {tool.error_code !== null ? (
          <span className={css({ color: 'error-text' })}>
            {t('invocations.invocationDetail.toolCall.error', { code: tool.error_code })}
          </span>
        ) : null}
      </p>
      <LazyDetails summary={t('invocations.invocationDetail.toolCall.arguments')}>
        <JsonViewer value={tool.arguments_json} />
      </LazyDetails>
      <ToolOutcomeDetails result={result} />
    </div>
  );
}

/** What the tool handed back to the model, behind a disclosure. */
export function ToolOutcomeDetails({ result }: { readonly result: ToolOutcome | null }): ReactElement {
  const { t } = useTranslation();
  if (result === null) {
    return (
      <p className={css({ textStyle: 'small', color: 'text-muted' })}>
        {t('invocations.invocationDetail.chat.noResult')}
      </p>
    );
  }
  return (
    <LazyDetails summary={t('invocations.invocationDetail.toolCall.result')}>
      {result.content !== null ? <ToolResult content={result.content} /> : <JsonViewer value={result.text} />}
    </LazyDetails>
  );
}

export function ModelStepDetails({ model }: { readonly model: ModelCallEntry }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
      <p className={metaClass}>
        <span>{t('invocations.invocationDetail.modelCall.attempt', { value: model.attempt })}</span>
        <span>{t('invocations.invocationDetail.modelCall.tokens', { value: formatNumber(model.total_tokens) })}</span>
        <span>{t('invocations.invocationDetail.modelCall.cost', { value: formatCost(model.cost) })}</span>
        <span>
          {t('invocations.invocationDetail.modelCall.duration', { value: formatDuration(model.duration_ms) })}
        </span>
        {model.error_code !== null ? (
          <span className={css({ color: 'error-text' })}>
            {t('invocations.invocationDetail.modelCall.error', { code: model.error_code })}
          </span>
        ) : null}
      </p>
      {model.error_detail !== null || model.request_json !== null || model.response_json !== null ? (
        <LazyDetails summary={t('invocations.invocationDetail.modelCall.viewDetails')}>
          {model.error_detail !== null ? (
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
          ) : null}
          {model.request_json !== null ? (
            <JsonViewer
              value={model.request_json}
              initiallyCollapsed
              title={t('invocations.invocationDetail.modelCall.requestPayload')}
              downloadFileName={`model-call-${model.id}-request.json`}
            />
          ) : null}
          {model.response_json !== null ? (
            <JsonViewer
              value={model.response_json}
              initiallyCollapsed
              title={t('invocations.invocationDetail.modelCall.responseStatus')}
            />
          ) : null}
        </LazyDetails>
      ) : null}
      {model.request_json === null && model.response_json === null ? (
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>
          {t('invocations.invocationDetail.modelCall.rawUnavailable')}
        </p>
      ) : null}
    </div>
  );
}

export function AgentStepBody({ message }: { readonly message: AgentMessageEntry }): ReactElement {
  const { t } = useTranslation();
  if (message.result_content) {
    return <ToolResult content={message.result_content} />;
  }
  if (message.role === 'tool_result') {
    return (
      <LazyDetails summary={t('invocations.invocationDetail.agent.viewToolResult')}>
        <p dir="auto" className={textClass}>
          {message.text}
        </p>
      </LazyDetails>
    );
  }
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
      {message.thinking_text.length > 0 ? (
        <LazyDetails summary={t('invocations.invocationDetail.agent.thinkingLabel')}>
          <p dir="auto" className={textClass}>
            {message.thinking_text}
          </p>
        </LazyDetails>
      ) : null}
      {message.text.length === 0 ? (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {t('invocations.invocationDetail.agent.noText')}
        </p>
      ) : (
        <p dir="auto" className={textClass}>
          {message.text}
        </p>
      )}
    </div>
  );
}
