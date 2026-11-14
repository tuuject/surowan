import { useMutation } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { thinkingLevelLabel } from '@/lib/format';
import type { ChatEntry, ChatSettings, ChatsView } from '@/lib/api/chats.ts';
import { createChat, updateChat } from '@/lib/api/chats.ts';
import { ModelSwitchConfirmDialog } from '@/components/models/model-switch-confirm-dialog';
import type { ThinkingLevel } from '@/lib/api/models.ts';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict, isThinkingLevel, modelInUseCount } from '@/lib/model-manager';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';

function modelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function validId(value: string, positive = false): boolean {
  return (
    (positive ? /^[1-9][0-9]{0,15}$/ : /^-?[1-9][0-9]{0,15}$/).test(value) &&
    BigInt(value) <= 9007199254740991n &&
    BigInt(value) >= -9007199254740991n
  );
}

export interface ChatDialogProps {
  /** `open` stays apart from the chat so the title doesn't blank out while the exit fade plays. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly view: ChatsView;
  readonly chat: ChatEntry | null;
  /** Remounts the form for every open: saving never starts from the previous draft. */
  readonly formKey: number;
}

/**
 * Add or edit one Chat. The dialog root stays mounted for its transitions; only
 * the form inside remounts per open.
 */
export function ChatDialog({ open, onOpenChange, view, chat, formKey }: ChatDialogProps): ReactElement {
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
      title={chat === null ? t('pages.chats.addChat') : t('pages.chats.editChat')}
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
            {pending ? t('common.saving') : t('pages.chats.saveChat')}
          </Button>
        </>
      }
    >
      <ChatForm
        key={formKey}
        formId={formId}
        view={view}
        chat={chat}
        onClose={() => onOpenChange(false)}
        onPendingChange={setPending}
      />
    </Dialog>
  );
}

function ChatForm({
  formId,
  view,
  chat,
  onClose,
  onPendingChange,
}: {
  readonly formId: string;
  /** The whole view is captured when opened: background refetches cannot upgrade a stale form's revision. */
  readonly view: ChatsView;
  readonly chat: ChatEntry | null;
  readonly onClose: () => void;
  readonly onPendingChange: (pending: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const [id, setId] = useState(chat?.id ?? '');
  const [topics, setTopics] = useState(chat?.saved?.topic_ids?.join(', ') ?? '');
  const saved = chat?.saved ?? null;
  const inheritsModel = saved === null || saved.provider === null;
  const [model, setModel] = useState(inheritsModel ? 'inherit' : modelKey(saved.provider, saved.model ?? ''));
  // A model override always carries its own thinking; a hand-edited file that
  // inherits it starts from the effective level so saving pins it explicitly.
  const [thinking, setThinking] = useState<ThinkingLevel | 'inherit'>(
    saved?.thinking_level ?? (inheritsModel ? 'inherit' : (saved.effective.thinking_level ?? 'off')),
  );
  const [validation, setValidation] = useState<string | null>(null);
  const effectiveKey = model === 'inherit' ? modelKey(view.defaults.provider ?? '', view.defaults.model ?? '') : model;
  const selected = view.models.find((item) => modelKey(item.provider, item.model) === effectiveKey);
  const levels = selected?.thinking_levels ?? [];
  const inheritAllowed = model === 'inherit';
  const inheritSupported = view.defaults.thinking_level !== null && levels.includes(view.defaults.thinking_level);
  // An update that would leave Invocations on the Chat's old model is refused
  // until the admin agrees to stop them; the settings wait here to be sent again.
  const [inUse, setInUse] = useState<{ readonly count: number; readonly settings: ChatSettings } | null>(null);
  const [inUseOpen, setInUseOpen] = useState(false);
  const save = useMutation({
    mutationFn: ({ settings, abortRunning }: { settings: ChatSettings; abortRunning?: boolean }) =>
      chat === null
        ? createChat({ id: id.trim(), ...settings }, view.revision)
        : updateChat(chat.id, abortRunning === true ? { ...settings, abort_running: true } : settings, view.revision),
    onMutate: () => onPendingChange(true),
    onSuccess: (result) => {
      setInUseOpen(false);
      const aborted = result.aborted_invocations ?? 0;
      write.succeeded(
        result.apply,
        aborted > 0 ? t('models.models.switchConfirm.stopped', { count: aborted }) : undefined,
      );
      onClose();
    },
    onError: (error, { settings }) => {
      write.failed(error);
      const running = modelInUseCount(error);
      if (running !== null) {
        setInUse({ count: running, settings });
        setInUseOpen(true);
        return;
      }
      setInUseOpen(false);
      if (isConfigConflict(error)) {
        onClose();
        toast.error(t('pages.chats.configConflictEdit'));
      }
    },
    onSettled: () => onPendingChange(false),
  });
  const submit = (): void => {
    if (!validId(id.trim())) {
      setValidation(t('pages.chats.invalidChatId'));
      return;
    }
    const topicIds = topics.trim().length === 0 ? null : topics.trim().split(/[\s,]+/);
    if (
      topicIds !== null &&
      (topicIds.some((topic) => !validId(topic, true)) || new Set(topicIds).size !== topicIds.length)
    ) {
      setValidation(t('pages.chats.invalidTopicIds'));
      return;
    }
    if (thinking === 'inherit' && !inheritAllowed) {
      setValidation(t('pages.chats.thinkingRequired'));
      return;
    }
    // An inherited identity may be incomplete: that saves as a legal chat that
    // starts no invocation, so only an identity that names a level is checked.
    const effectiveLevel = thinking === 'inherit' ? view.defaults.thinking_level : thinking;
    const override = model === 'inherit' ? null : selected;
    if (
      override === undefined ||
      (selected !== undefined && effectiveLevel !== null && !levels.includes(effectiveLevel))
    ) {
      setValidation(t('pages.chats.thinkingUnsupported'));
      return;
    }
    setValidation(null);
    save.mutate({
      settings: {
        topic_ids: topicIds,
        provider: override?.provider ?? null,
        model: override?.model ?? null,
        thinking_level: thinking === 'inherit' ? null : thinking,
      },
    });
  };
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
        <Field label={t('pages.chats.chatIdLabel')} help={t('pages.chats.chatIdHint')}>
          <Input
            value={id}
            readOnly={chat !== null}
            placeholder={t('pages.chats.chatIdPlaceholder')}
            onChange={(event) => setId(event.target.value)}
            dir="ltr"
          />
        </Field>
        <Field label={t('pages.chats.topicIdsLabel')} help={t('pages.chats.topicIdsHint')}>
          <Input
            value={topics}
            placeholder={t('pages.chats.allTopics')}
            onChange={(event) => setTopics(event.target.value)}
            dir="ltr"
          />
        </Field>
        <Field label={t('pages.chats.agentModelLabel')} help={t('pages.chats.modelHint')}>
          <Select
            value={model}
            onChange={(event) => {
              const value = event.target.value;
              setModel(value);
              const next = view.models.find((item) => modelKey(item.provider, item.model) === value);
              setThinking(value === 'inherit' ? 'inherit' : (next?.thinking_levels[0] ?? 'off'));
            }}
          >
            <option value="inherit">
              {t('pages.chats.globalDefaultModel', {
                model: `${view.defaults.provider} / ${view.defaults.model}`,
              })}
            </option>
            {view.models.map((item) => (
              <option key={modelKey(item.provider, item.model)} value={modelKey(item.provider, item.model)}>
                {item.provider} / {item.model}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="chat-thinking" label={t('pages.chats.thinkingLabel')}>
          <Select
            value={thinking}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'inherit' || isThinkingLevel(value)) {
                setThinking(value);
              }
            }}
          >
            {inheritAllowed ? (
              <option value="inherit" disabled={!inheritSupported}>
                {t('pages.chats.globalDefaultLevel', { level: thinkingLevelLabel(view.defaults.thinking_level) })}
                {inheritSupported ? '' : t('pages.chats.unsupportedSuffix')}
              </option>
            ) : null}
            {levels.map((level) => (
              <option key={level} value={level}>
                {thinkingLevelLabel(level)}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>
      {validation !== null ? (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text' })}>
          {validation}
        </p>
      ) : null}
      {save.isError && modelInUseCount(save.error) === null ? (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
          {errorMessage(save.error)}
        </p>
      ) : null}
      <ModelSwitchConfirmDialog
        open={inUseOpen}
        count={inUse?.count ?? 0}
        pending={save.isPending}
        error={null}
        onConfirm={() => {
          if (inUse !== null) {
            save.mutate({ settings: inUse.settings, abortRunning: true });
          }
        }}
        onCancel={() => setInUseOpen(false)}
      />
    </form>
  );
}
