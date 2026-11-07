import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdminApiKeyItem, ApiKeyMode } from '@/lib/api/admin.ts';
import { createApiKey, rotateApiKey, updateApiKeyMode } from '@/lib/api/admin.ts';
import { errorMessage } from '@/lib/errors';
import { apiKeysQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

export const MODES: readonly ApiKeyMode[] = ['read', 'read_write', 'read_paid', 'all'];

type CopyState = 'idle' | 'pending' | 'copied' | 'failed';

const CREATE_FORM_ID = 'api-key-create-form';

function ModeSelect({
  value,
  disabled,
  onChange,
}: {
  readonly value: ApiKeyMode;
  readonly disabled?: boolean;
  readonly onChange: (mode: ApiKeyMode) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Select
      value={value}
      disabled={disabled ?? false}
      onChange={(event) => {
        const selected = MODES.find((candidate) => candidate === event.target.value);
        if (selected !== undefined) {
          onChange(selected);
        }
      }}
      options={MODES.map((mode) => ({ value: mode, label: t(`pages.apiKeys.modes.${mode}`) }))}
    />
  );
}

function RequestError({ error }: { readonly error: unknown }): React.ReactElement {
  return (
    <p role="alert" className={css({ color: 'error-text', overflowWrap: 'anywhere' })}>
      {errorMessage(error)}
    </p>
  );
}

/** The one-time plaintext. It lives only in the dialog's own state, which unmounts when the dialog closes. */
function KeyReveal({ plaintext, copyState }: { readonly plaintext: string; readonly copyState: CopyState }) {
  const { t } = useTranslation();
  const status =
    copyState === 'failed' ? t('pages.apiKeys.copyFailed') : copyState === 'copied' ? t('common.copied') : undefined;
  return (
    <Field label={t('pages.apiKeys.keyLabel')} {...(copyState === 'failed' ? { error: status } : { help: status })}>
      <Textarea
        value={plaintext}
        readOnly
        rows={3}
        autoComplete="off"
        spellCheck={false}
        className={css({ resize: 'none', wordBreak: 'break-all', fontFamily: 'mono' })}
        onFocus={(event) => event.target.select()}
      />
    </Field>
  );
}

function KeyRevealFooter({
  plaintext,
  copyState,
  setCopyState,
  onClose,
}: {
  readonly plaintext: string;
  readonly copyState: CopyState;
  readonly setCopyState: (state: CopyState) => void;
  readonly onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <Button
        variant="ghost"
        color="secondary"
        loading={copyState === 'pending'}
        onClick={async () => {
          setCopyState('pending');
          try {
            await navigator.clipboard.writeText(plaintext);
            setCopyState('copied');
          } catch {
            setCopyState('failed');
          }
        }}
      >
        {t('pages.apiKeys.copy')}
      </Button>
      <Button onClick={onClose}>{t('pages.apiKeys.done')}</Button>
    </>
  );
}

/**
 * Mounted only while open: closing drops the component, and the one-time key with it, instead of hiding it.
 */
export function CreateKeyDialog({ onClose }: { readonly onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ApiKeyMode>('read');
  const [nameError, setNameError] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const create = useMutation({
    // Return nothing: mutation/query caches must never retain the one-time key.
    mutationFn: async (input: { readonly name: string; readonly mode: ApiKeyMode }): Promise<void> => {
      const result = await createApiKey(input.name, input.mode);
      setPlaintext(result.key);
    },
    gcTime: 0,
    retry: false,
    onSettled: () => {
      // A lost create response can still have issued a key; refresh metadata so it can be revoked.
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !create.isPending && onClose()}
      title={plaintext === null ? t('pages.apiKeys.create') : t('pages.apiKeys.saveTitle')}
      description={plaintext === null ? t('pages.apiKeys.createDescription') : t('pages.apiKeys.saveDescription')}
      footer={
        plaintext === null ? (
          <>
            <Button variant="ghost" color="secondary" disabled={create.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              form={CREATE_FORM_ID}
              loading={create.isPending}
              loadingLabel={t('pages.apiKeys.creating')}
            >
              {t('pages.apiKeys.createConfirm')}
            </Button>
          </>
        ) : (
          <KeyRevealFooter plaintext={plaintext} copyState={copyState} setCopyState={setCopyState} onClose={onClose} />
        )
      }
    >
      {plaintext === null ? (
        <form
          id={CREATE_FORM_ID}
          noValidate
          className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}
          onSubmit={(event) => {
            event.preventDefault();
            if (create.isPending) {
              return;
            }
            const trimmed = name.trim();
            if (trimmed.length === 0 || trimmed.length > 80) {
              setNameError(true);
              return;
            }
            setNameError(false);
            create.mutate({ name: trimmed, mode });
          }}
        >
          <Field label={t('pages.apiKeys.name')} error={nameError ? t('pages.apiKeys.invalidName') : undefined}>
            <Input
              value={name}
              maxLength={80}
              autoComplete="off"
              placeholder={t('pages.apiKeys.namePlaceholder')}
              disabled={create.isPending}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(false);
              }}
            />
          </Field>
          <Field label={t('pages.apiKeys.mode')} help={t(`pages.apiKeys.modeHints.${mode}`)}>
            <ModeSelect value={mode} disabled={create.isPending} onChange={setMode} />
          </Field>
          {create.isError ? <RequestError error={create.error} /> : null}
        </form>
      ) : (
        <KeyReveal plaintext={plaintext} copyState={copyState} />
      )}
    </Dialog>
  );
}

export function EditModeDialog({
  item,
  onClose,
}: {
  readonly item: AdminApiKeyItem;
  readonly onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ApiKeyMode>(item.mode ?? 'read');
  const update = useMutation({
    mutationFn: (next: ApiKeyMode) => updateApiKeyMode(item.id, next),
    retry: false,
    onSuccess: () => {
      toast.success(t('pages.apiKeys.modeUpdated'));
      onClose();
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !update.isPending && onClose()}
      title={t('pages.apiKeys.editMode')}
      description={t('pages.apiKeys.editModeDescription', { name: item.name })}
      footer={
        <>
          <Button variant="ghost" color="secondary" disabled={update.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={update.isPending} loadingLabel={t('common.saving')} onClick={() => update.mutate(mode)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        <Field
          label={t('pages.apiKeys.mode')}
          help={t(`pages.apiKeys.modeHints.${mode}`)}
          error={item.mode === null ? t('pages.apiKeys.invalidPermissionsHint') : undefined}
        >
          <ModeSelect value={mode} disabled={update.isPending} onChange={setMode} />
        </Field>
        {update.isError ? <RequestError error={update.error} /> : null}
      </div>
    </Dialog>
  );
}

export function RotateKeyDialog({
  item,
  onClose,
}: {
  readonly item: AdminApiKeyItem;
  readonly onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const rotate = useMutation({
    mutationFn: async (): Promise<void> => {
      const result = await rotateApiKey(item.id);
      setPlaintext(result.key);
    },
    gcTime: 0,
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !rotate.isPending && onClose()}
      {...(plaintext === null ? { role: 'alertdialog' as const } : {})}
      title={plaintext === null ? t('pages.apiKeys.rotateTitle') : t('pages.apiKeys.saveTitle')}
      description={
        plaintext === null
          ? t('pages.apiKeys.rotateDescription', { name: item.name })
          : t('pages.apiKeys.saveDescription')
      }
      footer={
        plaintext === null ? (
          <>
            <Button variant="ghost" color="secondary" disabled={rotate.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              color="warning"
              loading={rotate.isPending}
              loadingLabel={t('common.saving')}
              onClick={() => rotate.mutate()}
            >
              {t('pages.apiKeys.rotateConfirm')}
            </Button>
          </>
        ) : (
          <KeyRevealFooter plaintext={plaintext} copyState={copyState} setCopyState={setCopyState} onClose={onClose} />
        )
      }
    >
      {plaintext === null ? (
        rotate.isError ? (
          <RequestError error={rotate.error} />
        ) : null
      ) : (
        <KeyReveal plaintext={plaintext} copyState={copyState} />
      )}
    </Dialog>
  );
}
