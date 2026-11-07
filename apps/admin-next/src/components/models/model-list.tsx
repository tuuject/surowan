import { Button, IconButton } from '@tuuject/koi-react/button';
import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Empty } from '@tuuject/koi-react/empty';
import { ChevronDownIcon, ChevronRightIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { Menu } from '@tuuject/koi-react/menu';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type BadgeSemantic,
  ListFooter,
  MonoValue,
  RowActions,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { EditIcon, EyeIcon, HealthIcon, LightbulbIcon, MoreIcon } from '@/components/icons';
import { Panel } from '@/components/layout/panel';
import type {
  HealthCheckResult,
  HealthCheckStatus,
  ProviderApi,
  ProviderModelConfig,
  ProvidersView,
} from '@/lib/api/providers.ts';
import { formatDuration, formatNumber } from '@/lib/format.ts';
import { isImageCapable, isTextCapable, modelUsage } from '@/lib/model-manager.ts';

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

/** One value in the metadata line; the label stays muted, the value carries the contrast. */
function Metric({ label, value }: { readonly label: string; readonly value: React.ReactNode }): React.ReactElement {
  return (
    <span className={css({ whiteSpace: 'nowrap' })}>
      {label} <span className={css({ color: 'text' })}>{value}</span>
    </span>
  );
}

/**
 * The selected provider's models as a vertical list: identity and capability
 * on the first line, the numbers on the second, health and row actions beside
 * them. The list is the provider detail's main area, so it stacks instead of
 * spreading six columns across the pane.
 */
export function ModelList({
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rowKey = (row: ModelRow): string => `${row.alias}/${row.model.id}`;

  const toggleExpanded = (key: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const selectable = pagination.items;
  const allSelected = selectable.length > 0 && selectable.every((row) => healthSelected.has(rowKey(row)));

  return (
    <Panel
      variant="plain"
      className={css({ borderTopWidth: '1px', borderColor: 'divider', paddingBlockStart: '8' })}
      title={t('models.models.page.modelsTitle')}
      description={t('models.models.page.healthCheckNote')}
      action={
        <>
          <Button variant="outline" color="secondary" onClick={onFetchModels}>
            {t('models.models.page.fetchModels')}
          </Button>
          <Button variant="outline" color="secondary" onClick={onAddById}>
            {t('models.models.page.addById')}
          </Button>
        </>
      }
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        <div
          className={css({
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '3',
          })}
        >
          <Checkbox
            label={t('models.models.page.selectAllForHealth')}
            checked={allSelected}
            disabled={running || selectable.length === 0}
            onCheckedChange={(checked) =>
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
              })
            }
          />
          <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
            {healthSelected.size === 0 ? null : (
              <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t('models.models.page.selectedCount', { count: runnableSelected.length })}
              </span>
            )}
            <Button
              variant="outline"
              color="secondary"
              iconStart={<HealthIcon />}
              disabled={runnableSelected.length === 0 || running}
              onClick={() => void onRunHealthChecks(runnableSelected)}
            >
              {t('models.models.page.checkSelected', { count: runnableSelected.length })}
            </Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <Empty title={t('models.models.page.emptyModels')} />
        ) : (
          <ul
            data-model-list
            className={css({
              margin: '0',
              padding: '0',
              '& > li:not(:last-child)': { borderBottomWidth: '1px', borderColor: 'divider' },
            })}
          >
            {pagination.items.map((row) => {
              const key = rowKey(row);
              const usage = modelUsage(view, row.alias, row.model.id);
              const entry = health[key];
              const result = entry === undefined || entry === 'checking' ? null : entry;
              const open = expanded.has(key);
              const expandable =
                result !== null &&
                ((result.error !== null && result.error.length > 0) || result.response_text.length > 0);
              return (
                <li
                  key={key}
                  className={css({ display: 'flex', alignItems: 'flex-start', gap: '3', paddingBlock: '4' })}
                >
                  <span className={css({ flexShrink: '0', paddingBlockStart: '1' })}>
                    <Checkbox
                      aria-label={t('models.models.page.selectForHealthAria', { model: row.model.id })}
                      checked={healthSelected.has(key)}
                      disabled={running}
                      onCheckedChange={(checked) =>
                        onHealthSelectedChange((previous) => {
                          const next = new Set(previous);
                          if (checked) {
                            next.add(key);
                          } else {
                            next.delete(key);
                          }
                          return next;
                        })
                      }
                    />
                  </span>
                  <div
                    className={css({
                      flex: '1 1 0%',
                      minWidth: '0',
                      '& > :not(:last-child)': { marginBlockEnd: '1' },
                    })}
                  >
                    <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                      <span className={css({ overflowWrap: 'anywhere' })}>
                        <MonoValue value={row.model.id} />
                      </span>
                      {row.model.name === undefined || row.model.name.length === 0 ? null : (
                        <span className={css({ textStyle: 'small', color: 'text-muted', overflowWrap: 'anywhere' })}>
                          {row.model.name}
                        </span>
                      )}
                      {usage === 'agent' || usage === 'both' ? (
                        <ToneBadge tone="success">{t('models.models.page.agentBadge')}</ToneBadge>
                      ) : null}
                      {usage === 'vision' || usage === 'both' ? (
                        <ToneBadge tone="info">{t('models.models.page.visionBadge')}</ToneBadge>
                      ) : null}
                      {entry === 'checking' ? (
                        <ToneBadge tone="info">{t('models.models.page.checking')}</ToneBadge>
                      ) : result === null ? null : (
                        <ToneBadge tone={HEALTH_TONES[result.status]}>
                          {result.status === 'ok'
                            ? t('models.models.page.healthOk')
                            : result.status === 'unexpected_response'
                              ? t('models.models.page.healthUnexpected')
                              : t('models.models.page.healthError')}
                        </ToneBadge>
                      )}
                      {expandable ? (
                        <IconButton
                          variant="ghost"
                          color="secondary"
                          aria-expanded={open}
                          label={t('layout.business.toggleRowDetails')}
                          icon={open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                          onClick={() => toggleExpanded(key)}
                        />
                      ) : null}
                    </div>
                    <p
                      className={css({
                        margin: '0',
                        textStyle: 'small',
                        color: 'text-muted',
                        display: 'flex',
                        flexWrap: 'wrap',
                        columnGap: '3',
                        rowGap: '1',
                      })}
                    >
                      <Metric
                        label={t('models.models.page.contextLabel')}
                        value={formatNumber(row.model.context_window)}
                      />
                      <Metric
                        label={t('models.models.page.maxOutputLabel')}
                        value={formatNumber(row.model.max_tokens)}
                      />
                      {isImageCapable(row.model) ? (
                        <span className={css({ display: 'flex', alignItems: 'center', gap: '1' })}>
                          <EyeIcon aria-hidden="true" />
                          <span className={css({ srOnly: true })}>{t('models.models.page.srOnlyImage')}</span>
                        </span>
                      ) : null}
                      {row.model.reasoning ? (
                        <span className={css({ display: 'flex', alignItems: 'center', gap: '1' })}>
                          <LightbulbIcon aria-hidden="true" />
                          <span className={css({ srOnly: true })}>{t('models.models.page.srOnlyReasoning')}</span>
                        </span>
                      ) : null}
                    </p>
                    {result === null ? null : (
                      <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
                        {t('models.models.page.healthTiming', {
                          ttfb:
                            result.ttfb_ms === null
                              ? t('models.models.page.ttfbUnavailable')
                              : formatDuration(result.ttfb_ms),
                          duration: formatDuration(result.duration_ms),
                        })}
                      </p>
                    )}
                    {expandable ? (
                      <div
                        data-health-details
                        hidden={!open}
                        className={css({
                          maxHeight: '256px',
                          maxWidth: '48rem',
                          overflow: 'auto',
                          marginBlockStart: '2',
                          padding: '3',
                          borderRadius: 'lg',
                          bg: 'surface-muted',
                          whiteSpace: 'pre-wrap',
                          overflowWrap: 'anywhere',
                          '& > :not(:last-child)': { marginBlockEnd: '2' },
                        })}
                      >
                        {result !== null && result.error !== null && result.error.length > 0 ? (
                          <p className={css({ margin: '0', color: 'error-text' })}>{result.error}</p>
                        ) : null}
                        {result !== null && result.response_text.length > 0 ? (
                          <p className={css({ margin: '0', color: 'text-muted' })}>{result.response_text}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <RowActions>
                    <IconButton
                      variant="ghost"
                      color="secondary"
                      disabled={running}
                      label={t('models.models.page.checkHealthAria', { model: row.model.id })}
                      icon={<HealthIcon />}
                      onClick={() => void onRunHealthChecks([key])}
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
                          disabled:
                            !isImageCapable(row.model) || usage === 'vision' || usage === 'both' || visionPending,
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
                </li>
              );
            })}
          </ul>
        )}
        <ListFooter
          inset={false}
          count={pagination.total}
          page={pagination.page}
          pageCount={pagination.pageCount}
          onPageChange={pagination.onPageChange}
        />
      </div>
    </Panel>
  );
}
