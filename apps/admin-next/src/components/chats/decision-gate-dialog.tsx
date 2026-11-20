import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { Textarea } from '@tuuject/koi-react/textarea';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DECISION_GATE_BEHAVIOR_FIELDS, fieldSpec, parseField } from '@/components/decision-gate/fields.ts';
import type { ChatDecisionGateView, ChatEntry, ChatsView, DecisionGateChatPatch } from '@/lib/api/chats.ts';
import { updateChatDecisionGate } from '@/lib/api/chats.ts';
import type { DecisionGateValues } from '@/lib/api/decision-gate.ts';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { decisionGateQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';

/** One Chat's overrides: `null` for a field returns it to the global value. */
type ChatDraft = {
  readonly overridden: Readonly<Record<string, boolean>>;
  readonly values: Readonly<Record<string, string | boolean>>;
};

function initialDraft(chat: ChatEntry, global: DecisionGateValues): ChatDraft {
  const override: ChatDecisionGateView | null = chat.saved?.decision_gate ?? null;
  const overridden: Record<string, boolean> = {};
  const values: Record<string, string | boolean> = {};
  for (const spec of DECISION_GATE_BEHAVIOR_FIELDS) {
    const has = override !== null && Object.hasOwn(override, spec.key);
    overridden[spec.key] = has;
    const value = has ? (override as Readonly<Record<string, unknown>>)[spec.key] : global[spec.key];
    values[spec.key] = typeof value === 'boolean' ? value : String(value);
  }
  return { overridden, values };
}

export interface DecisionGateDialogProps {
  /** `open` stays apart from the chat so the title doesn't blank out while the exit fade plays. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly view: ChatsView;
  readonly chat: ChatEntry | null;
  /** Remounts the form for every open: saving never starts from the previous draft. */
  readonly formKey: number;
}

/**
 * Entry gate overrides for one Chat. The dialog root stays mounted for its
 * transitions; only the form inside remounts per open. Each field either keeps
 * the global value (`null` in the patch) or sets its own.
 */
export function DecisionGateDialog({ open, onOpenChange, view, chat, formKey }: DecisionGateDialogProps): ReactElement {
  const { t } = useTranslation();
  const formId = useId();
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) {
          return;
        }
        onOpenChange(next);
      }}
      title={t('pages.chats.decisionGateTitle')}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            color="secondary"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={pending} loadingLabel={t('common.saving')}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {chat === null ? null : (
        <DecisionGateForm
          key={formKey}
          formId={formId}
          view={view}
          chat={chat}
          onClose={() => onOpenChange(false)}
          onPendingChange={setPending}
        />
      )}
    </Dialog>
  );
}

function DecisionGateForm({
  formId,
  view,
  chat,
  onClose,
  onPendingChange,
}: {
  readonly formId: string;
  /** The whole view is captured when opened: background refetches cannot upgrade a stale form's revision. */
  readonly view: ChatsView;
  readonly chat: ChatEntry;
  readonly onClose: () => void;
  readonly onPendingChange: (pending: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const global = useQuery(decisionGateQuery);
  const [draft, setDraft] = useState<ChatDraft | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const globalValues = global.data?.saved;
  const initialOverride: ChatDecisionGateView | null = chat.saved?.decision_gate ?? null;
  // The form mounts with the dialog; derive its draft from the first global
  // view rather than resetting it from an effect when the query resolves.
  const current = draft ?? (globalValues === undefined ? null : initialDraft(chat, globalValues));
  const save = useMutation({
    mutationFn: (patch: DecisionGateChatPatch) => updateChatDecisionGate(chat.id, patch, view.revision),
    onMutate: () => onPendingChange(true),
    onSuccess: (result) => {
      write.succeeded(result.apply);
      onClose();
    },
    onError: (error) => {
      write.failed(error);
      if (isConfigConflict(error)) {
        onClose();
        toast.error(t('pages.chats.configConflictEdit'));
      }
    },
    onSettled: () => onPendingChange(false),
  });
  const toggle = (key: string, checked: boolean): void => {
    if (current === null) {
      return;
    }
    setDraft({ ...current, overridden: { ...current.overridden, [key]: checked } });
    setValidation(null);
  };
  const setValue = (key: string, value: string | boolean): void => {
    if (current === null) {
      return;
    }
    setDraft({ ...current, values: { ...current.values, [key]: value } });
    setValidation(null);
  };
  /**
   * The value a control shows: this Chat's own draft while it overrides the
   * field, the global value while it inherits. The draft keeps the Chat's value
   * (or the inherited one from when the dialog opened) so re-checking the box
   * restores what the user had.
   */
  const shown = (key: string): string | boolean => {
    if (current === null) {
      return '';
    }
    if (current.overridden[key] === true) {
      return current.values[key] ?? '';
    }
    const value = globalValues?.[key as keyof DecisionGateValues];
    return typeof value === 'boolean' ? value : String(value ?? '');
  };
  const submit = (): void => {
    if (current === null) {
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const spec of DECISION_GATE_BEHAVIOR_FIELDS) {
      const wasSet = initialOverride !== null && Object.hasOwn(initialOverride, spec.key);
      if (current.overridden[spec.key] !== true) {
        // `null` only removes an override this Chat actually had; a field that
        // already inherits is left out of the patch entirely.
        if (wasSet) {
          patch[spec.key] = null;
        }
        continue;
      }
      const parsed = parseField(spec, current.values[spec.key] ?? '');
      // `null` would remove the override instead of setting it: an overridden
      // field always needs a value.
      if (parsed === null || (typeof parsed === 'object' && parsed !== null)) {
        setValidation(t('pages.chats.decisionGateInvalid'));
        return;
      }
      if (wasSet && (initialOverride as Readonly<Record<string, unknown>>)[spec.key] === parsed) {
        continue;
      }
      patch[spec.key] = parsed;
    }
    setValidation(null);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    save.mutate(patch as DecisionGateChatPatch);
  };

  return (
    <form
      id={formId}
      noValidate
      className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset disabled={save.isPending} className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        {global.isPending ? (
          <p className={css({ margin: '0', color: 'text-muted' })}>{t('common.loading')}</p>
        ) : global.isError || globalValues === undefined || current === null ? (
          <p role="alert" className={css({ margin: '0', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('pages.chats.decisionGateInheritedUnavailable')}: {errorMessage(global.error)}
          </p>
        ) : (
          <>
            <OverrideRow
              label={t('decisionGate.enabled')}
              overridden={current.overridden.enabled === true}
              onOverrideChange={(checked) => toggle('enabled', checked)}
            >
              {({ id, ariaLabel }) => (
                <Switch
                  id={id}
                  aria-label={ariaLabel}
                  checked={shown('enabled') === true}
                  disabled={current.overridden.enabled !== true}
                  onCheckedChange={(checked) => setValue('enabled', checked)}
                />
              )}
            </OverrideRow>
            <OverrideRow
              label={t('decisionGate.mode')}
              overridden={current.overridden.mode === true}
              onOverrideChange={(checked) => toggle('mode', checked)}
            >
              {({ id, ariaLabel }) => (
                <Select
                  id={id}
                  aria-label={ariaLabel}
                  value={String(shown('mode') ?? 'shadow')}
                  disabled={current.overridden.mode !== true}
                  onChange={(event) => setValue('mode', event.target.value)}
                >
                  <option value="shadow">{t('decisionGate.modeShadow')}</option>
                  <option value="enforce">{t('decisionGate.modeEnforce')}</option>
                </Select>
              )}
            </OverrideRow>
            {(['threshold', 'history_messages', 'pending_messages'] as const).map((key) => {
              const spec = fieldSpec(key);
              const label =
                key === 'threshold'
                  ? t('decisionGate.threshold')
                  : key === 'history_messages'
                    ? t('decisionGate.historyMessages')
                    : t('decisionGate.pendingMessages');
              return (
                <OverrideRow
                  key={key}
                  label={label}
                  overridden={current.overridden[key] === true}
                  onOverrideChange={(checked) => toggle(key, checked)}
                >
                  {({ id, ariaLabel }) => (
                    <Input
                      id={id}
                      aria-label={ariaLabel}
                      type="number"
                      inputMode={spec.kind === 'number' ? 'decimal' : 'numeric'}
                      min={spec.min}
                      max={spec.max}
                      step={spec.kind === 'number' ? '0.01' : 1}
                      value={String(shown(key))}
                      disabled={current.overridden[key] !== true}
                      onChange={(event) => setValue(key, event.target.value)}
                      dir="ltr"
                    />
                  )}
                </OverrideRow>
              );
            })}
            <OverrideRow
              label={t('decisionGate.instructions')}
              overridden={current.overridden.instructions === true}
              onOverrideChange={(checked) => toggle('instructions', checked)}
            >
              {({ id, ariaLabel }) => (
                <Textarea
                  id={id}
                  aria-label={ariaLabel}
                  rows={4}
                  value={String(shown('instructions'))}
                  disabled={current.overridden.instructions !== true}
                  onChange={(event) => setValue('instructions', event.target.value)}
                  dir="auto"
                />
              )}
            </OverrideRow>
          </>
        )}
      </fieldset>
      {validation !== null ? (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text' })}>
          {validation}
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
          {errorMessage(save.error)}
        </p>
      ) : null}
    </form>
  );
}

/**
 * One field plus its inherit/override choice. The control is disabled while the
 * field inherits, so the global value stays visible instead of disappearing.
 */
function OverrideRow({
  label,
  overridden,
  onOverrideChange,
  children,
}: {
  readonly label: string;
  readonly overridden: boolean;
  readonly onOverrideChange: (checked: boolean) => void;
  /** The control, wired to the label id and named by the field label. */
  readonly children: (props: { readonly id: string; readonly ariaLabel: string }) => ReactElement;
}): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
        <span className={css({ textStyle: 'label', color: 'text' })}>{label}</span>
        <Checkbox
          label={t('pages.chats.decisionGateOverrideField', { field: label })}
          checked={overridden}
          onCheckedChange={onOverrideChange}
        />
      </div>
      {children({ id, ariaLabel: label })}
    </div>
  );
}
