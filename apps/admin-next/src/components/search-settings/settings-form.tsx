import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button, IconButton } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ListFooter,
  ListSearchForm,
  ListToolbar,
  QueryTextField,
  RowActions,
  SettingRow,
  TableShell,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { EditIcon } from '@/components/icons';
import { Panel } from '@/components/layout/panel';
import { putSearchConfig, type SearchConfigView } from '@/lib/api/search.ts';
import { errorMessage } from '@/lib/errors';
import { useListQuery } from '@/lib/list-query';
import { isConfigConflict } from '@/lib/model-manager';
import { configStatusQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { activeEngineCount, buildPayload, type EngineDraft, emptyDraft, toDraft, validate } from './draft.ts';
import { EngineEditor } from './engine-editor.tsx';
import { UrlFilterEditor } from './url-filters.tsx';

const EMPTY_FILTERS = { search: '' };

/** The editable form. Its identity is the revision, so a new revision remounts it. */
export function SearchSettingsForm({ initial }: { initial: SearchConfigView }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [engines, setEngines] = useState<EngineDraft[]>(() => initial.engines.map(toDraft));
  const [filters, setFilters] = useState(initial.url_filters.join('\n'));
  const query = useListQuery(EMPTY_FILTERS);
  const engineSearch = query.value.search;
  const [editing, setEditing] = useState<{ readonly draft: EngineDraft; readonly isNew: boolean } | null>(null);
  const [editingErrors, setEditingErrors] = useState<readonly string[]>([]);
  const providers = initial.providers;
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const payload = useMemo(
    () => buildPayload(enabled, engines, filters, providerById),
    [enabled, engines, filters, providerById],
  );
  const errors = useMemo(() => validate(payload, providers), [payload, providers]);
  const activeEngines = activeEngineCount(payload.engines);
  const visibleEngines = engines.filter((engine) => {
    if (engineSearch.length === 0) {
      return true;
    }
    const needle = engineSearch.toLowerCase();
    return `${engine.id} ${engine.provider} ${engine.note}`.toLowerCase().includes(needle);
  });
  const pagination = useClientPagination(visibleEngines, query.resetKey);

  const save = useMutation({
    mutationFn: () => putSearchConfig(payload, initial.revision),
    onSuccess: (result) => {
      queryClient.setQueryData(['search-config'], result);
      void queryClient.invalidateQueries({ queryKey: configStatusQuery.queryKey });
      toast.success(t('search.saved'));
    },
  });

  const addEngine = (): void => {
    if (save.isPending) {
      return;
    }
    const provider = providers[0];
    if (provider !== undefined) {
      setEditingErrors([]);
      setEditing({ draft: emptyDraft(provider, engines), isNew: true });
    }
  };

  const closeEditor = (): void => {
    setEditing(null);
    setEditingErrors([]);
  };

  const saveEngine = (): void => {
    if (editing === null || save.isPending) {
      return;
    }
    const nextEngines = editing.isNew
      ? [...engines, editing.draft]
      : engines.map((engine) => (engine.key === editing.draft.key ? editing.draft : engine));
    const candidate = buildPayload(enabled, nextEngines, filters, providerById);
    const editedIndex = nextEngines.findIndex((engine) => engine.key === editing.draft.key);
    const candidateErrors = validate(candidate, providers, editedIndex < 0 ? {} : { onlyEngineIndex: editedIndex });
    if (candidateErrors.length > 0) {
      setEditingErrors(candidateErrors);
      return;
    }
    setEngines(nextEngines);
    closeEditor();
  };

  const columns: readonly ColumnSpec<EngineDraft>[] = [
    {
      key: 'id',
      title: t('search.fieldId'),
      width: 200,
      render: (engine) => <span className={css({ fontFamily: 'mono' })}>{engine.id}</span>,
    },
    {
      key: 'provider',
      title: t('search.fieldProvider'),
      width: 160,
      render: (engine) => providerById.get(engine.provider)?.label ?? engine.provider,
    },
    {
      key: 'enabled',
      title: t('search.engineEnabled'),
      width: 104,
      render: (engine) => (
        <ToneBadge tone={engine.enabled ? 'success' : 'neutral'}>
          {engine.enabled ? t('common.enabled') : t('common.disabled')}
        </ToneBadge>
      ),
    },
    {
      key: 'results',
      title: t('search.fieldResults'),
      align: 'right',
      width: 104,
      render: (engine) => engine.results || '—',
    },
    { key: 'note', title: t('search.fieldNote'), render: (engine) => engine.note || '—' },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      align: 'right',
      width: 104,
      paddingBlock: 'none',
      render: (engine) => (
        <RowActions>
          <IconButton
            variant="ghost"
            color="secondary"
            disabled={save.isPending}
            onClick={() => {
              setEditingErrors([]);
              setEditing({ draft: engine, isNew: false });
            }}
            label={`${t('common.edit')} ${engine.id}`}
            icon={<EditIcon />}
          />
          <IconButton
            variant="ghost"
            color="error"
            disabled={save.isPending}
            onClick={() => setEngines((current) => current.filter((entry) => entry.key !== engine.key))}
            label={`${t('search.removeEngine')} ${engine.id}`}
            icon={<TrashIcon />}
          />
        </RowActions>
      ),
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <Panel title={t('search.switchTitle')} description={t('search.switchDescription')}>
        <SettingRow
          label={t('search.switchLabel')}
          description={enabled && activeEngines > 0 ? t('search.switchActive') : t('search.switchInactive')}
        >
          {({ id, describedBy }) => (
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={enabled}
              onCheckedChange={(next) => setEnabled(next)}
              disabled={save.isPending}
            />
          )}
        </SettingRow>
      </Panel>

      <section className={css({ paddingBlockStart: '6', '& > * + *': { marginBlockStart: '5' } })}>
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
          <h2 className={css({ margin: '0', textStyle: 'heading-2' })}>{t('search.enginesTitle')}</h2>
          <p className={css({ margin: '0', color: 'text-muted' })}>{t('search.enginesDescription')}</p>
        </div>
        <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
          {({ draft, change }) => (
            <QueryTextField
              label={t('search.enginesTitle')}
              value={draft.search}
              onChange={(search) => change({ search })}
            />
          )}
        </ListSearchForm>
        <ListToolbar>
          <Button
            variant="outline"
            onClick={addEngine}
            disabled={providers.length === 0 || save.isPending}
            iconStart={<PlusIcon />}
          >
            {t('search.addEngine')}
          </Button>
        </ListToolbar>
        <div>
          <TableShell
            columns={columns}
            data={pagination.items}
            rowKey={(engine) => engine.key}
            minWidth={880}
            emptyText={t('search.noEngines')}
          />
          <ListFooter
            count={pagination.total}
            page={pagination.page}
            pageCount={pagination.pageCount}
            onPageChange={pagination.onPageChange}
          />
        </div>
      </section>

      <UrlFilterEditor rules={filters} onRulesChange={setFilters} disabled={save.isPending} />

      {errors.length > 0 ? (
        <Alert tone="error" title={t('search.invalidTitle')} role="alert">
          <ul className={css({ listStyleType: 'disc', paddingInlineStart: '4' })}>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {save.isError && isConfigConflict(save.error) ? (
        <Alert
          tone="error"
          title={t('search.conflictTitle')}
          role="alert"
          action={
            <Button
              size="sm"
              variant="ghost"
              color="secondary"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['search-config'] })}
            >
              {t('common.reload')}
            </Button>
          }
        >
          {t('search.conflictBody')}
        </Alert>
      ) : save.isError ? (
        <Alert tone="error">{errorMessage(save.error)}</Alert>
      ) : null}
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
        <Button
          disabled={errors.length > 0 || (save.isError && isConfigConflict(save.error))}
          loading={save.isPending}
          loadingLabel={t('search.saving')}
          onClick={() => save.mutate()}
        >
          {t('search.save')}
        </Button>
        <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>{t('search.saveHint')}</p>
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !save.isPending) {
            closeEditor();
          }
        }}
        title={editing?.isNew === true ? t('search.addEngine') : t('search.editEngine')}
        description={t('search.enginesDescription')}
        size="lg"
        footer={
          <>
            <Button variant="ghost" color="secondary" disabled={save.isPending} onClick={closeEditor}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled={save.isPending} onClick={saveEngine}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {editing === null ? null : (
          <EngineEditor
            draft={editing.draft}
            providers={providers}
            provider={providerById.get(editing.draft.provider)}
            deepseekKeys={initial.deepseek_keys}
            disabled={save.isPending}
            onChange={(change) => {
              setEditingErrors([]);
              setEditing({ ...editing, draft: { ...editing.draft, ...change } });
            }}
          />
        )}
        {editingErrors.length === 0 ? null : (
          <Alert tone="error" title={t('search.invalidTitle')} role="alert">
            <ul className={css({ listStyleType: 'disc', paddingInlineStart: '4' })}>
              {editingErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </Alert>
        )}
      </Dialog>
    </div>
  );
}
