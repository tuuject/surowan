import { TrashIcon } from '@tuuject/koi-react/icons';
import { Menu } from '@tuuject/koi-react/menu';
import { EditIcon, EyeIcon, HealthIcon, LightbulbIcon, MoreIcon } from '@/components/icons';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type BadgeSemantic,
  type ColumnSpec,
  ListFooter,
  ListToolbar,
  MonoValue,
  RowActions,
  TableShell,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { Button, IconButton } from '@tuuject/koi-react/button';
import type {
  HealthCheckResult,
  HealthCheckStatus,
  ProviderApi,
  ProviderModelConfig,
  ProvidersView,
} from '@/lib/api/providers.ts';
import { formatDuration, formatNumber } from '@/lib/format.ts';
import { isImageCapable, isTextCapable, modelUsage } from '@/lib/model-manager.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

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
  const pagination = useClientPagination(rows, rows[0]?.alias ?? 'no-provider');
  const rowKey = (row: ModelRow): string => `${row.alias}/${row.model.id}`;

  const columns: readonly ColumnSpec<ModelRow>[] = [
    {
      key: 'model',
      title: t('models.models.page.colModel'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div className={css({ truncate: true })}>
            <MonoValue value={row.model.id} />
          </div>
          <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted', truncate: true })}>
            {row.model.name ?? '—'}
          </p>
        </div>
      ),
    },
    {
      key: 'flags',
      title: t('models.models.page.colFlags'),
      width: 88,
      render: (row) => (
        <span className={css({ color: 'text-muted', display: 'flex', alignItems: 'center', gap: '2' })}>
          {isImageCapable(row.model) ? (
            <>
              <EyeIcon aria-hidden="true" />
              <span className={css({ srOnly: true })}>{t('models.models.page.srOnlyImage')}</span>
            </>
          ) : null}
          {row.model.reasoning ? (
            <>
              <LightbulbIcon aria-hidden="true" />
              <span className={css({ srOnly: true })}>{t('models.models.page.srOnlyReasoning')}</span>
            </>
          ) : null}
        </span>
      ),
    },
    {
      key: 'context',
      title: t('models.models.page.colContext'),
      align: 'right',
      width: 104,
      render: (row) => formatNumber(row.model.context_window),
    },
    {
      key: 'max_tokens',
      title: t('models.models.page.colMaxOutput'),
      align: 'right',
      width: 112,
      render: (row) => formatNumber(row.model.max_tokens),
    },
    {
      key: 'usage',
      title: t('models.models.page.colInUse'),
      width: 136,
      render: (row) => {
        const usage = modelUsage(view, row.alias, row.model.id);
        if (usage === null) {
          return <span className={css({ color: 'text-muted' })}>—</span>;
        }
        return (
          <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1' })}>
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
      width: 168,
      render: (row) => {
        const entry = health[rowKey(row)];
        if (entry === undefined) {
          return <span className={css({ color: 'text-muted' })}>—</span>;
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
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <ToneBadge tone={HEALTH_TONES[entry.status]}>{label}</ToneBadge>
            <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
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
      width: 176,
      paddingBlock: 'none',
      render: (row) => {
        const usage = modelUsage(view, row.alias, row.model.id);
        return (
          <RowActions>
            <IconButton
              variant="ghost"
              color="secondary"
              disabled={running}
              label={t('models.models.page.checkHealthAria', { model: row.model.id })}
              icon={<HealthIcon />}
              onClick={() => void onRunHealthChecks([rowKey(row)])}
            />
            <Menu
              placement="bottom-end"
              trigger={
                <IconButton
                  variant="ghost"
                  color="secondary"
                  label={t('models.models.page.moreActionsAria', { model: row.model.id })}
                  icon={<MoreIcon />}
                />
              }
              items={[
                {
                  value: 'agent',
                  label: t('models.models.page.setAsAgent'),
                  disabled: !isTextCapable(row.model) || usage === 'agent' || usage === 'both' || agentPending,
                  onSelect: () => onSetAgent(row.alias, row.model.id),
                },
                {
                  value: 'vision',
                  label: t('models.models.page.setAsVision'),
                  disabled: !isImageCapable(row.model) || usage === 'vision' || usage === 'both' || visionPending,
                  onSelect: () => onSetVision(row.alias, row.model.id),
                },
              ]}
            />
            <IconButton
              variant="ghost"
              color="secondary"
              onClick={() => onEdit(row.alias, row.model)}
              label={t('models.models.page.editModelAria', { model: row.model.id })}
              icon={<EditIcon />}
            />
            <IconButton
              variant="ghost"
              color="error"
              disabled={usage !== null}
              onClick={() => onDeleteModel(row.alias, row.model.id)}
              label={t('models.models.page.deleteModelAria', { model: row.model.id })}
              icon={<TrashIcon />}
            />
          </RowActions>
        );
      },
    },
  ];

  return (
    <section className={css({ '& > * + *': { marginBlockStart: '5' } })}>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
        <h2 className={css({ margin: '0', textStyle: 'heading-2' })}>{t('models.models.page.modelsTitle')}</h2>
        <p className={css({ margin: '0', color: 'text-muted', maxWidth: 'content-max' })}>
          {t('models.models.page.healthCheckNote')}
        </p>
      </div>
      <ListToolbar
        trailing={
          healthSelected.size > 0 ? (
            <span className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('models.models.page.selectedCount', { count: runnableSelected.length })}
            </span>
          ) : null
        }
      >
        <Button variant="outline" color="secondary" onClick={onFetchModels}>
          {t('models.models.page.fetchModels')}
        </Button>
        <Button variant="outline" color="secondary" onClick={onAddById}>
          {t('models.models.page.addById')}
        </Button>
        <Button
          variant="outline"
          color="secondary"
          iconStart={<HealthIcon />}
          disabled={runnableSelected.length === 0 || running}
          onClick={() => void onRunHealthChecks(runnableSelected)}
        >
          {t('models.models.page.checkSelected', { count: runnableSelected.length })}
        </Button>
      </ListToolbar>
      <div>
        <TableShell
          columns={columns}
          data={pagination.items}
          rowKey={rowKey}
          minWidth={1040}
          selection={{
            selected: healthSelected,
            disabled: running,
            onToggle: (row, checked) =>
              onHealthSelectedChange((previous) => {
                const next = new Set(previous);
                if (checked) {
                  next.add(rowKey(row));
                } else {
                  next.delete(rowKey(row));
                }
                return next;
              }),
            onToggleAll: (checked) =>
              onHealthSelectedChange((previous) => {
                const next = new Set(previous);
                for (const row of rows) {
                  if (checked) {
                    next.add(rowKey(row));
                  } else {
                    next.delete(rowKey(row));
                  }
                }
                return next;
              }),
            allLabel: t('models.models.page.selectAllForHealth'),
            rowLabel: (row) => t('models.models.page.selectForHealthAria', { model: row.model.id }),
          }}
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
              <div
                className={css({
                  maxHeight: '256px',
                  maxWidth: '48rem',
                  '& > :not(:last-child)': { marginBlockEnd: '2' },
                  overflow: 'auto',
                  whiteSpace: 'normal',
                })}
              >
                {error === null ? null : (
                  <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>{error}</p>
                )}
                {text === null ? null : (
                  <p
                    className={css({
                      textStyle: 'body',
                      color: 'text-muted',
                      overflowWrap: 'anywhere',
                      whiteSpace: 'pre-wrap',
                    })}
                  >
                    {text}
                  </p>
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
        <ListFooter
          count={pagination.total}
          page={pagination.page}
          pageCount={pagination.pageCount}
          onPageChange={pagination.onPageChange}
        />
      </div>
    </section>
  );
}
