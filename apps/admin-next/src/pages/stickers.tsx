import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ConfirmDialog,
  JsonViewer,
  ListFooter,
  ListPageHeader,
  ListSearchForm,
  QuerySelectField,
  QueryTextField,
  RowActions,
  SnapshotList,
  StateBadge,
  TableShell,
  TextValue,
  TimeText,
  useClientPagination,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { ApiError } from '@/lib/api/core.ts';
import {
  addStickerSet,
  removeStickerSet,
  type StickerEntry,
  type StickerSetEntry,
  type StickerSetWriteResult,
  updateStickerSet,
} from '@/lib/api/stickers.ts';
import { errorMessage } from '@/lib/errors';
import { formatNumber, stateLabel } from '@/lib/format';
import { optionalQuery, useListQuery } from '@/lib/list-query';
import { stickerSetsQuery, stickersQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import {
  EMPTY_STICKER_SET_FORM,
  StickerSetDialog,
  type StickerSetFormErrors,
  type StickerSetFormValues,
  stickerSetFormValues,
  validateStickerSetForm,
} from './stickers-dialogs';

const INDEX_STATES = ['pending', 'running', 'success', 'error'] as const;
const EMPTY_FILTERS = { set: '', state: '', search: '' };

const MUTED = css({ color: 'text-muted' });

/** A page section heading for the list that follows it; the list itself stays on the page, not in a card. */
function SectionHeading({ title }: { readonly title: string }): ReactElement {
  return <h2 className={css({ margin: '0', textStyle: 'heading-2' })}>{title}</h2>;
}

export default function StickersPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useListQuery(EMPTY_FILTERS);
  const { set, state, search } = query.value;
  const sets = useQuery(stickerSetsQuery);
  const configuredSets = (sets.data?.items ?? []).filter((entry) => entry.configured);
  const setPagination = useClientPagination(configuredSets, 'sticker-sets');
  const revision = sets.data?.revision ?? null;
  const filters = useMemo(
    () => ({ set: optionalQuery(set), state: optionalQuery(state), search: optionalQuery(search) }),
    [set, state, search],
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<StickerSetEntry | null>(null);
  const [form, setForm] = useState<StickerSetFormValues>(EMPTY_STICKER_SET_FORM);
  const [formErrors, setFormErrors] = useState<StickerSetFormErrors>({});
  const [removing, setRemoving] = useState<StickerSetEntry | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  // Every write answers with the fresh list and revision; the index list below
  // shows aliases, so it reloads too.
  const applyWrite = (view: StickerSetWriteResult): void => {
    queryClient.setQueryData(stickerSetsQuery.queryKey, { items: view.items, revision: view.revision });
    void queryClient.invalidateQueries({ queryKey: ['stickers'] });
  };
  const refreshOnError = (): void => {
    void queryClient.invalidateQueries({ queryKey: stickerSetsQuery.queryKey });
  };

  const save = useMutation({
    mutationFn: (values: StickerSetFormValues) => {
      const note = values.note.trim().length === 0 ? null : values.note.trim();
      return editing === null
        ? addStickerSet({ name: values.name.trim(), alias: values.alias.trim(), note }, revision ?? '')
        : updateStickerSet(editing.alias, { alias: values.alias.trim(), note }, revision ?? '');
    },
    onSuccess: (view) => {
      setDialogOpen(false);
      toast.success(editing === null ? t('pages.stickers.setAdded') : t('pages.stickers.setUpdated'));
      applyWrite(view);
    },
    onError: refreshOnError,
  });

  const remove = useMutation({
    mutationFn: (entry: StickerSetEntry) => removeStickerSet(entry.alias, revision ?? ''),
    onSuccess: (view) => {
      setRemoveOpen(false);
      toast.success(t('pages.stickers.setRemoved'));
      applyWrite(view);
    },
    onError: refreshOnError,
  });

  const openDialog = (entry: StickerSetEntry | null): void => {
    save.reset();
    setEditing(entry);
    setForm(entry === null ? EMPTY_STICKER_SET_FORM : stickerSetFormValues(entry));
    setFormErrors({});
    setDialogOpen(true);
  };

  const submit = (): void => {
    const errors = validateStickerSetForm(form, editing === null);
    setFormErrors(errors);
    if (Object.keys(errors).length === 0) {
      save.mutate(form);
    }
  };

  const setOptions = (sets.data?.items ?? []).map((entry) => ({ value: entry.alias, label: entry.alias }));
  const editable = revision !== null;

  const setColumns: readonly ColumnSpec<StickerSetEntry>[] = [
    {
      key: 'alias',
      title: t('pages.stickers.colSet'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div dir="ltr" className={css({ truncate: true, fontWeight: 'semibold', textAlign: 'start' })}>
            {row.alias}
          </div>
          {row.title === null ? null : (
            <div dir="auto" className={css({ truncate: true, textStyle: 'small', color: 'text-muted' })}>
              {row.title}
            </div>
          )}
          <div className={css({ truncate: true, textStyle: 'small', color: 'text-muted', fontFamily: 'mono' })}>
            {row.telegram_name}
          </div>
        </div>
      ),
    },
    {
      key: 'note',
      title: t('pages.stickers.colNote'),
      render: (row) =>
        row.note === null ? (
          <span className={MUTED}>—</span>
        ) : (
          <p className={css({ margin: '0', lineClamp: '2', whiteSpace: 'normal', overflowWrap: 'anywhere' })}>
            {row.note}
          </p>
        ),
    },
    {
      key: 'sync_state',
      title: t('pages.stickers.colSync'),
      width: 144,
      render: (row) => (
        <div className={css({ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1' })}>
          <StateBadge state={row.sync_state} />
          {row.error_code === null ? null : (
            <span className={css({ textStyle: 'small', color: 'text-muted', fontFamily: 'mono' })}>
              {row.error_code}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'indexed_count',
      title: t('pages.stickers.colIndexed'),
      align: 'right',
      width: 144,
      render: (row) => (
        <div>
          <div>{`${formatNumber(row.indexed_count)} / ${formatNumber(row.sticker_count)}`}</div>
          {row.pending_count === 0 && row.error_count === 0 ? null : (
            <div
              className={css({
                textStyle: 'small',
                color: 'text-muted',
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
                columnGap: '3',
              })}
            >
              {row.pending_count === 0 ? null : (
                <span>{t('pages.stickers.pendingCount', { count: row.pending_count })}</span>
              )}
              {row.error_count === 0 ? null : <span>{t('pages.stickers.errorCount', { count: row.error_count })}</span>}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'last_synced_at',
      title: t('pages.stickers.colLastSynced'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => <TimeText value={row.last_synced_at} />,
    },
    {
      key: 'actions',
      title: t('pages.stickers.colActions'),
      align: 'right',
      width: 152,
      render: (row) => (
        <RowActions>
          <Button size="sm" variant="ghost" disabled={!editable} onClick={() => openDialog(row)}>
            {t('pages.stickers.edit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            color="error"
            disabled={!editable}
            onClick={() => {
              remove.reset();
              setRemoving(row);
              setRemoveOpen(true);
            }}
          >
            {t('pages.stickers.remove')}
          </Button>
        </RowActions>
      ),
    },
  ];

  const stickerColumns: readonly ColumnSpec<StickerEntry>[] = [
    {
      key: 'emoji',
      title: t('pages.stickers.colSticker'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div>{row.emoji ?? <span className={MUTED}>—</span>}</div>
          <div className={css({ display: 'flex', gap: '2', textStyle: 'small', color: 'text-muted' })}>
            <span>{row.set_alias}</span>
            <span>{row.format}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'index_state',
      title: t('pages.stickers.colIndexState'),
      // 120 is the English "Succeeded" badge on one line; below that it breaks mid-word.
      width: 120,
      render: (row) => <StateBadge state={row.index_state} />,
    },
    {
      key: 'description',
      title: t('pages.stickers.colDescription'),
      render: (row) => (
        <p className={css({ margin: '0', lineClamp: '2', whiteSpace: 'normal', overflowWrap: 'anywhere' })}>
          {row.analysis?.description ?? <span className={MUTED}>—</span>}
        </p>
      ),
    },
    {
      key: 'model',
      title: t('pages.stickers.colModel'),
      render: (row) =>
        row.analysis === null ? (
          <span className={MUTED}>—</span>
        ) : (
          `${row.analysis.provider ?? '?'}/${row.analysis.model ?? '?'}`
        ),
    },
    {
      key: 'failure_count',
      title: t('pages.stickers.colFailures'),
      align: 'right',
      width: 96,
      render: (row) => formatNumber(row.failure_count),
    },
    {
      key: 'updated_at',
      title: t('pages.stickers.colUpdated'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => <TimeText value={row.updated_at} />,
    },
  ];

  return (
    <div className={css({ '& > * + *': { marginBlockStart: '5' } })}>
      <ListPageHeader title={t('layout.nav.botStickerSets')} />
      {sets.isSuccess && !editable ? (
        <Alert tone="warning" title={t('pages.stickers.readOnlyTitle')}>
          {t('pages.stickers.readOnlyDesc')}
        </Alert>
      ) : null}
      <Panel
        title={t('pages.stickers.setsTitle')}
        action={
          <Button variant="outline" iconStart={<PlusIcon />} disabled={!editable} onClick={() => openDialog(null)}>
            {t('pages.stickers.addSet')}
          </Button>
        }
      >
        {sets.isError ? (
          <Alert tone="error" title={t('pages.stickers.loadSetsFailed')}>
            {sets.error instanceof ApiError
              ? `${sets.error.code}: ${sets.error.message}`
              : sets.error instanceof Error
                ? sets.error.message
                : t('pages.stickers.adminRequestFailed')}
          </Alert>
        ) : (
          <div>
            <TableShell
              columns={setColumns}
              data={setPagination.items}
              rowKey={(row) => row.id}
              loading={sets.isPending}
              skeletonRows={2}
              minWidth={960}
              emptyText={t('pages.stickers.emptySets')}
            />
            {sets.isPending ? null : (
              <ListFooter
                count={setPagination.total}
                page={setPagination.page}
                pageCount={setPagination.pageCount}
                onPageChange={setPagination.onPageChange}
              />
            )}
          </div>
        )}
      </Panel>
      <div className={css({ paddingBlockStart: '6' })}>
        <SectionHeading title={t('pages.stickers.indexTitle')} />
      </div>
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <QuerySelectField
              label={t('pages.stickers.filterSet')}
              value={draft.set}
              onChange={(set) => change({ set })}
              options={setOptions}
            />
            <QuerySelectField
              label={t('pages.stickers.filterState')}
              value={draft.state}
              onChange={(state) => change({ state })}
              options={INDEX_STATES.map((value) => ({ value, label: stateLabel(value) }))}
            />
            <QueryTextField
              label={t('pages.stickers.filterSearch')}
              value={draft.search}
              onChange={(search) => change({ search })}
            />
          </>
        )}
      </ListSearchForm>
      <SnapshotList
        factory={stickersQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={stickerColumns}
            data={items}
            rowKey={(row) => row.id}
            loading={loading}
            minWidth={1000}
            expandedRender={(row) => (
              <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                  <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.stickers.nextRetry')}</p>
                  <p>
                    <TimeText value={row.next_retry_at} />
                  </p>
                </div>
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                  <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                    {t('pages.stickers.analysisVersion')}
                  </p>
                  <TextValue value={row.analysis?.analysis_version ?? null} />
                </div>
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                  <p className={css({ textStyle: 'small', color: 'text-muted' })}>
                    {t('pages.stickers.colDescription')}
                  </p>
                  <p className={css({ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>
                    {row.analysis?.description ?? '—'}
                  </p>
                </div>
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                  <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.stickers.metadata')}</p>
                  <JsonViewer value={row.analysis?.metadata_json ?? null} />
                </div>
              </div>
            )}
          />
        )}
      />

      <StickerSetDialog
        open={dialogOpen}
        editing={editing}
        values={form}
        errors={formErrors}
        pending={save.isPending}
        error={save.isError ? save.error : null}
        onChange={(patch) => {
          setForm((current) => ({ ...current, ...patch }));
          setFormErrors({});
        }}
        onOpenChange={setDialogOpen}
        onSubmit={submit}
      />

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoveOpen(false);
          }
        }}
        title={t('pages.stickers.removeTitle', { alias: removing?.alias ?? '' })}
        description={t('pages.stickers.removeDescription')}
        confirmText={t('pages.stickers.removeConfirm')}
        cancelText={t('common.cancel')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing);
          }
        }}
      />
    </div>
  );
}
