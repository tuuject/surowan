import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdminApiKeyItem, ApiKeyMode } from '@/lib/api/admin.ts';
import { createApiKey, rotateApiKey, updateApiKeyMode } from '@/lib/api/admin.ts';
import { errorMessage } from '@/lib/errors';
import { apiKeysQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

export const MODES: readonly ApiKeyMode[] = ['read', 'read_write', 'read_paid', 'all'];

type CopyState = 'idle' | 'pending' | 'copied' | 'failed';

/**
 * Copy feedback for one open of a reveal dialog. A clipboard write can still be
 * pending when the dialog closes, so its outcome is filed under the open that
 * started it: a later open reads as idle, and a late outcome never replaces
 * the feedback of a newer open.
 */
function useCopyState(formKey: number): readonly [CopyState, (state: CopyState) => void] {
  const [copy, setCopy] = useState<{ readonly generation: number; readonly state: CopyState }>({
    generation: formKey,
    state: 'idle',
  });
  return [
    copy.generation === formKey ? copy.state : 'idle',
    (state) => setCopy((previous) => (previous.generation > formKey ? previous : { generation: formKey, state })),
  ];
}

const CREATE_FORM_ID = 'api-key-create-form';
const EDIT_MODE_FORM_ID = 'api-key-edit-mode-form';

/**
 * The one-time key produced during one open of a dialog. `generation` ties it to that
 * open (the page's per-open `formKey`), so a later open starts from the form again.
 */
interface KeyReveal {
  readonly generation: number;
  /** Null once the dialog closes: the plaintext never outlives the open dialog. */
  readonly plaintext: string | null;
}

function ModeSelect({
  value,
  disabled,
  onChange,
}: {
  readonly value: ApiKeyMode;
  readonly disabled?: boolean;
  readonly onChange: (mode: ApiKeyMode) => void;
}): ReactElement {
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

function RequestError({ error }: { readonly error: unknown }): ReactElement {
  return (
    <p role="alert" className={css({ color: 'error-text', overflowWrap: 'anywhere' })}>
      {errorMessage(error)}
    </p>
  );
}

/** The one-time plaintext. It is shown from the dialog's own state and is never stored anywhere. */
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

/** `plaintext` is null while the dialog fades out: the key is already gone, so copying is off. */
function KeyRevealFooter({
  plaintext,
  copyState,
  setCopyState,
  onClose,
}: {
  readonly plaintext: string | null;
  readonly copyState: CopyState;
  readonly setCopyState: (state: CopyState) => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <Button
        variant="ghost"
        color="secondary"
        disabled={plaintext === null}
        loading={copyState === 'pending'}
        onClick={async () => {
          if (plaintext === null) {
            return;
          }
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

interface CreateKeyInput {
  readonly name: string;
  readonly mode: ApiKeyMode;
  /** The open this attempt belongs to; a failure never surfaces in a later open. */
  readonly generation: number;
}

/**
 * The create form's own draft. The dialog root stays mounted for its transitions, so this
 * inner component is what the page remounts (`key={formKey}`) to start each open empty.
 */
function CreateKeyForm({
  pending,
  error,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (input: { readonly name: string; readonly mode: ApiKeyMode }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ApiKeyMode>('read');
  const [nameError, setNameError] = useState(false);
  return (
    <form
      id={CREATE_FORM_ID}
      noValidate
      className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}
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
        onSubmit({ name: trimmed, mode });
      }}
    >
      <Field label={t('pages.apiKeys.name')} error={nameError ? t('pages.apiKeys.invalidName') : undefined}>
        <Input
          value={name}
          maxLength={80}
          autoComplete="off"
          placeholder={t('pages.apiKeys.namePlaceholder')}
          disabled={pending}
          onChange={(event) => {
            setName(event.target.value);
            setNameError(false);
          }}
        />
      </Field>
      <Field label={t('pages.apiKeys.mode')} help={t(`pages.apiKeys.modeHints.${mode}`)}>
        <ModeSelect value={mode} disabled={pending} onChange={setMode} />
      </Field>
      {error === null ? null : <RequestError error={error} />}
    </form>
  );
}

export function CreateKeyDialog({
  open,
  onOpenChange,
  formKey,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Bumped on every open: the form starts empty without remounting the dialog root. */
  readonly formKey: number;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reveal, setReveal] = useState<KeyReveal | null>(null);
  const [copyState, setCopyState] = useCopyState(formKey);
  const create = useMutation({
    // Return nothing: mutation/query caches must never retain the one-time key.
    mutationFn: async (input: CreateKeyInput): Promise<void> => {
      const result = await createApiKey(input.name, input.mode);
      setReveal({ generation: input.generation, plaintext: result.key });
    },
    gcTime: 0,
    retry: false,
    onSettled: () => {
      // A lost create response can still have issued a key; refresh metadata so it can be revoked.
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });

  // The one-time key must never outlive the open dialog, so it is dropped in the same
  // render that starts the exit transition. The dialog root stays mounted for the 300 ms
  // fade, which leaves the reveal body empty on purpose: that is the security rule, not
  // a missing transition. Nothing is written to storage at any point.
  if (!open && reveal !== null && reveal.plaintext !== null) {
    setReveal({ generation: reveal.generation, plaintext: null });
    setCopyState('idle');
  }

  const current = reveal !== null && reveal.generation === formKey ? reveal : null;
  const revealing = current !== null;
  const plaintext = current === null ? null : current.plaintext;
  const failure = create.isError && create.variables?.generation === formKey ? create.error : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && create.isPending) {
          return;
        }
        onOpenChange(next);
      }}
      title={revealing ? t('pages.apiKeys.saveTitle') : t('pages.apiKeys.create')}
      description={revealing ? t('pages.apiKeys.saveDescription') : t('pages.apiKeys.createDescription')}
      footer={
        revealing ? (
          <KeyRevealFooter
            plaintext={plaintext}
            copyState={copyState}
            setCopyState={setCopyState}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <>
            <Button variant="ghost" color="secondary" disabled={create.isPending} onClick={() => onOpenChange(false)}>
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
        )
      }
    >
      {revealing ? (
        plaintext === null ? null : (
          <KeyReveal plaintext={plaintext} copyState={copyState} />
        )
      ) : (
        <CreateKeyForm
          key={formKey}
          pending={create.isPending}
          error={failure}
          onSubmit={(input) => create.mutate({ ...input, generation: formKey })}
        />
      )}
    </Dialog>
  );
}

interface UpdateModeInput {
  readonly id: string;
  readonly mode: ApiKeyMode;
  readonly generation: number;
}

/** The mode draft; remounted per open like `CreateKeyForm`. */
function EditModeForm({
  initialMode,
  invalidPermissions,
  pending,
  error,
  onSubmit,
}: {
  readonly initialMode: ApiKeyMode;
  readonly invalidPermissions: boolean;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (mode: ApiKeyMode) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ApiKeyMode>(initialMode);
  return (
    <form
      id={EDIT_MODE_FORM_ID}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) {
          onSubmit(mode);
        }
      }}
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        <Field
          label={t('pages.apiKeys.mode')}
          help={t(`pages.apiKeys.modeHints.${mode}`)}
          error={invalidPermissions ? t('pages.apiKeys.invalidPermissionsHint') : undefined}
        >
          <ModeSelect value={mode} disabled={pending} onChange={setMode} />
        </Field>
        {error === null ? null : <RequestError error={error} />}
      </div>
    </form>
  );
}

export function EditModeDialog({
  open,
  item,
  formKey,
  onOpenChange,
}: {
  readonly open: boolean;
  /** The row being edited; the page keeps it until the exit fade ends, so the text stays put. */
  readonly item: AdminApiKeyItem | null;
  readonly formKey: number;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (input: UpdateModeInput) => updateApiKeyMode(input.id, input.mode),
    retry: false,
    onSuccess: () => {
      toast.success(t('pages.apiKeys.modeUpdated'));
      onOpenChange(false);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });
  const failure = update.isError && update.variables?.generation === formKey ? update.error : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && update.isPending) {
          return;
        }
        onOpenChange(next);
      }}
      title={t('pages.apiKeys.editMode')}
      description={t('pages.apiKeys.editModeDescription', { name: item?.name ?? '' })}
      footer={
        <>
          <Button variant="ghost" color="secondary" disabled={update.isPending} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={EDIT_MODE_FORM_ID} loading={update.isPending} loadingLabel={t('common.saving')}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <EditModeForm
        key={formKey}
        initialMode={item?.mode ?? 'read'}
        invalidPermissions={item?.mode === null}
        pending={update.isPending}
        error={failure}
        onSubmit={(mode) => {
          if (item !== null) {
            update.mutate({ id: item.id, mode, generation: formKey });
          }
        }}
      />
    </Dialog>
  );
}

interface RotateInput {
  readonly id: string;
  readonly generation: number;
}

export function RotateKeyDialog({
  open,
  item,
  formKey,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly item: AdminApiKeyItem | null;
  readonly formKey: number;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reveal, setReveal] = useState<KeyReveal | null>(null);
  const [copyState, setCopyState] = useCopyState(formKey);
  const rotate = useMutation({
    mutationFn: async (input: RotateInput): Promise<void> => {
      const result = await rotateApiKey(input.id);
      setReveal({ generation: input.generation, plaintext: result.key });
    },
    gcTime: 0,
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });

  // Same security rule as CreateKeyDialog: the new key is dropped the moment the dialog
  // starts closing, so the fading body may be empty. The root stays mounted for the fade.
  if (!open && reveal !== null && reveal.plaintext !== null) {
    setReveal({ generation: reveal.generation, plaintext: null });
    setCopyState('idle');
  }

  const current = reveal !== null && reveal.generation === formKey ? reveal : null;
  const revealing = current !== null;
  const plaintext = current === null ? null : current.plaintext;
  const failure = rotate.isError && rotate.variables?.generation === formKey ? rotate.error : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && rotate.isPending) {
          return;
        }
        onOpenChange(next);
      }}
      // One stable role for the life of this instance: Koi picks Base UI's Dialog or
      // AlertDialog root from `role`, so flipping it would remount the popup and skip the
      // transition. Rotation is destructive, so it is an alertdialog throughout.
      role="alertdialog"
      title={revealing ? t('pages.apiKeys.saveTitle') : t('pages.apiKeys.rotateTitle')}
      description={
        revealing
          ? t('pages.apiKeys.saveDescription')
          : t('pages.apiKeys.rotateDescription', { name: item?.name ?? '' })
      }
      footer={
        revealing ? (
          <KeyRevealFooter
            plaintext={plaintext}
            copyState={copyState}
            setCopyState={setCopyState}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <>
            <Button variant="ghost" color="secondary" disabled={rotate.isPending} onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              color="warning"
              loading={rotate.isPending}
              loadingLabel={t('common.saving')}
              onClick={() => {
                if (item !== null) {
                  rotate.mutate({ id: item.id, generation: formKey });
                }
              }}
            >
              {t('pages.apiKeys.rotateConfirm')}
            </Button>
          </>
        )
      }
    >
      {revealing ? (
        plaintext === null ? null : (
          <KeyReveal plaintext={plaintext} copyState={copyState} />
        )
      ) : failure === null ? null : (
        <RequestError error={failure} />
      )}
    </Dialog>
  );
}
