import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeychainEntryView } from '@/lib/api/keychain.ts';
import { createKeychainEntry } from '@/lib/api/keychain.ts';
import { errorMessage } from '@/lib/errors';
import { keychainQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function RequestError({ error }: { readonly error: unknown }): ReactElement {
  return (
    <p role="alert" className={css({ color: 'error-text', overflowWrap: 'anywhere' })}>
      {errorMessage(error)}
    </p>
  );
}

export function CreateEntryDialog({
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
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const create = useMutation({
    // Return nothing: the mutation cache must never retain the submitted value.
    mutationFn: async (): Promise<void> => {
      await createKeychainEntry(name, value);
    },
    gcTime: 0,
    retry: false,
    onSuccess: () => {
      // Clear before closing: the exit fade must not hold the plaintext.
      setValue('');
      onOpenChange(false);
      toast.success(t('pages.keychain.createdMessage', { name }));
      void queryClient.invalidateQueries({ queryKey: keychainQuery.queryKey });
    },
  });
  // Cancel clears the typed value too: no close path leaves plaintext behind.
  const dismiss = (): void => {
    setValue('');
    onOpenChange(false);
  };
  // The form remounts on every open (the page bumps `formKey`), so the state
  // hooks below re-initialize: useState reads the initial value once per mount.
  void formKey;
  const invalidName = name.length > 0 && !NAME_PATTERN.test(name);
  const usable = name.length > 0 && value.length > 0 && !invalidName;
  return (
    <Dialog
      open={open}
      // The submitted value is cleared the moment the dialog starts closing,
      // so even the exit fade holds no plaintext.
      onOpenChange={(next) => {
        if (!next) {
          setValue('');
        }
        onOpenChange(next);
      }}
      title={t('pages.keychain.createTitle')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" color="secondary" onClick={dismiss}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!usable} loading={create.isPending} onClick={() => create.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        <Field
          label={t('pages.keychain.nameColumn')}
          help={t('common.secret.nameHint')}
          error={invalidName ? t('common.secret.nameInvalid') : undefined}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} dir="ltr" autoComplete="off" />
        </Field>
        <Field label={t('pages.keychain.valueLabel')} help={t('common.secret.valueHint')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            dir="ltr"
          />
        </Field>
        {create.error !== null ? <RequestError error={create.error} /> : null}
      </div>
    </Dialog>
  );
}

export function RotateEntryDialog({
  open,
  entry,
  formKey,
  pending,
  error,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly entry: KeychainEntryView | null;
  readonly formKey: number;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  void formKey;
  const usable = entry !== null && value.length > 0;
  return (
    <Dialog
      open={open}
      // The submitted value is cleared the moment the dialog starts closing,
      // so even the exit fade holds no plaintext.
      onOpenChange={(next) => {
        if (!next) {
          setValue('');
        }
        onOpenChange(next);
      }}
      title={t('pages.keychain.rotateTitle', { name: entry?.name ?? '' })}
      size="sm"
      footer={
        <>
          <Button
            variant="ghost"
            color="secondary"
            onClick={() => {
              setValue('');
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button disabled={!usable} loading={pending} onClick={() => onConfirm(value)}>
            {t('pages.keychain.rotateAction')}
          </Button>
        </>
      }
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        <Field label={t('pages.keychain.valueLabel')} help={t('pages.keychain.rotateHint')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            dir="ltr"
          />
        </Field>
        {error !== null ? <RequestError error={error} /> : null}
      </div>
    </Dialog>
  );
}
