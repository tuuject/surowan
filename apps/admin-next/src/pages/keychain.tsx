import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ConfirmDialog,
  ListPageHeader,
  MonoValue,
  TableShell,
  TimeText,
  ToneBadge,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import type { KeychainEntryView, KeychainSnapshotView } from '@/lib/api/keychain.ts';
import { deleteKeychainEntry, purgeKeychain, rotateKeychainEntry } from '@/lib/api/keychain.ts';
import { errorMessage } from '@/lib/errors';
import { keychainQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { CreateEntryDialog, RotateEntryDialog } from './keychain-dialogs.tsx';

/**
 * Whether an entry is an orphan: neither the configuration file nor the
 * running configuration references it. `usage.file === null` means the file
 * could not be parsed, so nothing may be reclaimed.
 */
function isOrphan(snapshot: KeychainSnapshotView, name: string): boolean | null {
  if (snapshot.usage.file === null) {
    return null;
  }
  const inFile = Object.hasOwn(snapshot.usage.file, name);
  const inActive = snapshot.usage.active.includes(name);
  return !inFile && !inActive;
}

export default function KeychainPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const snapshot = useQuery(keychainQuery);
  const [createOpen, setCreateOpen] = useState(false);
  const [createNonce, setCreateNonce] = useState(0);
  const [rotating, setRotating] = useState<KeychainEntryView | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateNonce, setRotateNonce] = useState(0);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<KeychainEntryView | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  /** Finding 12: the confirmed set freezes when the dialog opens; the request uses exactly these names. */
  const [purgeNames, setPurgeNames] = useState<readonly string[]>([]);
  const purgeResult = useRef<{ deleted: readonly string[]; skipped: readonly string[] } | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: keychainQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: ['config-status'] });
    void queryClient.invalidateQueries({ queryKey: ['providers'] });
    void queryClient.invalidateQueries({ queryKey: ['telegram'] });
    void queryClient.invalidateQueries({ queryKey: ['search-config'] });
    void queryClient.invalidateQueries({ queryKey: ['image-config'] });
  };

  const rotate = useMutation({
    // Return nothing: the mutation cache must never retain the submitted value.
    mutationFn: async ({ name, value }: { readonly name: string; readonly value: string }): Promise<void> => {
      await rotateKeychainEntry(name, value);
    },
    gcTime: 0,
    retry: false,
    onSuccess: (_result, variables) => {
      // Dropped in the same render that closes: the fade holds no plaintext.
      rotate.reset();
      setRotateOpen(false);
      setRotateError(null);
      toast.success(t('pages.keychain.rotatedMessage', { name: variables.name }));
      refresh();
    },
    onError: (error) => {
      rotate.reset();
      setRotateError(errorMessage(error));
    },
  });
  const remove = useMutation({
    mutationFn: async (name: string): Promise<void> => {
      await deleteKeychainEntry(name);
    },
    gcTime: 0,
    retry: false,
    onSuccess: (_result, name) => {
      remove.reset();
      setDeleteOpen(false);
      toast.success(t('pages.keychain.deletedMessage', { name }));
      refresh();
    },
  });
  const purge = useMutation({
    // Return nothing: the mutation cache must never retain the submitted names.
    mutationFn: async (names: readonly string[]): Promise<void> => {
      const result = await purgeKeychain(names);
      purgeResult.current = result;
    },
    gcTime: 0,
    retry: false,
    onSuccess: () => {
      purge.reset();
      setPurgeOpen(false);
      toast.success(t('pages.keychain.purgedMessage', { count: purgeResult.current?.deleted.length ?? 0 }));
      refresh();
    },
  });

  const orphanOf = (name: string): boolean | null =>
    snapshot.data === undefined ? null : isOrphan(snapshot.data, name);
  const orphans = (snapshot.data?.entries ?? []).filter(
    (entry) =>
      isOrphan(snapshot.data ?? { entries: [], usage: { file: {}, active: [], external: [] } }, entry.name) === true,
  );
  const canPurge = snapshot.data?.usage.file !== null && orphans.length > 0;

  const columns: readonly ColumnSpec<KeychainEntryView>[] = [
    {
      key: 'name',
      title: t('pages.keychain.nameColumn'),
      width: 200,
      render: (entry) => <MonoValue value={entry.name} />,
    },
    {
      key: 'created',
      title: t('pages.keychain.createdColumn'),
      width: 184,
      render: (entry) => <TimeText value={entry.created_at} />,
    },
    {
      key: 'used',
      title: t('pages.keychain.usedByColumn'),
      render: (entry) => {
        const file = snapshot.data?.usage.file;
        const paths =
          file !== null && file !== undefined && Object.hasOwn(file, entry.name) ? (file[entry.name] ?? []) : [];
        if (snapshot.data?.usage.file === null) {
          return (
            <span className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('pages.keychain.usageUnavailable')}
            </span>
          );
        }
        if (paths.length === 0 && !(snapshot.data?.usage.active ?? []).includes(entry.name)) {
          return <ToneBadge tone="neutral">{t('pages.keychain.orphan')}</ToneBadge>;
        }
        return (
          <span className={css({ textStyle: 'small', overflowWrap: 'anywhere' })}>
            {[
              ...paths,
              ...(paths.includes('')
                ? []
                : snapshot.data?.usage.active.includes(entry.name) && paths.length === 0
                  ? [t('pages.keychain.runningOnly')]
                  : []),
            ].join(', ')}
          </span>
        );
      },
    },
    {
      key: 'actions',
      title: '',
      width: 128,
      align: 'right',
      paddingBlock: 'none',
      render: (entry) => (
        <RowActions
          actions={[
            {
              key: 'rotate',
              label: t('pages.keychain.rotateAction'),
              disabled: false,
              onClick: () => {
                setRotating(entry);
                setRotateNonce((n) => n + 1);
                setRotateOpen(true);
              },
            },
            {
              key: 'delete',
              label: t('pages.keychain.deleteAction'),
              disabled: orphanOf(entry.name) !== true,
              onClick: () => {
                setDeleting(entry);
                setDeleteOpen(true);
              },
            },
          ]}
        />
      ),
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader
        title={t('pages.keychain.title')}
        actions={
          <Button
            variant="outline"
            color="secondary"
            iconStart={<PlusIcon />}
            onClick={() => {
              setCreateNonce((n) => n + 1);
              setCreateOpen(true);
            }}
          >
            {t('pages.keychain.createAction')}
          </Button>
        }
      />
      {snapshot.isPending ? (
        <div className={css({ height: '256px' })} />
      ) : snapshot.isError ? (
        <Alert
          tone="error"
          action={
            <Button size="sm" variant="ghost" color="secondary" onClick={() => void snapshot.refetch()}>
              {t('common.reload')}
            </Button>
          }
        >
          {errorMessage(snapshot.error)}
        </Alert>
      ) : (
        <>
          <TableShell
            columns={columns}
            data={snapshot.data.entries}
            rowKey={(entry) => entry.name}
            minWidth={720}
            emptyText={t('pages.keychain.empty')}
            caption={t('pages.keychain.valuesHiddenHint')}
          />
          <Panel title={t('pages.keychain.purgeTitle')}>
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}>
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.keychain.purgeHint')}</p>
              <div>
                <Button
                  variant="outline"
                  color="error"
                  disabled={!canPurge}
                  loading={purge.isPending}
                  onClick={() => {
                    setPurgeNames(orphans.map((entry) => entry.name));
                    setPurgeOpen(true);
                  }}
                >
                  {t('pages.keychain.purgeAction', { count: orphans.length })}
                </Button>
              </div>
            </div>
          </Panel>
          <Panel title={t('pages.keychain.externalTitle')}>
            <ExternalRefs snapshot={snapshot.data} />
          </Panel>
        </>
      )}
      <CreateEntryDialog
        key={`create-${createNonce}`}
        open={createOpen}
        formKey={createNonce}
        onOpenChange={setCreateOpen}
      />
      <RotateEntryDialog
        key={`rotate-${rotateNonce}`}
        open={rotateOpen}
        entry={rotating}
        formKey={rotateNonce}
        pending={rotate.isPending}
        error={rotateError}
        onOpenChange={setRotateOpen}
        onConfirm={(value) => {
          if (rotating !== null) {
            rotate.mutate({ name: rotating.name, value });
          }
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('pages.keychain.deleteTitle')}
        description={t('pages.keychain.deleteDescription', { name: deleting?.name ?? '' })}
        confirmText={t('common.delete')}
        destructive
        pending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting.name);
          }
        }}
      />
      <ConfirmDialog
        open={purgeOpen}
        onOpenChange={setPurgeOpen}
        title={t('pages.keychain.purgeConfirmTitle')}
        description={t('pages.keychain.purgeConfirmDescription')}
        confirmText={t('pages.keychain.purgeConfirm')}
        destructive
        pending={purge.isPending}
        error={purge.error === null ? null : errorMessage(purge.error)}
        onConfirm={() => purge.mutate(purgeNames)}
      >
        <ul className={css({ marginInlineStart: '5', textStyle: 'small' })}>
          {purgeNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

function RowActions({
  actions,
}: {
  readonly actions: readonly { key: string; label: string; disabled: boolean; onClick: () => void }[];
}): ReactElement {
  return (
    <div className={css({ display: 'flex', gap: '1', justifyContent: 'flex-end' })}>
      {actions.map((action) => (
        <Button
          key={action.key}
          size="sm"
          variant="ghost"
          color="secondary"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}

function ExternalRefs({ snapshot }: { readonly snapshot: KeychainSnapshotView | undefined }): ReactElement {
  const { t } = useTranslation();
  const external = snapshot?.usage.external ?? [];
  if (external.length === 0) {
    return <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.keychain.noExternal')}</p>;
  }
  return (
    <ul className={css({ display: 'flex', flexDirection: 'column', gap: '2', textStyle: 'small' })}>
      {external.map((ref) => (
        <li key={ref.path} className={css({ display: 'flex', gap: '2', flexWrap: 'wrap', alignItems: 'baseline' })}>
          <MonoValue value={ref.path} />
          <ToneBadge tone="neutral">
            {ref.kind === 'env'
              ? t('pages.keychain.externalEnv', { env: ref.env ?? '' })
              : t('pages.keychain.externalCommand')}
          </ToneBadge>
        </li>
      ))}
    </ul>
  );
}
