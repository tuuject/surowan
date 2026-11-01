import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { useProviderWrite } from '@/lib/use-provider-write';
import { useTranslation } from 'react-i18next';
import { updateChatGroupMemory } from '@/lib/api/chats.ts';
import type { ChatEntry, ChatsView } from '@/lib/api/chats.ts';

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
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('pages.chats.groupMemoryTitle')}</DialogTitle>
          <DialogDescription>{t('pages.chats.groupMemoryDescription')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-1">
                <Label htmlFor="group-memory-enabled">{t('pages.chats.groupMemoryEnable')}</Label>
                <p className="text-muted-foreground text-xs">{t('pages.chats.groupMemoryEnableHint')}</p>
              </div>
              <Switch id="group-memory-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-memory-idle">{t('pages.chats.groupMemoryIdle')}</Label>
              <Input
                id="group-memory-idle"
                type="number"
                min={1}
                max={1_440}
                step={1}
                disabled={!enabled}
                value={idleMinutes}
                onChange={(event) => setIdleMinutes(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('pages.chats.groupMemoryIdleHint')}</p>
            </div>
            <p className="text-muted-foreground text-xs">{t('pages.chats.groupMemoryCutover')}</p>
          </fieldset>
          {validation !== null ? (
            <p role="alert" className="text-destructive text-sm">
              {validation}
            </p>
          ) : null}
          {save.isError ? (
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(save.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
