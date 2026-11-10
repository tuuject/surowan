import { useMutation } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { RadioGroup } from '@tuuject/koi-react/radio-group';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatEntry, ChatsView, ProactiveReplyWrite } from '@/lib/api/chats.ts';
import { updateChatProactiveReply } from '@/lib/api/chats.ts';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';

type ProactiveMode = 'inherit' | 'off' | 'custom';

function initialMode(chat: ChatEntry): ProactiveMode {
  const override = chat.saved?.proactive_reply ?? null;
  if (override === null) {
    return 'inherit';
  }
  return override.enabled === false ? 'off' : 'custom';
}

export interface ProactiveReplyDialogProps {
  /** `open` stays apart from the chat so the title doesn't blank out while the exit fade plays. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly view: ChatsView;
  readonly chat: ChatEntry | null;
  /** Remounts the form for every open: saving never starts from the previous draft. */
  readonly formKey: number;
}

/**
 * Proactive reply settings for one Chat. The dialog root stays mounted for its
 * transitions; only the form inside remounts per open.
 */
export function ProactiveReplyDialog({
  open,
  onOpenChange,
  view,
  chat,
  formKey,
}: ProactiveReplyDialogProps): ReactElement {
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
      title={t('pages.chats.proactiveTitle')}
      description={t('pages.chats.proactiveDescription')}
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
        <ProactiveReplyForm
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

function ProactiveReplyForm({
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
  const saved = chat.saved ?? chat.active;
  // In inherit mode the effective settings are exactly the global ones.
  const effective = saved?.effective_proactive_reply ?? view.effective_global_proactive_reply;
  const [mode, setMode] = useState<ProactiveMode>(() => initialMode(chat));
  const [base, setBase] = useState(() => percent(effective.base_probability));
  const [increment, setIncrement] = useState(() => percent(effective.increment));
  const [pity, setPity] = useState(() => String(effective.hard_pity));
  const [validation, setValidation] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: ProactiveReplyWrite) => updateChatProactiveReply(chat.id, body, view.revision),
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
  const submit = (): void => {
    if (mode !== 'custom') {
      setValidation(null);
      save.mutate({ mode });
      return;
    }
    const baseProbability = probabilityOf(base, effective.base_probability);
    const step = probabilityOf(increment, effective.increment);
    const hardPity = Number(pity);
    if (
      // Number('') is 0, so a cleared field would otherwise save as zero.
      base.trim() === '' ||
      increment.trim() === '' ||
      pity.trim() === '' ||
      !Number.isFinite(baseProbability) ||
      !Number.isFinite(step) ||
      baseProbability < 0 ||
      baseProbability > 1 ||
      step < 0 ||
      step > 1 ||
      !Number.isInteger(hardPity) ||
      hardPity < 1 ||
      hardPity > 100
    ) {
      setValidation(t('pages.chats.proactiveInvalid'));
      return;
    }
    setValidation(null);
    save.mutate({ mode: 'custom', base_probability: baseProbability, increment: step, hard_pity: hardPity });
  };
  const globalSettings = view.effective_global_proactive_reply;
  const globalSummary = t('pages.chats.proactiveGlobalSummary', {
    base: percent(globalSettings.base_probability),
    increment: percent(globalSettings.increment),
    pity: globalSettings.hard_pity,
  });
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
      <fieldset disabled={save.isPending} className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
        <RadioGroup
          label={t('pages.chats.colProactive')}
          value={mode}
          onChange={(next) => {
            if (next === 'inherit' || next === 'off' || next === 'custom') {
              setMode(next);
              setValidation(null);
            }
          }}
          options={[
            {
              value: 'inherit',
              label: t('pages.chats.proactiveInherit'),
              description: globalSettings.enabled
                ? t('pages.chats.proactiveInheritHint', { summary: globalSummary })
                : t('pages.chats.proactiveInheritOffHint'),
            },
            { value: 'off', label: t('pages.chats.proactiveOff'), description: t('pages.chats.proactiveOffHint') },
            {
              value: 'custom',
              label: t('pages.chats.proactiveCustom'),
              description: t('pages.chats.proactiveCustomHint'),
            },
          ]}
        />
        {mode === 'custom' ? (
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
            <Field label={t('pages.chats.proactiveBase')}>
              <Input
                type="number"
                min={0}
                max={100}
                step={1}
                value={base}
                onChange={(event) => setBase(event.target.value)}
              />
            </Field>
            <Field label={t('pages.chats.proactiveIncrement')}>
              <Input
                type="number"
                min={0}
                max={100}
                step={1}
                value={increment}
                onChange={(event) => setIncrement(event.target.value)}
              />
            </Field>
            <Field label={t('pages.chats.proactivePity')}>
              <Input
                type="number"
                min={1}
                max={100}
                step={1}
                value={pity}
                onChange={(event) => setPity(event.target.value)}
              />
            </Field>
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.chats.proactiveMathHint')}</p>
          </div>
        ) : null}
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.chats.proactiveDirectHint')}</p>
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

/** A human-facing percentage without trailing zeroes or floating noise. */
function percent(value: number): string {
  return String(Number((value * 100).toFixed(2)));
}

/**
 * An untouched field keeps the stored probability exactly: `percent` rounds
 * for display, and saving the rounded value would change the sampling odds
 * and reset the pity counter.
 */
function probabilityOf(text: string, original: number): number {
  return text === percent(original) ? original : Number(text) / 100;
}
