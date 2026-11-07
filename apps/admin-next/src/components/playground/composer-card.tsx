import { Select } from '@tuuject/koi-react/select';
import { Send, Upload } from 'lucide-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { ListFooter } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import type { PlaygroundParticipant, PlaygroundTimelineItem } from '@/lib/api/playground.ts';
import { toast } from '@/lib/toast.ts';
import { TimelineRow } from './rows.tsx';
import type { MessagePayload } from './shared.tsx';

/** The server's room picture limit; a larger file is refused before it is read. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface ComposerCardProps {
  readonly roomId: string;
  readonly items: readonly PlaygroundTimelineItem[];
  readonly participants: readonly PlaygroundParticipant[];
  readonly shown: MessagePayload;
  readonly unresolved: MessagePayload | null;
  readonly composerLocked: boolean;
  readonly sendBlocked: boolean;
  readonly effectiveSender: string;
  readonly uploading: boolean;
  readonly attachments: readonly string[];
  readonly messages: {
    readonly page: number;
    readonly pageCount: number;
    readonly isFetchingNextPage: boolean;
    readonly onPageChange: (page: number) => Promise<void>;
  };
  readonly submit: {
    readonly isPending: boolean;
    readonly mutate: (payload: MessagePayload) => void;
  };
  readonly upload: {
    readonly mutate: (file: File, options: { readonly onSettled: () => void }) => void;
  };
  readonly messageKey: { readonly settle: () => void };
  readonly setUploading: (value: boolean) => void;
  readonly setDraft: (text: string) => void;
  readonly setSenderId: (id: string) => void;
  readonly setReplySeq: (seq: string | null) => void;
  readonly setUnresolved: (payload: MessagePayload | null) => void;
}

export function ComposerCard({
  roomId,
  items,
  participants,
  shown,
  unresolved,
  composerLocked,
  sendBlocked,
  effectiveSender,
  uploading,
  attachments,
  messages,
  submit,
  upload,
  messageKey,
  setUploading,
  setDraft,
  setSenderId,
  setReplySeq,
  setUnresolved,
}: ComposerCardProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Panel title={t('playground.messages.heading')} className="min-w-0">
      <div className="min-w-0 space-y-3">
        {items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('playground.messages.empty')}</p>
        ) : (
          <ul className="min-w-0">
            {items.map((item) => (
              <TimelineRow
                key={item.message_id}
                roomId={roomId}
                item={item}
                onReply={(seq) => {
                  if (!composerLocked) {
                    setReplySeq(seq);
                  }
                }}
              />
            ))}
          </ul>
        )}
        <ListFooter
          count={items.length}
          cursor
          page={messages.page}
          pageCount={messages.pageCount}
          busy={messages.isFetchingNextPage}
          onPageChange={(next) => void messages.onPageChange(next)}
        />
        <Separator />
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="playground-sender">{t('playground.identities.select')}</Label>
              <Select
                id="playground-sender"
                className="w-48"
                value={shown.sender_id}
                disabled={composerLocked}
                onChange={(event) => setSenderId(event.target.value)}
              >
                {participants.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </Select>
            </div>
            {shown.reply_to_seq === null ? null : (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  {t('playground.messages.replyTo', { seq: shown.reply_to_seq })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setReplySeq(null)}
                  disabled={composerLocked}
                >
                  {t('playground.messages.replyClear')}
                </Button>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="playground-text">{t('playground.messages.composer')}</Label>
            <Textarea
              id="playground-text"
              value={shown.text}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('playground.messages.composerPlaceholder')}
              readOnly={composerLocked}
              rows={3}
            />
          </div>
          {unresolved === null ? null : (
            <Alert>
              <AlertTitle>{t('playground.messages.unresolved')}</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {t('playground.messages.unresolvedHint')}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  // While a replay is in flight its key must survive: if that
                  // response is lost too, the next Send has to reuse it.
                  disabled={submit.isPending}
                  onClick={() => {
                    // The user takes the risk explicitly: the earlier send
                    // may be in the room, and the draft becomes a new message.
                    messageKey.settle();
                    setUnresolved(null);
                  }}
                >
                  {t('playground.messages.unresolvedEdit')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" asChild variant="outline" disabled={uploading || composerLocked}>
              <label htmlFor="playground-attachment" className="cursor-pointer">
                <Upload className="size-4" />
                {t('playground.messages.attach')}
                <input
                  id="playground-attachment"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  disabled={uploading || composerLocked}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file === undefined) {
                      return;
                    }
                    if (attachments.length >= 4) {
                      toast.error(t('playground.errors.uploadLimit'));
                      return;
                    }
                    if (file.size > MAX_UPLOAD_BYTES) {
                      toast.error(t('playground.errors.uploadTooLarge'));
                      return;
                    }
                    setUploading(true);
                    upload.mutate(file, { onSettled: () => setUploading(false) });
                  }}
                />
              </label>
            </Button>
            {shown.asset_ids.length === 0 ? null : (
              <span className="text-muted-foreground text-xs">
                {t('playground.messages.attached', { count: shown.asset_ids.length })}
              </span>
            )}
            <Button
              type="button"
              className="ml-auto"
              onClick={() => submit.mutate(shown)}
              // An upload still in flight would land after the send cleared
              // the composer, so sending waits for it.
              disabled={submit.isPending || uploading || sendBlocked || shown.sender_id.length === 0}
            >
              <Send className="size-4" />
              {submit.isPending ? t('playground.messages.sending') : t('playground.messages.send')}
            </Button>
          </div>
          {effectiveSender.length === 0 ? (
            <Alert>
              <AlertTitle>{t('playground.errors.identityRequired')}</AlertTitle>
              <AlertDescription>{t('playground.identities.addHint')}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
