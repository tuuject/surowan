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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { useProviderWrite } from '@/lib/use-provider-write';
import { useTranslation } from 'react-i18next';
import { updateChatPausePolicy } from '@/lib/api/chats.ts';
import type { ChatEntry, ChatsView } from '@/lib/api/chats.ts';

/**
 * The dialog captures the view when opened: a background refetch cannot upgrade
 * a stale form's revision. The switch opens `/pause` to every member of this
 * Chat; `/resume` is never opened, so the warning stays part of the form.
 */
export function PausePolicyDialog({
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
  const saved = chat.saved ?? chat.active;
  const [everyone, setEveryone] = useState(saved?.pause_by_members === true);
  const save = useMutation({
    mutationFn: () => updateChatPausePolicy(chat.id, { pause_by_members: everyone }, view.revision),
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
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pages.chats.pausePolicyTitle')}</DialogTitle>
          <DialogDescription>{t('pages.chats.pausePolicyDescription')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-1">
                <Label htmlFor="pause-by-members">{t('pages.chats.pausePolicyEnable')}</Label>
                <p className="text-muted-foreground text-xs">{t('pages.chats.pausePolicyEnableHint')}</p>
              </div>
              <Switch id="pause-by-members" checked={everyone} onCheckedChange={setEveryone} />
            </div>
            <p className="text-muted-foreground text-xs">{t('pages.chats.pausePolicyResumeHint')}</p>
          </fieldset>
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
