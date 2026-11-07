import { Select } from '@tuuject/koi-react/select';
import { UploadIcon } from '@tuuject/koi-react/icons';
import { SendIcon } from '@/components/icons';
import type React from 'react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ListFooter } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { Divider } from '@tuuject/koi-react/divider';
import { Textarea } from '@tuuject/koi-react/textarea';
import type { PlaygroundParticipant, PlaygroundTimelineItem } from '@/lib/api/playground.ts';
import { toast } from '@/lib/toast.ts';
import { TimelineRow } from './rows.tsx';
import type { MessagePayload } from './shared.tsx';
import { css } from '@tuuject/koi-react/styled-system/css';

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
  const fileInput = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();
  return (
    <Panel title={t('playground.messages.heading')} className={css({ minWidth: '0' })}>
      <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        {items.length === 0 ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('playground.messages.empty')}</p>
        ) : (
          <ul className={css({ minWidth: '0' })}>
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
        <Divider />
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '2' })}>
            <Field label={t('playground.identities.select')}>
              <Select
                className={css({ minWidth: '192px' })}
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
            </Field>
            {shown.reply_to_seq === null ? null : (
              <div className={css({ display: 'flex', alignItems: 'center', gap: '2' })}>
                <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                  {t('playground.messages.replyTo', { seq: shown.reply_to_seq })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  color="secondary"
                  size="sm"
                  onClick={() => setReplySeq(null)}
                  disabled={composerLocked}
                >
                  {t('playground.messages.replyClear')}
                </Button>
              </div>
            )}
          </div>
          <Field label={t('playground.messages.composer')}>
            <Textarea
              value={shown.text}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('playground.messages.composerPlaceholder')}
              readOnly={composerLocked}
              rows={3}
            />
          </Field>
          {unresolved === null ? null : (
            <Alert
              tone="info"
              title={t('playground.messages.unresolved')}
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  color="secondary"
                  // While a replay is in flight its key must survive: if that
                  // response is lost too, the next send has to reuse it.
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
              }
            >
              {t('playground.messages.unresolvedHint')}
            </Alert>
          )}
          <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
            <Button
              type="button"
              variant="outline"
              color="secondary"
              iconStart={<UploadIcon />}
              loading={uploading}
              disabled={composerLocked}
              onClick={() => fileInput.current?.click()}
            >
              {t('playground.messages.attach')}
            </Button>
            <input
              ref={fileInput}
              id="playground-attachment"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
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
            {shown.asset_ids.length === 0 ? null : (
              <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t('playground.messages.attached', { count: shown.asset_ids.length })}
              </span>
            )}
            <Button
              type="button"
              className={css({ marginInlineStart: 'auto' })}
              onClick={() => submit.mutate(shown)}
              // An upload still in flight would land after the send cleared
              // the composer, so sending waits for it.
              disabled={submit.isPending || uploading || sendBlocked || shown.sender_id.length === 0}
              iconStart={<SendIcon />}
            >
              {submit.isPending ? t('playground.messages.sending') : t('playground.messages.send')}
            </Button>
          </div>
          {effectiveSender.length === 0 ? (
            <Alert tone="info" title={t('playground.errors.identityRequired')}>
              {t('playground.identities.addHint')}
            </Alert>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
