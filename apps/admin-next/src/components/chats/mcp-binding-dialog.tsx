import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Card } from '@tuuject/koi-react/card';
import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Dialog } from '@tuuject/koi-react/dialog';
import { RadioGroup } from '@tuuject/koi-react/radio-group';
import { Switch } from '@tuuject/koi-react/switch';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatEntry, ChatWriteResponse, ChatsView } from '@/lib/api/chats.ts';
import { updateMcpChatBinding, type McpServerView } from '@/lib/api/mcp-servers.ts';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { mcpServersQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';
import {
  type BindingDraft,
  type BindingMode,
  bindingChoices,
  bindingDraftsOf,
  bindingWriteBody,
  reconcileBindingDrafts,
} from './mcp-binding-draft.ts';

export interface McpBindingDialogProps {
  /** `open` stays apart from the chat so the title doesn't blank out while the exit fade plays. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly view: ChatsView;
  readonly chat: ChatEntry | null;
  /** Remounts the form for every open: saving never starts from the previous draft. */
  readonly formKey: number;
}

/**
 * One Chat's MCP bindings: inherit every configured server, turn MCP off, or
 * pick servers and narrow their tools. Tool choices come from the server's own
 * configured list, or from what it advertised when it allows all tools — and a
 * saved narrowed selection stays visible even before discovery has anything to
 * offer. Saving keeps each binding's policy overrides untouched.
 */
export function McpBindingDialog({ open, onOpenChange, view, chat, formKey }: McpBindingDialogProps): ReactElement {
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
      title={t('pages.chats.mcpTitle')}
      size="lg"
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
        <McpBindingForm
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

function McpBindingForm({
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
  const servers = useQuery(mcpServersQuery);
  if (servers.isPending) {
    return <p className={css({ margin: '0', color: 'text-muted' })}>{t('common.loading')}</p>;
  }
  if (servers.isError) {
    return <p className={css({ margin: '0', color: 'error-text' })}>{errorMessage(servers.error)}</p>;
  }
  return (
    <BindingEditor
      formId={formId}
      view={view}
      chat={chat}
      servers={servers.data}
      onClose={onClose}
      onPendingChange={onPendingChange}
    />
  );
}

/**
 * The editable form. It mounts only once the servers view has arrived, so the
 * binding drafts initialize from real data; the servers list keeps flowing in
 * with every poll, and the drafts reconcile onto it without losing edits.
 */
function BindingEditor({
  formId,
  view,
  chat,
  servers,
  onClose,
  onPendingChange,
}: {
  readonly formId: string;
  readonly view: ChatsView;
  readonly chat: ChatEntry;
  readonly servers: { readonly servers: readonly McpServerView[] };
  readonly onClose: () => void;
  readonly onPendingChange: (pending: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const queryClient = useQueryClient();
  const savedBindings = chat.saved?.mcp ?? null;
  const [mode, setMode] = useState<BindingMode>(
    savedBindings === null ? 'inherit' : savedBindings.length === 0 ? 'none' : 'explicit',
  );
  const [drafts, setDrafts] = useState<ReadonlyMap<string, BindingDraft>>(() => bindingDraftsOf(servers, chat));
  const [validation, setValidation] = useState<string | null>(null);
  // The polled list keeps flowing; the drafts ride along, a server another
  // writer added becomes bindable, and a removed alias drops out of the save.
  const effective = reconcileBindingDrafts(drafts, servers.servers);
  const save = useMutation({
    mutationFn: (): Promise<ChatWriteResponse> =>
      updateMcpChatBinding(chat.id, bindingWriteBody(mode, effective), view.revision),
    onMutate: () => onPendingChange(true),
    onSuccess: (result) => {
      write.succeeded(result.apply);
      void queryClient.invalidateQueries({ queryKey: mcpServersQuery.queryKey });
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
  const setDraft = (server: string, patch: (draft: BindingDraft) => BindingDraft): void => {
    setDrafts((current) => {
      const base = reconcileBindingDrafts(current, servers.servers);
      const next = new Map(base);
      const existing = base.get(server);
      if (existing !== undefined) {
        next.set(server, patch(existing));
      }
      return next;
    });
  };
  const submit = (): void => {
    if (mode === 'explicit') {
      if (servers.servers.length === 0) {
        setValidation(t('pages.chats.mcpNoServers'));
        return;
      }
      if (![...effective.values()].some((draft) => draft.bound)) {
        setValidation(t('pages.chats.mcpNeedsBinding'));
        return;
      }
      if ([...effective.values()].some((draft) => draft.bound && !draft.allTools && draft.tools.size === 0)) {
        setValidation(t('pages.chats.mcpNeedsTools'));
        return;
      }
    }
    setValidation(null);
    save.mutate();
  };
  return (
    <form
      id={formId}
      noValidate
      className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset disabled={save.isPending} className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
        <RadioGroup
          label={t('pages.chats.colMcp')}
          value={mode}
          onChange={(value) => {
            if (value === 'inherit' || value === 'none' || value === 'explicit') {
              setMode(value);
            }
          }}
          options={[
            {
              value: 'inherit',
              label: t('pages.chats.mcpInherit'),
              description: t('pages.chats.mcpInheritHint'),
            },
            { value: 'none', label: t('pages.chats.mcpNone'), description: t('pages.chats.mcpNoneHint') },
            { value: 'explicit', label: t('pages.chats.mcpExplicit'), description: t('pages.chats.mcpExplicitHint') },
          ]}
        />
        {mode === 'explicit' ? (
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}>
            {servers.servers.map((server) => {
              const draft = effective.get(server.alias);
              if (draft === undefined) {
                return null;
              }
              const choices = bindingChoices(server, draft);
              const noDiscovery = server.tools === '*' && server.advertised_tools.length === 0;
              return (
                <Card key={server.alias} variant="filled" className={css({ gap: '3' })}>
                  <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                    <div className={css({ display: 'flex', alignItems: 'center', gap: '2', textStyle: 'label' })}>
                      <Switch
                        checked={draft.bound}
                        onCheckedChange={(next) => setDraft(server.alias, (current) => ({ ...current, bound: next }))}
                        aria-label={`${t('pages.chats.mcpBind')} ${server.alias}`}
                      />
                      <span className={css({ fontFamily: 'mono' })}>{server.alias}</span>
                    </div>
                    <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                      {server.tools === '*' ? t('mcp.toolsAll') : server.tools.join(', ')}
                    </span>
                  </div>
                  {draft.bound ? (
                    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
                      <RadioGroup
                        label={t('pages.chats.mcpToolsLabel')}
                        value={draft.allTools ? 'all' : 'selected'}
                        onChange={(value) => {
                          if (value === 'all' || value === 'selected') {
                            setDraft(server.alias, (current) => ({ ...current, allTools: value === 'all' }));
                          }
                        }}
                        options={[
                          { value: 'all', label: t('mcp.toolsAll') },
                          { value: 'selected', label: t('pages.chats.mcpSelectedTools') },
                        ]}
                      />
                      {noDiscovery && draft.tools.size > 0 ? (
                        <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
                          {t('pages.chats.mcpSavedToolsOnly')}
                        </p>
                      ) : null}
                      {!draft.allTools ? (
                        choices.length === 0 ? (
                          <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
                            {t('pages.chats.mcpAllToolsOnly')}
                          </p>
                        ) : (
                          <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
                            {choices.map((tool) => (
                              <Checkbox
                                key={tool}
                                label={tool}
                                checked={draft.tools.has(tool)}
                                disabled={save.isPending}
                                onCheckedChange={(checked) =>
                                  setDraft(server.alias, (current) => {
                                    const tools = new Set(current.tools);
                                    if (checked) {
                                      tools.add(tool);
                                    } else {
                                      tools.delete(tool);
                                    }
                                    return { ...current, tools };
                                  })
                                }
                              />
                            ))}
                          </div>
                        )
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        ) : null}
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
