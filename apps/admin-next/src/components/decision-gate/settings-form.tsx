import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { Textarea } from '@tuuject/koi-react/textarea';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormActionBar, SettingRow } from '@/components/business';
import {
  type DecisionGateFieldSpec,
  type DraftError,
  type DraftValue,
  draftChangeCount,
  draftOf,
  fieldSpec,
  parseDraft,
} from '@/components/decision-gate/fields.ts';
import { Panel } from '@/components/layout/panel';
import { SecretField } from '@/components/secret-input/secret-field.tsx';
import type { DecisionGatePatch, DecisionGateValues, DecisionGateView } from '@/lib/api/decision-gate.ts';
import type { SecretInput, SecretSource } from '@/lib/api/keychain.ts';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { decisionGateQuery, keychainQuery } from '@/lib/queries';
import { initialSecretDraft, type SecretDraft, secretValueOf } from '@/lib/secret-draft.ts';

const SUGGESTED_KEY_NAME = 'decision-gate';

/** The save mutation lives on the page, so its error survives the remount a new revision causes. */
export interface DecisionGateSave {
  readonly mutate: (input: {
    readonly patch: Omit<DecisionGatePatch, 'api_key'>;
    readonly revision: string;
    readonly withSecret: boolean;
  }) => void;
  /** Parks a submitted plaintext outside the mutation variables while the save runs. */
  readonly holdSecret: (secret: SecretInput) => void;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly reset: () => void;
}

function useFieldError(error: DraftError | undefined): string | undefined {
  const { t } = useTranslation();
  if (error === undefined) {
    return undefined;
  }
  switch (error.key) {
    case 'integer':
      return t('decisionGate.errors.integer');
    case 'number':
      return t('decisionGate.errors.number');
    case 'min':
      return t('decisionGate.errors.min', { limit: error.limit });
    case 'max':
      return t('decisionGate.errors.max', { limit: error.limit });
    case 'required':
      return t('decisionGate.errors.required');
    case 'option':
      return t('decisionGate.errors.option');
  }
}

function useDisplayValue(key: keyof DecisionGateValues): (value: unknown) => string {
  const { t } = useTranslation();
  return (value: unknown): string => {
    if (key === 'enabled') {
      return value === true ? t('decisionGate.on') : t('decisionGate.off');
    }
    if (key === 'mode') {
      return value === 'enforce' ? t('decisionGate.modeEnforce') : t('decisionGate.modeShadow');
    }
    return String(value);
  };
}

/**
 * The entry gate's global section. Fields are a patch: only what the user
 * changed is sent, and clearing the question sends `null`, which restores the
 * default text. Its identity is the revision plus the page's save generation,
 * so a form that saved in place (an unchanged file, or a key rotation that
 * leaves `config.jsonc` alone) restarts from the server's view instead of
 * keeping the submitted plaintext.
 */
export function DecisionGateForm({
  initial,
  save,
}: {
  readonly initial: DecisionGateView;
  readonly save: DecisionGateSave;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const keychain = useQuery(keychainQuery);
  const entries = (keychain.data?.entries ?? []).map((entry) => entry.name);
  const [baseline] = useState(() => draftOf(initial.saved));
  const [draft, setDraft] = useState<Record<string, DraftValue>>(baseline);
  const [secret, setSecret] = useState<SecretDraft>(() =>
    initialSecretDraft(initial.key_source ?? null, SUGGESTED_KEY_NAME),
  );
  const parsed = parseDraft(draft, initial.saved, baseline);
  const secretValue = secretValueOf(secret, SUGGESTED_KEY_NAME);
  // The dirty state follows raw drafts, so an invalid edit still enables Discard;
  // only a field that actually becomes a patch value enables Save.
  const dirty = draftChangeCount(draft, baseline) + (secretValue === null ? 0 : 1);
  const patchable = Object.keys(parsed.changes).length > 0 || secretValue !== null;
  const invalid = Object.keys(parsed.errors).length > 0;
  const conflict = save.isError && isConfigConflict(save.error);
  const setValue = (key: string, value: DraftValue): void => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };
  const status = invalid
    ? t('decisionGate.invalid')
    : dirty === 0
      ? t('decisionGate.unchanged')
      : t('decisionGate.pending', { count: dirty });
  const question = typeof draft.instructions === 'string' ? draft.instructions : '';

  return (
    <form
      noValidate
      className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}
      onSubmit={(event) => {
        event.preventDefault();
        if (!patchable || invalid || save.isPending) {
          return;
        }
        if (secretValue !== null) {
          save.holdSecret(secretValue);
        }
        save.mutate({
          patch: parsed.changes,
          revision: initial.revision,
          withSecret: secretValue !== null,
        });
      }}
    >
      <fieldset disabled={save.isPending} className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
        <Panel title={t('decisionGate.behaviourTitle')}>
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '5' })}>
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
              <SettingRow label={t('decisionGate.enabled')}>
                {({ id }) => (
                  <Switch
                    id={id}
                    checked={draft.enabled === true}
                    onCheckedChange={(checked) => setValue('enabled', checked)}
                  />
                )}
              </SettingRow>
              <RunningNote
                active={initial.active.enabled}
                saved={initial.saved.enabled}
                display={(value) => (value === true ? t('decisionGate.on') : t('decisionGate.off'))}
              />
            </div>
            <div
              className={css({
                display: 'grid',
                gap: '5',
                md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
              })}
            >
              <SelectField
                label={t('decisionGate.mode')}
                spec={fieldSpec('mode')}
                value={typeof draft.mode === 'string' ? draft.mode : 'shadow'}
                error={parsed.errors.mode}
                active={initial.active.mode}
                saved={initial.saved.mode}
                onChange={(value) => setValue('mode', value)}
              />
              <NumberField
                label={t('decisionGate.threshold')}
                spec={fieldSpec('threshold')}
                value={typeof draft.threshold === 'string' ? draft.threshold : ''}
                error={parsed.errors.threshold}
                active={initial.active.threshold}
                saved={initial.saved.threshold}
                onChange={(value) => setValue('threshold', value)}
              />
              <NumberField
                label={t('decisionGate.historyMessages')}
                spec={fieldSpec('history_messages')}
                value={typeof draft.history_messages === 'string' ? draft.history_messages : ''}
                error={parsed.errors.history_messages}
                active={initial.active.history_messages}
                saved={initial.saved.history_messages}
                onChange={(value) => setValue('history_messages', value)}
              />
              <NumberField
                label={t('decisionGate.pendingMessages')}
                spec={fieldSpec('pending_messages')}
                value={typeof draft.pending_messages === 'string' ? draft.pending_messages : ''}
                error={parsed.errors.pending_messages}
                active={initial.active.pending_messages}
                saved={initial.saved.pending_messages}
                onChange={(value) => setValue('pending_messages', value)}
              />
            </div>
            <Field label={t('decisionGate.instructions')}>
              <Textarea
                rows={6}
                value={question}
                onChange={(event) => setValue('instructions', event.target.value)}
                dir="auto"
              />
            </Field>
            <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
              <Button
                type="button"
                variant="outline"
                color="secondary"
                disabled={question.trim().length === 0}
                onClick={() => setValue('instructions', '')}
              >
                {t('decisionGate.useDefaultQuestion')}
              </Button>
              {question.trim().length === 0 ? (
                <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
                  {t('decisionGate.questionResetHint')}
                </p>
              ) : null}
            </div>
            <RunningNote
              active={initial.active.instructions}
              saved={initial.saved.instructions}
              display={(value) => String(value)}
            />
          </div>
        </Panel>

        <Panel title={t('decisionGate.connectionTitle')}>
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '5' })}>
            <div
              className={css({
                display: 'grid',
                gap: '5',
                md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
              })}
            >
              <TextField
                label={t('decisionGate.model')}
                spec={fieldSpec('model')}
                value={typeof draft.model === 'string' ? draft.model : ''}
                error={parsed.errors.model}
                active={initial.active.model}
                saved={initial.saved.model}
                onChange={(value) => setValue('model', value)}
              />
              <TextField
                label={t('decisionGate.baseUrl')}
                spec={fieldSpec('base_url')}
                value={typeof draft.base_url === 'string' ? draft.base_url : ''}
                error={parsed.errors.base_url}
                active={initial.active.base_url}
                saved={initial.saved.base_url}
                onChange={(value) => setValue('base_url', value)}
              />
              <NumberField
                label={t('decisionGate.timeout')}
                spec={fieldSpec('timeout_ms')}
                value={typeof draft.timeout_ms === 'string' ? draft.timeout_ms : ''}
                error={parsed.errors.timeout_ms}
                active={initial.active.timeout_ms}
                saved={initial.saved.timeout_ms}
                onChange={(value) => setValue('timeout_ms', value)}
              />
            </div>
            <SecretField
              label={t('decisionGate.apiKey')}
              draft={secret}
              source={initial.key_source ?? null}
              entries={entries}
              suggestedName={SUGGESTED_KEY_NAME}
              disabled={save.isPending}
              onChange={setSecret}
              idPrefix="decision-gate-key"
            />
            <KeySourceLine source={initial.key_source ?? null} />
          </div>
        </Panel>
      </fieldset>

      {conflict ? (
        <Alert
          tone="error"
          title={t('decisionGate.conflictTitle')}
          role="alert"
          action={
            <Button
              size="sm"
              variant="ghost"
              color="secondary"
              onClick={() => {
                // The mutation lives above the form, so a new revision remounts
                // the form but does not clear the old error by itself.
                save.reset();
                void queryClient.invalidateQueries({ queryKey: decisionGateQuery.queryKey });
              }}
            >
              {t('common.reload')}
            </Button>
          }
        >
          {t('decisionGate.conflictBody')}
        </Alert>
      ) : save.isError ? (
        <Alert tone="error" role="alert">
          {errorMessage(save.error)}
        </Alert>
      ) : null}
      <FormActionBar
        status={status}
        submitting={save.isPending}
        submitLabel={t('decisionGate.save')}
        submittingLabel={t('decisionGate.saving')}
        submitDisabled={!patchable || invalid || conflict}
        discardLabel={t('decisionGate.discard')}
        discardDisabled={dirty === 0}
        onDiscard={() => {
          save.reset();
          setDraft(baseline);
          setSecret(initialSecretDraft(initial.key_source ?? null, SUGGESTED_KEY_NAME));
        }}
      />
    </form>
  );
}

function RunningNote({
  active,
  saved,
  display,
}: {
  readonly active: unknown;
  readonly saved: unknown;
  readonly display: (value: unknown) => string;
}): ReactElement | null {
  const { t } = useTranslation();
  return active === saved ? null : (
    <p role="status" className={css({ margin: '0', textStyle: 'small', color: 'warning-text' })}>
      {t('decisionGate.running', { value: display(active) })}
    </p>
  );
}

function SelectField({
  label,
  spec,
  value,
  error,
  active,
  saved,
  onChange,
}: {
  readonly label: string;
  readonly spec: DecisionGateFieldSpec;
  readonly value: string;
  readonly error: DraftError | undefined;
  readonly active: string;
  readonly saved: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const message = useFieldError(error);
  const display = useDisplayValue(spec.key);
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
      <Field label={label} error={message}>
        <Select value={value} onChange={(event) => onChange(event.target.value)}>
          {(spec.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option === 'enforce' ? t('decisionGate.modeEnforce') : t('decisionGate.modeShadow')}
            </option>
          ))}
        </Select>
      </Field>
      <RunningNote active={active} saved={saved} display={display} />
    </div>
  );
}

function NumberField({
  label,
  spec,
  value,
  error,
  active,
  saved,
  onChange,
}: {
  readonly label: string;
  readonly spec: DecisionGateFieldSpec;
  readonly value: string;
  readonly error: DraftError | undefined;
  readonly active: number;
  readonly saved: number;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const message = useFieldError(error);
  const display = useDisplayValue(spec.key);
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
      <Field label={label} error={message}>
        <Input
          type="number"
          inputMode={spec.kind === 'number' ? 'decimal' : 'numeric'}
          min={spec.min}
          max={spec.max}
          step={spec.kind === 'number' ? '0.01' : 1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          dir="ltr"
        />
      </Field>
      <RunningNote active={active} saved={saved} display={display} />
    </div>
  );
}

function TextField({
  label,
  spec,
  value,
  error,
  active,
  saved,
  onChange,
}: {
  readonly label: string;
  readonly spec: DecisionGateFieldSpec;
  readonly value: string;
  readonly error: DraftError | undefined;
  readonly active: string;
  readonly saved: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const message = useFieldError(error);
  const display = useDisplayValue(spec.key);
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
      <Field label={label} error={message}>
        <Input
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          dir="ltr"
        />
      </Field>
      <RunningNote active={active} saved={saved} display={display} />
    </div>
  );
}

function KeySourceLine({ source }: { readonly source: SecretSource }): ReactElement | null {
  const { t } = useTranslation();
  if (source?.kind === 'entry') {
    return (
      <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
        {t('decisionGate.keyFromEntry', { name: source.name })}
      </p>
    );
  }
  return null;
}
