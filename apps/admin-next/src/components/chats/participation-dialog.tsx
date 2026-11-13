import { useMutation } from '@tanstack/react-query';
import { Button, IconButton } from '@tuuject/koi-react/button';
import { Card } from '@tuuject/koi-react/card';
import { Dialog } from '@tuuject/koi-react/dialog';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { RadioGroup } from '@tuuject/koi-react/radio-group';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WeekWindowsChart } from '@/components/chats/week-windows-chart';
import type { ChatEntry, ChatsView, ParticipationView, ParticipationWindow } from '@/lib/api/chats.ts';
import { updateChatParticipation } from '@/lib/api/chats.ts';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { summarizeWindows } from '@/lib/participation';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';

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

export interface ParticipationDialogProps {
  /** `open` stays apart from the chat so the title doesn't blank out while the exit fade plays. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly view: ChatsView;
  readonly chat: ChatEntry | null;
  /** Remounts the form for every open: saving never starts from the previous draft. */
  readonly formKey: number;
}

/**
 * Active hours for one Chat. The dialog root stays mounted for its transitions;
 * only the form inside remounts per open.
 */
export function ParticipationDialog({
  open,
  onOpenChange,
  view,
  chat,
  formKey,
}: ParticipationDialogProps): ReactElement {
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
      title={t('pages.chats.activeHoursTitle')}
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
        <ParticipationForm
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

function ParticipationForm({
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
  const participation = saved?.participation ?? null;
  const timezone = saved?.timezone ?? view.timezone;
  const dayLabels = t('pages.chats.weekdaysShort').split(',');
  const dailyLabel = t('pages.chats.daily');
  const summarize = (windows: readonly ParticipationWindow[]): string =>
    summarizeWindows(windows, { dayLabels, dailyLabel, separator: t('common.separator') });
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
    <form
      id={formId}
      className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset disabled={save.isPending} className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
        <RadioGroup
          label={t('pages.chats.colActiveHours')}
          value={mode}
          onChange={(value) => {
            if (value === 'unrestricted' || value === 'none' || value === 'custom') {
              switchMode(value);
            }
          }}
          options={[
            {
              value: 'unrestricted',
              label: t('pages.chats.modeUnrestricted'),
              description:
                globalWindows.length === 0
                  ? t('pages.chats.modeUnrestrictedHint')
                  : t('pages.chats.modeUnrestrictedHintGlobal', { windows: summarize(globalWindows) }),
            },
            { value: 'none', label: t('pages.chats.modeNone'), description: t('pages.chats.modeNoneHint') },
            { value: 'custom', label: t('pages.chats.modeCustom'), description: t('pages.chats.modeCustomHint') },
          ]}
        />
        {mode !== 'unrestricted' ? <WeekWindowsChart windows={previewWindows} timezone={timezone} /> : null}
        {mode === 'custom' ? (
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}>
            <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '3' })}>
              <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('pages.chats.windowsLabel')}</h3>
              <Button
                type="button"
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
                iconStart={<PlusIcon />}
              >
                {t('pages.chats.addWindow')}
              </Button>
            </div>
            {drafts.length === 0 ? (
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.chats.windowsEmpty')}</p>
            ) : null}
            {drafts.map((draft, index) => (
              <Card key={draft.key} variant="filled" className={css({ gap: '3' })}>
                <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                  <Input
                    type="time"
                    value={draft.start}
                    aria-label={`${t('pages.chats.startLabel')} ${index + 1}`}
                    onChange={(event) => setDraft(draft.key, (current) => ({ ...current, start: event.target.value }))}
                    className={css({ width: '108px' })}
                  />
                  <span className={css({ color: 'text-muted' })} aria-hidden="true">
                    –
                  </span>
                  <Input
                    type="time"
                    value={draft.end}
                    disabled={draft.endMidnight}
                    aria-label={`${t('pages.chats.endLabel')} ${index + 1}`}
                    onChange={(event) => setDraft(draft.key, (current) => ({ ...current, end: event.target.value }))}
                    className={css({ width: '108px' })}
                  />
                  <Button
                    type="button"
                    variant={draft.endMidnight ? 'soft' : 'outline'}
                    color="secondary"
                    aria-pressed={draft.endMidnight}
                    title={t('pages.chats.endMidnight')}
                    onClick={() =>
                      setDraft(draft.key, (current) => ({ ...current, endMidnight: !current.endMidnight }))
                    }
                  >
                    24:00
                  </Button>
                  <span className={css({ marginInlineStart: 'auto' })}>
                    <IconButton
                      variant="ghost"
                      color="error"
                      onClick={() => setDrafts((current) => current.filter((item) => item.key !== draft.key))}
                      label={t('pages.chats.removeWindow')}
                      icon={<TrashIcon />}
                    />
                  </span>
                </div>
                <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
                  {dayLabels.map((label, dayIndex) => {
                    const on = draft.days[dayIndex] ?? false;
                    return (
                      <Button
                        key={label}
                        type="button"
                        size="sm"
                        shape="pill"
                        variant={on ? 'soft' : 'outline'}
                        color={on ? 'primary' : 'secondary'}
                        aria-pressed={on}
                        onClick={() =>
                          setDraft(draft.key, (current) => ({
                            ...current,
                            days: current.days.map((value, position) => (position === dayIndex ? !value : value)),
                          }))
                        }
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>
              </Card>
            ))}
          </div>
        ) : null}
        {(keywords > 0 || attention !== undefined) && (
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>
            {keywords > 0 ? t('pages.chats.keywordsPreserved', { count: keywords }) : null}
            {keywords > 0 && attention !== undefined ? ' ' : null}
            {attention !== undefined ? t('pages.chats.attentionPreserved', { seconds: attention }) : null}
          </p>
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
