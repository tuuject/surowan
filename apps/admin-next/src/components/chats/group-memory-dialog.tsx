import { useMutation } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingRow } from '@/components/business';
import type { ChatEntry, ChatsView } from '@/lib/api/chats.ts';
import { updateChatGroupMemory } from '@/lib/api/chats.ts';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';

/**
 * The dialog captures the view when opened: a background refetch cannot upgrade
 * a stale form's revision. Switching the feature aborts the Chat's running
 * Invocations and rebuilds its Context, so the warning is part of the form.
 */
export function GroupMemoryDialog({
  view,
  chat,
  onClose,
}: {
  readonly view: ChatsView;
  readonly chat: ChatEntry;
  readonly onClose: () => void;
}): React.ReactElement {
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
    <Dialog
      open
      onOpenChange={(open) => !open && !save.isPending && onClose()}
      title={t('pages.chats.groupMemoryTitle')}
      description={t('pages.chats.groupMemoryDescription')}
      footer={
        <>
          <Button type="button" variant="outline" color="secondary" disabled={save.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="group-memory-dialog-form" disabled={save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="group-memory-dialog-form"
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
    </Dialog>
  );
}
