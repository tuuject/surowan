import { Eye, Lightbulb, Pencil, Trash2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type BadgeSemantic,
  type ColumnSpec,
  FLUSH_TABLE_CLASS,
  MonoValue,
  TableShell,
  ToneBadge,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Button } from '@/components/ui/button';

import { formatDuration, formatNumber } from '@/lib/format.ts';
import { isImageCapable, isTextCapable, modelUsage } from '@/lib/model-manager.ts';
import type {
  HealthCheckResult,
  HealthCheckStatus,
  ProviderApi,
  ProviderModelConfig,
  ProvidersView,
} from '@/lib/api/providers.ts';

export interface ModelRow {
  readonly alias: string;
  readonly api: ProviderApi;
  readonly model: ProviderModelConfig;
}

const HEALTH_TONES: Record<HealthCheckStatus, BadgeSemantic> = {
  ok: 'success',
  unexpected_response: 'warning',
  error: 'danger',
};

/** The selected provider's models, with health probes and the per-row actions. */
export function ModelTable({
  view,
  rows,
  health,
  healthSelected,
  onHealthSelectedChange,
  running,
  onRunHealthChecks,
  runnableSelected,
  agentPending,
  visionPending,
  onSetAgent,
  onSetVision,
  onEdit,
  onDeleteModel,
  onFetchModels,
  onAddById,
}: {
  readonly view: ProvidersView;
  readonly rows: readonly ModelRow[];
  readonly health: Record<string, HealthCheckResult | 'checking'>;
  readonly healthSelected: ReadonlySet<string>;
  readonly onHealthSelectedChange: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly running: boolean;
  readonly onRunHealthChecks: (keys: readonly string[]) => Promise<void>;
  readonly runnableSelected: readonly string[];
  readonly agentPending: boolean;
  readonly visionPending: boolean;
  readonly onSetAgent: (alias: string, model: string) => void;
  readonly onSetVision: (alias: string, model: string) => void;
  readonly onEdit: (alias: string, model: ProviderModelConfig) => void;
  readonly onDeleteModel: (alias: string, model: string) => void;
  readonly onFetchModels: () => void;
  readonly onAddById: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const rowKey = (row: ModelRow): string => `${row.alias}/${row.model.id}`;
  const allSelected = rows.length > 0 && rows.every((row) => healthSelected.has(rowKey(row)));

  const columns: readonly ColumnSpec<ModelRow>[] = [
    {
      key: 'select',
      title: '',
      render: (row) => {
        const key = rowKey(row);
        return (
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            aria-label={t('models.models.page.selectForHealthAria', { model: row.model.id })}
            checked={healthSelected.has(key)}
            disabled={running}
            onChange={() => {
              onHealthSelectedChange((previous) => {
                const next = new Set(previous);
                if (next.has(key)) {
                  next.delete(key);
                } else {
                  next.add(key);
                }
                return next;
              });
            }}
          />
        );
      },
    },
    {
      key: 'model',
      title: t('models.models.page.colModel'),
      className: 'max-w-96 min-w-48 whitespace-normal',
      render: (row) => (
        <div className="space-y-0.5">
          <MonoValue value={row.model.id} />
          <p className="text-muted-foreground truncate text-xs">{row.model.name ?? '—'}</p>
        </div>
      ),
    },
    {
      key: 'flags',
      title: t('models.models.page.colFlags'),
      render: (row) => (
        <span className="text-muted-foreground flex items-center gap-1.5">
          {isImageCapable(row.model) ? (
            <>
              <Eye className="size-[1.15em]" aria-hidden="true" />
              <span className="sr-only">{t('models.models.page.srOnlyImage')}</span>
            </>
          ) : null}
          {row.model.reasoning ? (
            <>
              <Lightbulb className="size-[1.15em]" aria-hidden="true" />
              <span className="sr-only">{t('models.models.page.srOnlyReasoning')}</span>
            </>
          ) : null}
        </span>
      ),
    },
    {
      key: 'context',
      title: t('models.models.page.colContext'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.model.context_window),
    },
    {
      key: 'max_tokens',
      title: t('models.models.page.colMaxOutput'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.model.max_tokens),
    },
    {
      key: 'usage',
      title: t('models.models.page.colInUse'),
      render: (row) => {
        const usage = modelUsage(view, row.alias, row.model.id);
        if (usage === null) {
          return <span className="text-muted-foreground">—</span>;
        }
        return (
          <span className="flex flex-wrap items-center gap-1">
            {usage === 'agent' || usage === 'both' ? (
              <ToneBadge tone="success">{t('models.models.page.agentBadge')}</ToneBadge>
            ) : null}
            {usage === 'vision' || usage === 'both' ? (
              <ToneBadge tone="info">{t('models.models.page.visionBadge')}</ToneBadge>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'health',
      title: t('models.models.page.colHealth'),
      render: (row) => {
        const entry = health[rowKey(row)];
        if (entry === undefined) {
          return <span className="text-muted-foreground">—</span>;
        }
        if (entry === 'checking') {
          return <ToneBadge tone="info">{t('models.models.page.checking')}</ToneBadge>;
        }
        const label =
          entry.status === 'ok'
            ? t('models.models.page.healthOk')
            : entry.status === 'unexpected_response'
              ? t('models.models.page.healthUnexpected')
              : t('models.models.page.healthError');
        return (
          <div className="space-y-1">
            <ToneBadge tone={HEALTH_TONES[entry.status]}>{label}</ToneBadge>
            <p className="text-muted-foreground text-xs tabular-nums">
              {t('models.models.page.healthTiming', {
                ttfb: entry.ttfb_ms === null ? t('models.models.page.ttfbUnavailable') : formatDuration(entry.ttfb_ms),
                duration: formatDuration(entry.duration_ms),
              })}
            </p>
          </div>
        );
      },
    },
    {
      key: 'actions',
      title: t('models.models.page.colActions'),
      align: 'right',
      render: (row) => {
        const usage = modelUsage(view, row.alias, row.model.id);
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!isTextCapable(row.model) || usage === 'agent' || usage === 'both' || agentPending}
              onClick={() => onSetAgent(row.alias, row.model.id)}
            >
              {t('models.models.page.setAsAgent')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!isImageCapable(row.model) || usage === 'vision' || usage === 'both' || visionPending}
              onClick={() => onSetVision(row.alias, row.model.id)}
            >
              {t('models.models.page.setAsVision')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={running}
              aria-label={t('models.models.page.checkHealthAria', { model: row.model.id })}
              onClick={() => void onRunHealthChecks([rowKey(row)])}
            >
              {t('models.models.page.checkHealth')}
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('models.models.page.editModelAria', { model: row.model.id })}
              onClick={() => onEdit(row.alias, row.model)}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              aria-label={t('models.models.page.deleteModelAria', { model: row.model.id })}
              disabled={usage !== null}
              onClick={() => onDeleteModel(row.alias, row.model.id)}
            >
              <Trash2 />
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <Panel
      title={t('models.models.page.modelsTitle')}
      flush
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onFetchModels}>
            {t('models.models.page.fetchModels')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onAddById}>
            {t('models.models.page.addById')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={runnableSelected.length === 0 || running}
            onClick={() => void onRunHealthChecks(runnableSelected)}
          >
            {t('models.models.page.checkSelected', { count: runnableSelected.length })}
          </Button>
        </div>
      }
    >
      {/* Flush: the panel is the frame, so the table only keeps the
          rule under the header. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 pb-3">
        <p className="text-muted-foreground min-w-0 text-xs">{t('models.models.page.healthCheckNote')}</p>
        <label className="text-muted-foreground flex shrink-0 cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            ref={(element) => {
              if (element !== null) {
                element.indeterminate = !allSelected && rows.some((row) => healthSelected.has(rowKey(row)));
              }
            }}
            checked={allSelected}
            disabled={running || rows.length === 0}
            onChange={() => {
              onHealthSelectedChange((previous) => {
                const next = new Set(previous);
                for (const row of rows) {
                  const key = rowKey(row);
                  if (allSelected) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                }
                return next;
              });
            }}
          />
          {t('models.models.page.selectAllForHealth')}
        </label>
      </div>
      <TableShell
        columns={columns}
        data={rows}
        rowKey={rowKey}
        className={FLUSH_TABLE_CLASS}
        emptyText={t('models.models.page.emptyModels')}
        expandedRender={(row) => {
          const entry = health[rowKey(row)];
          if (entry === undefined || entry === 'checking') {
            return null;
          }
          const error = entry.error !== null && entry.error.length > 0 ? entry.error : null;
          const text = entry.response_text.length > 0 ? entry.response_text : null;
          if (error === null && text === null) {
            return null;
          }
          return (
            <div className="max-h-64 max-w-3xl space-y-2 overflow-auto whitespace-normal">
              {error === null ? null : <p className="text-destructive text-sm break-words">{error}</p>}
              {text === null ? null : (
                <p className="text-muted-foreground text-sm break-words whitespace-pre-wrap">{text}</p>
              )}
            </div>
          );
        }}
        isExpandable={(row) => {
          const entry = health[rowKey(row)];
          if (entry === undefined || entry === 'checking') {
            return false;
          }
          return (entry.error !== null && entry.error.length > 0) || entry.response_text.length > 0;
        }}
      />
    </Panel>
  );
}
