import { useMutation } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingRow } from '@/components/business';
import type { ChatEntry, ChatsView } from '@/lib/api/chats.ts';
import { updateChatGroupMemory } from '@/lib/api/chats.ts';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';

export interface GroupMemoryDialogProps {
  /** `open` stays apart from the chat so the title doesn't blank out while the exit fade plays. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly view: ChatsView;
  readonly chat: ChatEntry | null;
  /** Remounts the form for every open: saving never starts from the previous draft. */
  readonly formKey: number;
}

/**
 * Group memory for one Chat. The dialog root stays mounted for its transitions;
 * only the form inside remounts per open. Switching the feature aborts the
 * Chat's running Invocations and rebuilds its Context, so the warning is part
 * of the form.
 */
export function GroupMemoryDialog({ open, onOpenChange, view, chat, formKey }: GroupMemoryDialogProps): ReactElement {
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
      title={t('pages.chats.groupMemoryTitle')}
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
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      {chat === null ? null : (
        <GroupMemoryForm
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

function GroupMemoryForm({
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
  const saved = chat.saved?.group_memory ?? null;
  const [enabled, setEnabled] = useState(saved?.enabled === true);
  const [idleMinutes, setIdleMinutes] = useState(String(saved?.idle_minutes ?? 30));
  const [validation, setValidation] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (idle: number) =>
      updateChatGroupMemory(
        chat.id,
        enabled ? { enabled: true, idle_minutes: idle } : { enabled: false },
        view.revision,
      ),
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
    if (!enabled) {
      setValidation(null);
      save.mutate(Number(idleMinutes));
      return;
    }
    const minutes = Number(idleMinutes);
    if (idleMinutes.trim() === '' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
      setValidation(t('pages.chats.groupMemoryInvalid'));
      return;
    }
    setValidation(null);
    save.mutate(minutes);
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
        <SettingRow label={t('pages.chats.groupMemoryEnable')} description={t('pages.chats.groupMemoryEnableHint')}>
          {({ id, describedBy }) => (
            <Switch id={id} aria-describedby={describedBy} checked={enabled} onCheckedChange={setEnabled} />
          )}
        </SettingRow>
        <Field
          label={t('pages.chats.groupMemoryIdle')}
          help={
            <>
              <span className={css({ display: 'block' })}>{t('pages.chats.groupMemoryIdleHint')}</span>
              <span className={css({ display: 'block' })}>{t('pages.chats.groupMemoryCutover')}</span>
            </>
          }
        >
          <Input
            type="number"
            min={1}
            max={1_440}
            step={1}
            disabled={!enabled}
            value={idleMinutes}
            onChange={(event) => setIdleMinutes(event.target.value)}
          />
        </Field>
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
