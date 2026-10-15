import { useMutation } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { WeekWindowsChart } from '@/components/chats/week-windows-chart';
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
import {
  type ChatEntry,
  type ChatsView,
  type ParticipationWindow,
  type ParticipationView,
  updateChatParticipation,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { summarizeWindows } from '@/lib/participation';
import { useProviderWrite } from '@/lib/use-provider-write';
import { useTranslation } from 'react-i18next';

type ParticipationMode = 'unrestricted' | 'none' | 'custom';

interface WindowDraft {
  readonly key: number;
  start: string;
  end: string;
  endMidnight: boolean;
  readonly days: boolean[];
}

let draftKey = 0;

function draftsFromWindows(windows: readonly ParticipationWindow[]): WindowDraft[] {
  return windows.map((window) => ({
    key: draftKey++,
    start: window.start,
    end: window.end === '24:00' ? '' : window.end,
    endMidnight: window.end === '24:00',
    days: [1, 2, 3, 4, 5, 6, 7].map((day) => window.days === undefined || window.days.includes(day)),
  }));
}

function windowFromDraft(draft: WindowDraft): ParticipationWindow | undefined {
  const end = draft.endMidnight ? '24:00' : draft.end;
  if (draft.start === '' || end === '' || draft.start === end) {
    return undefined;
  }
  const days = draft.days.flatMap((on, index) => (on ? [index + 1] : []));
  return days.length === 7 ? { start: draft.start, end } : { start: draft.start, end, days };
}

function initialMode(participation: ParticipationView | null): ParticipationMode {
  const windows = participation?.active_windows;
  if (windows === undefined) {
    return 'unrestricted';
  }
  return windows.length === 0 ? 'none' : 'custom';
}

function ModeOption({
  value,
  title,
  hint,
}: {
  readonly value: ParticipationMode;
  readonly title: string;
  readonly hint: string;
}): React.ReactElement {
  return (
    <Label className="has-[[data-state=checked]]:border-primary hover:bg-accent/50 flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors">
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="space-y-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{hint}</span>
      </span>
    </Label>
  );
}

/** The dialog captures the view when opened: a background refetch cannot upgrade a stale form's revision. */
export function ParticipationDialog({
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
  const participation = saved?.participation ?? null;
  const timezone = saved?.timezone ?? view.timezone;
  const dayLabels = t('pages.chats.weekdaysShort').split(',');
  const dailyLabel = t('pages.chats.daily');
  const summarize = (windows: readonly ParticipationWindow[]): string =>
    summarizeWindows(windows, { dayLabels, dailyLabel });
  const globalWindows = view.global_participation?.active_windows ?? [];
  const [mode, setMode] = useState<ParticipationMode>(initialMode(participation));
  const [drafts, setDrafts] = useState<WindowDraft[]>(() =>
    draftsFromWindows(participation?.active_windows ?? view.global_participation?.active_windows ?? []),
  );
  const [validation, setValidation] = useState<string | null>(null);
  const setDraft = (key: number, patch: (draft: WindowDraft) => WindowDraft): void => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? patch(draft) : draft)));
  };
  const switchMode = (next: ParticipationMode): void => {
    setMode(next);
    // Choosing custom periods starts from the inherited global schedule so an
    // admin cannot silently drop it by saving an empty editor.
    if (next === 'custom' && drafts.length === 0 && globalWindows.length > 0) {
      setDrafts(draftsFromWindows(globalWindows));
    }
    setValidation(null);
  };
  const save = useMutation({
    mutationFn: () => {
      const activeWindows =
        mode === 'unrestricted' ? null : mode === 'none' ? [] : (drafts.map(windowFromDraft) as ParticipationWindow[]);
      return updateChatParticipation(chat.id, { active_windows: activeWindows }, view.revision);
    },
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
    if (mode === 'custom') {
      if (drafts.length === 0) {
        setValidation(t('pages.chats.windowsEmpty'));
        return;
      }
      if (drafts.some((draft) => windowFromDraft(draft) === undefined)) {
        setValidation(t('pages.chats.invalidWindow'));
        return;
      }
    }
    setValidation(null);
    save.mutate();
  };
  const keywords = participation?.trigger_keywords?.length ?? 0;
  const attention = participation?.attention_window_seconds;
  const previewWindows =
    mode === 'custom'
      ? (drafts.map(windowFromDraft).filter((window) => window !== undefined) as ParticipationWindow[])
      : [];
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('pages.chats.activeHoursTitle')}</DialogTitle>
          <DialogDescription>{t('pages.chats.activeHoursDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-5">
            <RadioGroup value={mode} onValueChange={switchMode} className="gap-2">
              <ModeOption
                value="unrestricted"
                title={t('pages.chats.modeUnrestricted')}
                hint={
                  globalWindows.length === 0
                    ? t('pages.chats.modeUnrestrictedHint')
                    : t('pages.chats.modeUnrestrictedHintGlobal', { windows: summarize(globalWindows) })
                }
              />
              <ModeOption value="none" title={t('pages.chats.modeNone')} hint={t('pages.chats.modeNoneHint')} />
              <ModeOption value="custom" title={t('pages.chats.modeCustom')} hint={t('pages.chats.modeCustomHint')} />
            </RadioGroup>
            {mode !== 'unrestricted' ? <WeekWindowsChart windows={previewWindows} timezone={timezone} /> : null}
            {mode === 'custom' ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>{t('pages.chats.windowsLabel')}</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDrafts((current) => [
                        ...current,
                        {
                          key: draftKey++,
                          start: '09:00',
                          end: '18:00',
                          endMidnight: false,
                          days: [true, true, true, true, true, true, true],
                        },
                      ])
                    }
                  >
                    <Plus />
                    {t('pages.chats.addWindow')}
                  </Button>
                </div>
                {drafts.length === 0 ? (
                  <p className="text-muted-foreground text-xs">{t('pages.chats.windowsEmpty')}</p>
                ) : null}
                {drafts.map((draft, index) => (
                  <div key={draft.key} className="space-y-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="time"
                        value={draft.start}
                        aria-label={`${t('pages.chats.startLabel')} ${index + 1}`}
                        onChange={(event) =>
                          setDraft(draft.key, (current) => ({ ...current, start: event.target.value }))
                        }
                        className="w-27"
                      />
                      <span className="text-muted-foreground" aria-hidden="true">
                        –
                      </span>
                      <Input
                        type="time"
                        value={draft.end}
                        disabled={draft.endMidnight}
                        aria-label={`${t('pages.chats.endLabel')} ${index + 1}`}
                        onChange={(event) =>
                          setDraft(draft.key, (current) => ({ ...current, end: event.target.value }))
                        }
                        className="w-27"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant={draft.endMidnight ? 'secondary' : 'outline'}
                        aria-pressed={draft.endMidnight}
                        title={t('pages.chats.endMidnight')}
                        onClick={() =>
                          setDraft(draft.key, (current) => ({ ...current, endMidnight: !current.endMidnight }))
                        }
                      >
                        24:00
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive ms-auto"
                        aria-label={t('pages.chats.removeWindow')}
                        onClick={() => setDrafts((current) => current.filter((item) => item.key !== draft.key))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {dayLabels.map((label, dayIndex) => {
                        const on = draft.days[dayIndex] ?? false;
                        return (
                          <button
                            key={label}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              setDraft(draft.key, (current) => ({
                                ...current,
                                days: current.days.map((value, position) => (position === dayIndex ? !value : value)),
                              }))
                            }
                            className={
                              on
                                ? 'border-primary bg-primary/10 text-primary rounded-full border px-2.5 py-0.5 text-xs transition-colors'
                                : 'text-muted-foreground hover:border-primary/50 rounded-full border px-2.5 py-0.5 text-xs transition-colors'
                            }
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {(keywords > 0 || attention !== undefined) && (
              <p className="text-muted-foreground text-xs">
                {keywords > 0 ? t('pages.chats.keywordsPreserved', { count: keywords }) : null}
                {keywords > 0 && attention !== undefined ? ' ' : null}
                {attention !== undefined ? t('pages.chats.attentionPreserved', { seconds: attention }) : null}
              </p>
            )}
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
