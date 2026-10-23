import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/layout/panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

import { dictionaryErrorMessage } from '@/lib/dictionary.ts';
import type { DictionaryChatOption } from '@/lib/api/dictionary.ts';

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

  return (
    <Panel title={t('dictionary.scope.label')} className="self-start">
      <div className="space-y-3">
        <Select
          value={chatId ?? '__global__'}
          onValueChange={(value) => onSelect(value === '__global__' ? null : value)}
        >
          <SelectTrigger className="w-full" aria-label={t('dictionary.scope.label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__global__">{t('dictionary.scope.global')}</SelectItem>
            {chats.map((chat) => (
              <SelectItem key={chat.id} value={chat.id}>
                {t('dictionary.scope.groupPrefix')} · {chat.title ?? chat.id}
              </SelectItem>
            ))}
          </SelectContent>
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
