import { startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ConfirmDialog,
  ListFooter,
  ListToolbar,
  TableShell,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import type { PasskeyItem } from '@/lib/api/auth.ts';
import { deletePasskey, deletePassword, passkeyRegisterOptions, passkeyRegisterVerify } from '@/lib/api/auth.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { isWebAuthnAvailable, passkeyErrorMessage } from '@/lib/passkeys';
import { passkeysQuery, sessionQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

/**
 * Passkey management card for the Settings page. Rendered only when the
 * session reports `passkeys_enabled`; the WebAuthn ceremony runs in the
 * browser via @simplewebauthn/browser and never exposes credentials to the
 * panel's own storage.
 */
export function PasskeysCard(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const webAuthnAvailable = isWebAuthnAvailable();
  const [registering, setRegistering] = useState(false);
  const [deleting, setDeleting] = useState<PasskeyItem | null>(null);
  const [removingPassword, setRemovingPassword] = useState(false);

  const passkeys = useQuery(passkeysQuery);

  const hasPassword = passkeys.data?.has_password ?? false;
  const items = passkeys.data?.items ?? [];
  const pagination = useClientPagination(items, 'passkeys');
  const usableCount = items.filter((item) => item.usable).length;
  const lastKeyWithoutPassword = usableCount === 1 && !hasPassword;

  const remove = useMutation({
    mutationFn: deletePasskey,
    retry: false,
    onSuccess: () => {
      setDeleting(null);
      toast.success(t('pages.passkeys.deleted'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    },
  });

  const passwordDelete = useMutation({
    mutationFn: deletePassword,
    retry: false,
    onSuccess: async () => {
      setRemovingPassword(false);
      toast.success(t('pages.passkeys.passwordDeleted'));
      // The server rotates the session cookie; both views of the auth state
      // (session flags and the passkey list's own `has_password`) change.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey }),
      ]);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    },
  });

  const columns: readonly ColumnSpec<PasskeyItem>[] = [
    {
      key: 'name',
      title: t('pages.passkeys.name'),
      className: 'max-w-52 whitespace-normal [overflow-wrap:anywhere]',
      render: (item) => (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <span className={css({ display: 'block' })}>{item.name}</span>
          {!item.usable ? (
            <span className={css({ textStyle: 'small', color: 'text-muted', display: 'block' })}>
              {t('pages.passkeys.unusable')}
            </span>
          ) : null}
        </div>
      ),
    },
    { key: 'created', title: t('pages.passkeys.created'), render: (item) => formatTime(item.created_at) },
    {
      key: 'last-used',
      title: t('pages.passkeys.lastUsed'),
      render: (item) => (item.last_used_at === null ? t('pages.passkeys.neverUsed') : formatTime(item.last_used_at)),
    },
    {
      key: 'actions',
      title: t('pages.passkeys.actions'),
      render: (item) => (
        <Button
          type="button"
          size="sm"
          color="error"
          disabled={remove.isPending || (!hasPassword && usableCount - (item.usable ? 1 : 0) === 0)}
          onClick={() => {
            remove.reset();
            setDeleting(item);
          }}
        >
          {t('pages.passkeys.delete')}
        </Button>
      ),
    },
  ];

  return (
    <Panel title={t('pages.passkeys.title')} description={t('pages.passkeys.description')}>
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        {!webAuthnAvailable ? (
          <p className={css({ textStyle: 'body', color: 'warning-text' })}>{t('pages.passkeys.unsupported')}</p>
        ) : null}
        {passkeys.data?.has_password === false ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('pages.passkeys.noPasswordHint')}</p>
        ) : null}
        {lastKeyWithoutPassword ? (
          <p className={css({ textStyle: 'body', color: 'warning-text' })}>{t('pages.passkeys.deleteLastDisabled')}</p>
        ) : null}
        <ListToolbar onRefresh={() => void passkeys.refetch()} refreshing={passkeys.isRefetching}>
          <Button type="button" disabled={!webAuthnAvailable} onClick={() => setRegistering(true)}>
            {t('pages.passkeys.add')}
          </Button>
          <Button
            type="button"
            color="error"
            disabled={!hasPassword || usableCount === 0 || passwordDelete.isPending}
            onClick={() => {
              passwordDelete.reset();
              setRemovingPassword(true);
            }}
          >
            {t('pages.passkeys.passwordDelete')}
          </Button>
        </ListToolbar>
        {passkeys.data !== undefined ? (
          <div className={css({ display: 'flex', alignItems: 'center', gap: '2' })}>
            <span className={css({ textStyle: 'body', color: 'text-muted' })}>
              {t('pages.passkeys.passwordStatus')}
            </span>
            <ToneBadge tone={hasPassword ? 'success' : 'neutral'}>
              {hasPassword ? t('pages.passkeys.passwordSet') : t('pages.passkeys.passwordNotSet')}
            </ToneBadge>
          </div>
        ) : null}
        {passkeys.isError ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {errorMessage(passkeys.error)}
            </p>
            <Button
              type="button"
              variant="outline"
              color="secondary"
              disabled={passkeys.isFetching}
              onClick={() => void passkeys.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : null}
        {!passkeys.isError && (passkeys.isPending || passkeys.data !== undefined) ? (
          <div>
            <TableShell
              columns={columns}
              data={pagination.items}
              rowKey={(item) => item.id}
              loading={passkeys.isPending}
              emptyText={t('pages.passkeys.empty')}
            />
            {passkeys.data === undefined ? null : (
              <ListFooter
                count={pagination.total}
                page={pagination.page}
                pageCount={pagination.pageCount}
                onPageChange={pagination.onPageChange}
              />
            )}
          </div>
        ) : null}
      </div>
      {registering ? <RegisterPasskeyDialog onClose={() => setRegistering(false)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleting(null);
          }
        }}
        title={t('pages.passkeys.deleteTitle', { name: deleting?.name ?? '' })}
        description={
          <span className={css({ overflowWrap: 'anywhere' })}>
            {t('pages.passkeys.deleteDescription', { name: deleting?.name ?? '' })}
          </span>
        }
        confirmText={t('pages.passkeys.deleteConfirm')}
        cancelText={t('common.cancel')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (deleting !== null && !remove.isPending) {
            remove.mutate(deleting.id);
          }
        }}
      />
      <ConfirmDialog
        open={removingPassword}
        onOpenChange={(open) => {
          if (!open && !passwordDelete.isPending) {
            setRemovingPassword(false);
          }
        }}
        title={t('pages.passkeys.passwordDeleteTitle')}
        description={t('pages.passkeys.passwordDeleteDescription')}
        confirmText={t('pages.passkeys.passwordDeleteConfirm')}
        cancelText={t('common.cancel')}
        destructive
        pending={passwordDelete.isPending}
        error={passwordDelete.isError ? errorMessage(passwordDelete.error) : null}
        onConfirm={() => {
          if (!passwordDelete.isPending) {
            passwordDelete.mutate();
          }
        }}
      />
    </Panel>
  );
}

function RegisterPasskeyDialog({ onClose }: { readonly onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);

  const register = useMutation({
    mutationFn: async (passkeyName: string) => {
      const options = await passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: options });
      return passkeyRegisterVerify(passkeyName, response);
    },
    retry: false,
    gcTime: 0,
    onSuccess: () => {
      toast.success(t('pages.passkeys.registered'));
      onClose();
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !register.isPending && onClose()}
      title={t('pages.passkeys.registerTitle')}
      description={t('pages.passkeys.registerDescription')}
      footer={
        <>
          <Button type="button" variant="outline" color="secondary" disabled={register.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="passkeys-card-form" disabled={register.isPending}>
            {register.isPending ? t('pages.passkeys.registering') : t('pages.passkeys.registerConfirm')}
          </Button>
        </>
      }
    >
      <form
        id="passkeys-card-form"
        className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}
        onSubmit={(event) => {
          event.preventDefault();
          if (register.isPending) {
            return;
          }
          const trimmed = name.trim();
          if (trimmed.length === 0 || trimmed.length > 80) {
            setNameError(true);
            return;
          }
          setNameError(false);
          register.mutate(trimmed);
        }}
      >
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <Label htmlFor="passkey-name">{t('pages.passkeys.nameLabel')}</Label>
          <Input
            id="passkey-name"
            value={name}
            maxLength={80}
            autoComplete="off"
            placeholder={t('pages.passkeys.namePlaceholder')}
            disabled={register.isPending}
            aria-invalid={nameError}
            aria-describedby={nameError ? 'passkey-name-error' : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(false);
            }}
          />
          {nameError ? (
            <p id="passkey-name-error" role="alert" className={css({ textStyle: 'body', color: 'error-text' })}>
              {t('pages.passkeys.invalidName')}
            </p>
          ) : null}
          {register.isError ? (
            <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {passkeyErrorMessage(register.error)}
            </p>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
