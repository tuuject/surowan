import { startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { field } from '@tuuject/koi-react/styled-system/recipes';
import { type ReactElement, useState } from 'react';
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
import type { PasskeyItem } from '@/lib/api/auth.ts';
import { deletePasskey, deletePassword, passkeyRegisterOptions, passkeyRegisterVerify } from '@/lib/api/auth.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { isWebAuthnAvailable, passkeyErrorMessage } from '@/lib/passkeys';
import { passkeysQuery, sessionQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

/** Koi Field's label, for the few controls that share one label with a status line or a second control. */
const fieldLabel = field().label;

const REGISTER_FORM_ID = 'passkeys-card-form';

/**
 * Passkey management card for the Settings page. Rendered only when the
 * session reports `passkeys_enabled`; the WebAuthn ceremony runs in the
 * browser via @simplewebauthn/browser and never exposes credentials to the
 * panel's own storage.
 */
export function PasskeysCard(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const webAuthnAvailable = isWebAuthnAvailable();
  // `open` stays apart from the values a dialog shows: closing flips only the boolean,
  // so the title and body stay put while the 300 ms exit fade plays. The registration
  // nonce remounts the dialog's inner form, so the next open starts from a clean draft.
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerNonce, setRegisterNonce] = useState(0);
  const [deleting, setDeleting] = useState<PasskeyItem | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
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
      setDeleteOpen(false);
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
            setDeleteOpen(true);
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
          <Button
            type="button"
            disabled={!webAuthnAvailable}
            onClick={() => {
              setRegisterNonce((previous) => previous + 1);
              setRegisterOpen(true);
            }}
          >
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
      <RegisterPasskeyDialog open={registerOpen} formKey={registerNonce} onOpenChange={setRegisterOpen} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleteOpen(false);
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

interface RegisterInput {
  readonly name: string;
  /** The open this attempt belongs to; a failure never surfaces in a later open. */
  readonly generation: number;
}

/**
 * The name draft. The dialog root stays mounted for its transitions, so this inner
 * form is what the card remounts (`key={formKey}`) to start each open empty.
 */
function RegisterPasskeyForm({
  pending,
  error,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (name: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);
  return (
    <form
      id={REGISTER_FORM_ID}
      className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) {
          return;
        }
        const trimmed = name.trim();
        if (trimmed.length === 0 || trimmed.length > 80) {
          setNameError(true);
          return;
        }
        setNameError(false);
        onSubmit(trimmed);
      }}
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <label htmlFor="passkey-name" className={fieldLabel}>
          {t('pages.passkeys.nameLabel')}
        </label>
        <Input
          id="passkey-name"
          value={name}
          maxLength={80}
          autoComplete="off"
          placeholder={t('pages.passkeys.namePlaceholder')}
          disabled={pending}
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
        {error === null ? null : (
          <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {passkeyErrorMessage(error)}
          </p>
        )}
      </div>
    </form>
  );
}

function RegisterPasskeyDialog({
  open,
  formKey,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly formKey: number;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const register = useMutation({
    mutationFn: async (input: RegisterInput) => {
      const options = await passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: options });
      return passkeyRegisterVerify(input.name, response);
    },
    retry: false,
    gcTime: 0,
    onSuccess: () => {
      toast.success(t('pages.passkeys.registered'));
      onOpenChange(false);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    },
  });
  const failure = register.isError && register.variables?.generation === formKey ? register.error : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && register.isPending) {
          return;
        }
        onOpenChange(next);
      }}
      title={t('pages.passkeys.registerTitle')}
      description={t('pages.passkeys.registerDescription')}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            color="secondary"
            disabled={register.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={REGISTER_FORM_ID} disabled={register.isPending}>
            {register.isPending ? t('pages.passkeys.registering') : t('pages.passkeys.registerConfirm')}
          </Button>
        </>
      }
    >
      <RegisterPasskeyForm
        key={formKey}
        pending={register.isPending}
        error={failure}
        onSubmit={(name) => register.mutate({ name, generation: formKey })}
      />
    </Dialog>
  );
}
