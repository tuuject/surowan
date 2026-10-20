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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { type ChatEntry, type ChatsView, type ProactiveReplyWrite, updateChatProactiveReply } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { useProviderWrite } from '@/lib/use-provider-write';
import { useTranslation } from 'react-i18next';

type ProactiveMode = 'inherit' | 'off' | 'custom';

function initialMode(chat: ChatEntry): ProactiveMode {
  const override = chat.saved?.proactive_reply ?? null;
  if (override === null) {
    return 'inherit';
  }
  return override.enabled === false ? 'off' : 'custom';
}

function ModeOption({
  value,
  title,
  hint,
}: {
  readonly value: ProactiveMode;
  readonly title: string;
  readonly hint: string;
}): React.ReactElement {
  const id = `proactive-mode-${value}`;
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <RadioGroupItem value={value} id={id} className="mt-0.5" />
      <div className="space-y-1">
        <Label htmlFor={id}>{title}</Label>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
    </div>
  );
}

/** The dialog captures the view when opened: a background refetch cannot upgrade a stale form's revision. */
export function ProactiveReplyDialog({
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
  // In inherit mode the effective settings are exactly the global ones.
  const effective = saved?.effective_proactive_reply ?? view.effective_global_proactive_reply;
  const [mode, setMode] = useState<ProactiveMode>(() => initialMode(chat));
  const [base, setBase] = useState(() => percent(effective.base_probability));
  const [increment, setIncrement] = useState(() => percent(effective.increment));
  const [pity, setPity] = useState(() => String(effective.hard_pity));
  const [validation, setValidation] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: ProactiveReplyWrite) => updateChatProactiveReply(chat.id, body, view.revision),
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
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('pages.chats.proactiveTitle')}</DialogTitle>
          <DialogDescription>{t('pages.chats.proactiveDescription')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-5">
            <RadioGroup
              value={mode}
              onValueChange={(next) => {
                if (next === 'inherit' || next === 'off' || next === 'custom') {
                  setMode(next);
                  setValidation(null);
                }
              }}
              className="gap-2"
            >
              <ModeOption
                value="inherit"
                title={t('pages.chats.proactiveInherit')}
                hint={
                  globalSettings.enabled
                    ? t('pages.chats.proactiveInheritHint', { summary: globalSummary })
                    : t('pages.chats.proactiveInheritOffHint')
                }
              />
              <ModeOption value="off" title={t('pages.chats.proactiveOff')} hint={t('pages.chats.proactiveOffHint')} />
              <ModeOption
                value="custom"
                title={t('pages.chats.proactiveCustom')}
                hint={t('pages.chats.proactiveCustomHint')}
              />
            </RadioGroup>
            {mode === 'custom' ? (
              <div className="space-y-4 rounded-lg border p-3">
                <div className="space-y-2">
                  <Label htmlFor="proactive-base">{t('pages.chats.proactiveBase')}</Label>
                  <Input
                    id="proactive-base"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={base}
                    onChange={(event) => setBase(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="proactive-increment">{t('pages.chats.proactiveIncrement')}</Label>
                  <Input
                    id="proactive-increment"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={increment}
                    onChange={(event) => setIncrement(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="proactive-pity">{t('pages.chats.proactivePity')}</Label>
                  <Input
                    id="proactive-pity"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={pity}
                    onChange={(event) => setPity(event.target.value)}
                  />
                </div>
                <p className="text-muted-foreground text-xs">{t('pages.chats.proactiveMathHint')}</p>
              </div>
            ) : null}
            <p className="text-muted-foreground text-xs">{t('pages.chats.proactiveDirectHint')}</p>
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
