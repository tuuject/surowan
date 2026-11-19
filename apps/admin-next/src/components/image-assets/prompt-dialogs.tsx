import { useMutation } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownInput } from '@/components/prompts/markdown-input';
import { createImagePrompt, updateImagePrompt } from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast.ts';

/**
 * The assets page's prompt-asset dialogs. Both stay mounted and are driven by
 * their open edge, so Base UI can play both transitions; the draft is replaced
 * on the open edge only, never on close: what was typed stays on screen
 * through the exit fade.
 */

export function PromptCreateDialog({ open, onDone }: { readonly open: boolean; readonly onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setName('');
      setBody('');
    }
  }
  const create = useMutation({
    mutationFn: () => createImagePrompt({ name, body }),
    onSuccess: () => {
      toast.success(t('image.assets.createdToast'));
      onDone();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !create.isPending && onDone()}
      title={t('image.assets.newAsset')}
      description={t('image.assets.bodyPlaceholder')}
      footer={
        <>
          <Button variant="ghost" color="secondary" onClick={onDone} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || name.trim() === '' || body.trim() === ''}
          >
            {create.isPending ? t('common.submitting') : t('common.create')}
          </Button>
        </>
      }
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('image.assets.namePlaceholder')}
          aria-label={t('image.assets.namePlaceholder')}
          dir="auto"
        />
        <MarkdownInput
          value={body}
          onChange={setBody}
          minHeight="112px"
          placeholder={t('image.assets.bodyPlaceholder')}
          aria-label={t('image.assets.bodyPlaceholder')}
        />
      </div>
    </Dialog>
  );
}

/** One prompt asset to rename; kept through the exit fade like the create dialog. */
export function PromptRenameDialog({
  target,
  onDone,
}: {
  readonly target: { readonly id: string; readonly name: string } | null;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [lastTarget, setLastTarget] = useState(target);
  if (target !== null && lastTarget !== target) {
    setLastTarget(target);
    setName(target.name);
  }
  const rename = useMutation({
    mutationFn: async (nextName: string) => {
      if (lastTarget === null) {
        return;
      }
      await updateImagePrompt(lastTarget.id, { name: nextName });
    },
    onSuccess: () => {
      toast.success(t('image.assets.renamedToast'));
      onDone();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => !next && !rename.isPending && onDone()}
      title={lastTarget === null ? '' : t('image.assets.renameTitle', { name: lastTarget.name })}
      footer={
        <>
          <Button variant="ghost" color="secondary" onClick={onDone} disabled={rename.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => rename.mutate(name)} disabled={rename.isPending || name.trim() === ''}>
            {rename.isPending ? t('common.submitting') : t('image.assets.rename')}
          </Button>
        </>
      }
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('image.assets.namePlaceholder')}
        aria-label={t('image.assets.namePlaceholder')}
        dir="auto"
      />
    </Dialog>
  );
}
