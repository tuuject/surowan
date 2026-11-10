import { css } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, JsonViewer, StateBadge, TableShell, TextValue } from '@/components/business';
import { TabContent } from '@/components/invocations/shared';
import type { InvocationDetail, ModelCallEntry } from '@/lib/api/invocations.ts';
import { formatCost, formatDuration, formatNumber } from '@/lib/format';

export function ModelCallsTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  const { t } = useTranslation();
  const MODEL_CALL_COLUMNS: readonly ColumnSpec<ModelCallEntry>[] = [
    { key: 'role', title: t('invocations.invocationDetail.modelColumns.role'), render: (row) => row.role },
    { key: 'provider', title: t('invocations.invocationDetail.modelColumns.provider'), render: (row) => row.provider },
    { key: 'model', title: t('invocations.invocationDetail.modelColumns.model'), render: (row) => row.model },
    {
      key: 'attempt',
      title: t('invocations.invocationDetail.modelColumns.attempt'),
      align: 'right',
      render: (row) => String(row.attempt),
    },
    {
      key: 'tools',
      title: t('invocations.invocationDetail.modelColumns.toolsInRequest'),
      render: (row) =>
        row.tools === null ? (
          <TextValue value={null} />
        ) : (
          <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '1' })}>
            {row.tools.map((name) => (
              <code
                key={name}
                className={css({
                  textStyle: 'small',
                  borderRadius: 'lg',
                  bg: 'surface-muted',
                  paddingInline: '1',
                  paddingBlock: '1',
                  fontFamily: 'mono',
                })}
              >
                {name}
              </code>
            ))}
          </div>
        ),
    },
    {
      key: 'state',
      title: t('invocations.invocationDetail.modelColumns.state'),
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'input',
      title: t('invocations.invocationDetail.modelColumns.input'),
      align: 'right',
      render: (row) => formatNumber(row.input_tokens),
    },
    {
      key: 'output',
      title: t('invocations.invocationDetail.modelColumns.output'),
      align: 'right',
      render: (row) => formatNumber(row.output_tokens),
    },
    {
      key: 'cache-read',
      title: t('invocations.invocationDetail.modelColumns.cacheRead'),
      align: 'right',
      render: (row) => formatNumber(row.cache_read_tokens),
    },
    {
      key: 'cache-write',
      title: t('invocations.invocationDetail.modelColumns.cacheWrite'),
      align: 'right',
      render: (row) => formatNumber(row.cache_write_tokens),
    },
    {
      key: 'total',
      title: t('invocations.invocationDetail.modelColumns.total'),
      align: 'right',
      render: (row) => formatNumber(row.total_tokens),
    },
    {
      key: 'cost',
      title: t('invocations.invocationDetail.modelColumns.cost'),
      align: 'right',
      render: (row) => formatCost(row.cost),
    },
    {
      key: 'duration',
      title: t('invocations.invocationDetail.modelColumns.duration'),
      align: 'right',
      render: (row) => formatDuration(row.duration_ms),
    },
    {
      key: 'error',
      title: t('invocations.invocationDetail.modelColumns.error'),
      render: (row) => <TextValue value={row.error_code} />,
    },
  ];
  return (
    <TabContent count={invocation.model_calls.length} message={t('invocations.invocationDetail.emptyModelCalls')}>
      <p className={css({ textStyle: 'small', color: 'text-muted' })}>
        {t('invocations.invocationDetail.modelsTokensNote')}{' '}
        <code className={css({ fontFamily: 'mono' })}>provider_total_tokens</code>.
      </p>
      <p className={css({ textStyle: 'small', color: 'text-muted' })}>
        {t('invocations.invocationDetail.modelsNote2')}
      </p>
      <TableShell
        columns={MODEL_CALL_COLUMNS}
        data={invocation.model_calls}
        rowKey={(row) => row.id}
        isExpandable={(row) => row.error_detail !== null || row.request_json !== null || row.response_json !== null}
        expandedRender={(row) => (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
            {row.request_json !== null ? (
              <JsonViewer
                value={row.request_json}
                title={t('invocations.invocationDetail.modelCall.requestPayload')}
                downloadFileName={`model-call-${row.id}-request.json`}
              />
            ) : null}
            {row.response_json !== null ? (
              <JsonViewer
                value={row.response_json}
                title={t('invocations.invocationDetail.modelCall.responseStatus')}
              />
            ) : null}
            {row.error_detail !== null ? (
              <div>
                <p className={css({ textStyle: 'small', color: 'text-muted', marginBlockEnd: '1' })}>
                  {t('invocations.invocationDetail.modelCall.fullErrorDetails')}
                </p>
                <pre
                  className={css({
                    textStyle: 'small',
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
                  {row.error_detail}
                </pre>
              </div>
            ) : null}
          </div>
        )}
      />
    </TabContent>
  );
}
