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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { errorMessage } from '@/lib/errors';
import { isConfigConflict, isThinkingLevel } from '@/lib/model-manager';
import { useProviderWrite } from '@/lib/use-provider-write';
import { useTranslation } from 'react-i18next';
import { createChat, updateChat } from '@/lib/api/chats.ts';
import type { ChatEntry, ChatSettings, ChatsView } from '@/lib/api/chats.ts';
import type { ThinkingLevel } from '@/lib/api/models.ts';

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

/** The whole view is captured when opened: background refetches cannot upgrade a stale form's revision. */
export function ChatDialog({
  view,
  chat,
  onClose,
}: {
  readonly view: ChatsView;
  readonly chat: ChatEntry | null;
  readonly onClose: () => void;
}): React.ReactElement {
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
  const save = useMutation({
    mutationFn: (settings: ChatSettings) =>
      chat === null
        ? createChat({ id: id.trim(), ...settings }, view.revision)
        : updateChat(chat.id, settings, view.revision),
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
      topic_ids: topicIds,
      provider: override?.provider ?? null,
      model: override?.model ?? null,
      thinking_level: thinking === 'inherit' ? null : thinking,
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{chat === null ? t('pages.chats.addChat') : t('pages.chats.editChat')}</DialogTitle>
          <DialogDescription>{t('pages.chats.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="chat-id">{t('pages.chats.chatIdLabel')}</Label>
              <Input
                id="chat-id"
                value={id}
                readOnly={chat !== null}
                placeholder={t('pages.chats.chatIdPlaceholder')}
                onChange={(event) => setId(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('pages.chats.chatIdHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-topics">{t('pages.chats.topicIdsLabel')}</Label>
              <Input
                id="chat-topics"
                value={topics}
                placeholder={t('pages.chats.allTopics')}
                onChange={(event) => setTopics(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t('pages.chats.topicIdsHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-model">{t('pages.chats.agentModelLabel')}</Label>
              <Select
                value={model}
                onValueChange={(value) => {
                  setModel(value);
                  const next = view.models.find((item) => modelKey(item.provider, item.model) === value);
                  setThinking(value === 'inherit' ? 'inherit' : (next?.thinking_levels[0] ?? 'off'));
                }}
              >
                <SelectTrigger id="chat-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    {t('pages.chats.globalDefaultModel', {
                      model: `${view.defaults.provider} / ${view.defaults.model}`,
                    })}
                  </SelectItem>
                  {view.models.map((item) => (
                    <SelectItem key={modelKey(item.provider, item.model)} value={modelKey(item.provider, item.model)}>
                      {item.provider} / {item.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">{t('pages.chats.modelHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-thinking">{t('pages.chats.thinkingLabel')}</Label>
              <Select
                value={thinking}
                onValueChange={(value) => {
                  if (value === 'inherit' || isThinkingLevel(value)) {
                    setThinking(value);
                  }
                }}
              >
                <SelectTrigger id="chat-thinking" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inheritAllowed ? (
                    <SelectItem value="inherit" disabled={!inheritSupported}>
                      {t('pages.chats.globalDefaultLevel', { level: view.defaults.thinking_level })}
                      {inheritSupported ? '' : t('pages.chats.unsupportedSuffix')}
                    </SelectItem>
                  ) : null}
                  {levels.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
              {save.isPending ? t('common.saving') : t('pages.chats.saveChat')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
