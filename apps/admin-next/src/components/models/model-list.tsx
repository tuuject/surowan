import { Button, IconButton } from '@tuuject/koi-react/button';
import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Empty } from '@tuuject/koi-react/empty';
import { ChevronDownIcon, ChevronRightIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { Dispatch, ReactElement, SetStateAction } from 'react';
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
import { EditIcon, EyeIcon, HealthIcon, LightbulbIcon } from '@/components/icons';
import { Panel } from '@/components/layout/panel';
import { RoleButtons } from '@/components/models/roles/buttons';
import { type ModelRole, modelRoles } from '@/components/models/roles/writes';
import type {
  HealthCheckResult,
  HealthCheckStatus,
  ProviderApi,
  ProviderModelConfig,
  ProvidersView,
} from '@/lib/api/providers.ts';
import { formatDuration, formatNumber } from '@/lib/format.ts';
import { isImageCapable } from '@/lib/model-manager.ts';

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
function Metric({ label, value }: { readonly label: string; readonly value: React.ReactNode }): ReactElement {
  return (
    <span className={css({ whiteSpace: 'nowrap' })}>
      {label} <span className={css({ color: 'text' })}>{value}</span>
    </span>
  );
}

/**
 * The selected provider's models as a vertical list: identity and health on
 * the first line, the numbers on the second, the "Use as" role toggles on the
 * third, and the row actions beside them. The list is the provider detail's
 * main area, so it stacks instead of spreading six columns across the pane.
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
  rolePending,
  onAssignRole,
  onEdit,
  onDeleteModel,
  onDeleteSelected,
  selectedModelsInUse,
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
  readonly rolePending: Readonly<Record<ModelRole, boolean>>;
  readonly onAssignRole: (role: ModelRole, alias: string, model: ProviderModelConfig) => void;
  readonly onEdit: (alias: string, model: ProviderModelConfig) => void;
  readonly onDeleteModel: (alias: string, model: string) => void;
  readonly onDeleteSelected: () => void;
  readonly selectedModelsInUse: boolean;
  readonly onFetchModels: () => void;
  readonly onAddById: () => void;
}): ReactElement {
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
      action={
        <>
          <Button color="secondary" onClick={onAddById}>
            {t('models.models.page.addById')}
          </Button>
          <Button color="primary" onClick={onFetchModels}>
            {t('models.models.page.fetchModels')}
          </Button>
        </>
      }
    >
      <div>
        {/* The list's header row, ruled off like a Koi Table header so the rows below read as one list. */}
        <div
          className={css({
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '3',
            paddingBlockEnd: '3',
            borderBottomWidth: '1px',
            borderColor: 'divider',
          })}
        >
          <Checkbox
            label={t('models.models.page.selectAllModels')}
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
              color="secondary"
              iconStart={<HealthIcon />}
              disabled={runnableSelected.length === 0 || running}
              onClick={() => void onRunHealthChecks(runnableSelected)}
              className={css({ fontVariantNumeric: 'tabular-nums' })}
            >
              {t('models.models.page.checkSelected', { count: runnableSelected.length })}
            </Button>
            <Button
              color="error"
              iconStart={<TrashIcon />}
              disabled={runnableSelected.length === 0 || running || selectedModelsInUse}
              onClick={onDeleteSelected}
              className={css({ fontVariantNumeric: 'tabular-nums' })}
            >
              {t('models.models.page.deleteSelected', { count: runnableSelected.length })}
            </Button>
          </div>
        </div>
        {selectedModelsInUse ? (
          <p className={css({ marginBlockStart: '3', marginBlockEnd: '0', color: 'text-muted' })}>
            {t('models.models.page.selectedModelsInUse')}
          </p>
        ) : null}

        {rows.length === 0 ? (
          <div className={css({ paddingBlock: '4' })}>
            <Empty title={t('models.models.page.emptyModels')} />
          </div>
        ) : (
          <ul
            data-model-list
            className={css({
              margin: '0',
              padding: '0',
              '& > li': { borderBottomWidth: '1px', borderColor: 'divider' },
            })}
          >
            {pagination.items.map((row) => {
              const key = rowKey(row);
              const roles = modelRoles(view, row.alias, row.model.id);
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
                      aria-label={t('models.models.page.selectModelAria', { model: row.model.id })}
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
                          {t('models.models.page.imageInput')}
                        </span>
                      ) : null}
                      {row.model.reasoning ? (
                        <span className={css({ display: 'flex', alignItems: 'center', gap: '1' })}>
                          <LightbulbIcon aria-hidden="true" />
                          {t('models.models.page.reasoningCapable')}
                        </span>
                      ) : null}
                    </p>
                    <div className={css({ paddingBlockStart: '2' })}>
                      <RoleButtons
                        view={view}
                        alias={row.alias}
                        config={row.model}
                        pending={rolePending}
                        onAssign={onAssignRole}
                      />
                    </div>
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
                      // The server refuses to delete a model a role or a Chat still uses.
                      disabled={running || roles.agent || roles.vision || roles.tool}
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
        <div className={css({ marginBlockStart: '4' })}>
          <ListFooter
            inset={false}
            count={pagination.total}
            page={pagination.page}
            pageCount={pagination.pageCount}
            onPageChange={pagination.onPageChange}
          />
        </div>
      </div>
    </Panel>
  );
}
