import { Select } from '@tuuject/koi-react/select';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/layout/panel';
import { Skeleton } from '@/components/ui/skeleton';
import type { DictionaryChatOption } from '@/lib/api/dictionary.ts';
import { dictionaryErrorMessage } from '@/lib/dictionary.ts';

export interface DictionaryScopePanelProps {
  readonly chatId: string | null;
  readonly chats: readonly DictionaryChatOption[];
  readonly chatsPending: boolean;
  readonly chatsFailed: boolean;
  readonly chatsError: unknown;
  readonly onSelect: (chatId: string | null) => void;
}

/** Global / group scope selector; `null` means global. */
export function DictionaryScopePanel({
  chatId,
  chats,
  chatsPending,
  chatsFailed,
  chatsError,
  onSelect,
}: DictionaryScopePanelProps): React.ReactElement {
  const { t } = useTranslation();
  // A deep-linked chat can be absent while the chat list loads, after it fails,
  // or when the chat is no longer available. Keep it visible so the selector
  // never mislabels the active scope as the global dictionary.
  const missingScope = chatId !== null && !chats.some((chat) => chat.id === chatId);

  return (
    <Panel title={t('dictionary.scope.label')} className="self-start">
      <div className="space-y-3">
        <Select
          className="w-full"
          aria-label={t('dictionary.scope.label')}
          value={chatId ?? '__global__'}
          onChange={(event) => {
            const value = event.target.value;
            onSelect(value === '__global__' ? null : value);
          }}
        >
          <option value="__global__">{t('dictionary.scope.global')}</option>
          {missingScope ? (
            <option value={chatId}>
              {t('dictionary.scope.groupPrefix')} · {chatId}
            </option>
          ) : null}
          {chats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {t('dictionary.scope.groupPrefix')} · {chat.title ?? chat.id}
            </option>
          ))}
        </Select>
        <p className="text-muted-foreground text-xs">{t('dictionary.scope.groupHint')}</p>
        {chatsPending ? <Skeleton className="h-8 w-full" /> : null}
        {chatsFailed ? (
          <p className="text-destructive text-sm break-words">{dictionaryErrorMessage(chatsError)}</p>
        ) : null}
      </div>
    </Panel>
  );
}
