import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { RadioGroup } from '@tuuject/koi-react/radio-group';
import { Switch } from '@tuuject/koi-react/switch';
import { Textarea } from '@tuuject/koi-react/textarea';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingRow } from '@/components/business';
import { HeaderFields } from '@/components/models/header-fields';
import { SkillsSwitch } from '@/components/mcp-servers/skills-switch.tsx';
import {
  createMcpServer,
  draftMcpServerDescription,
  type McpServerCreateInput,
  type McpServerInput,
  type McpServerView,
  type McpServersView,
  updateMcpServer,
} from '@/lib/api/mcp-servers.ts';
import type { SecretInput, SecretSource } from '@/lib/api/keychain.ts';
import { errorMessage } from '@/lib/errors';
import {
  headerPayload,
  headerRowsFromNames,
  headerValues,
  type HeaderRow,
  removedHeaderNames,
} from '@/lib/header-rows.ts';
import { isConfigConflict } from '@/lib/model-manager';
import { keychainQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';
import {
  connectionChanged,
  draftOf,
  presentationFields,
  type ServerDraft,
  type ServerDraftError,
  serverPayload,
} from './draft.ts';
import { ToolPolicyRows } from './tool-policy-rows.tsx';

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Mirrors `MCP_SERVER_DESCRIPTION_MAX_LENGTH` in the configuration schema. */
const DESCRIPTION_MAX_LENGTH = 1_000;

/** The dialog's target, captured when it opened so the exit transition keeps its title and fields. */
export interface ServerDialogTarget {
  /** The whole view at open time; background refetches cannot upgrade a stale form's revision. */
  readonly view: McpServersView;
  /** `null` adds a server; a view row edits it. */
  readonly server: McpServerView | null;
}

export interface ServerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly target: ServerDialogTarget | null;
  /** Remounts the form for every open: saving never starts from the previous draft. */
  readonly formKey: number;
  /** Refreshes the page's data after a write, applied or not. */
  readonly onWritten: () => void;
}

/**
 * The add/edit dialog. HTTP servers edit their URL and headers; stdio servers
 * show their connection read-only — the panel cannot own a host command or
 * environment. A wildcard server's per-tool overrides stay editable next to
 * its default policy, and saving a change warns that chats using the server
 * have their in-flight runs stopped and resumed.
 */
export function ServerDialog({ open, onOpenChange, target, formKey, onWritten }: ServerDialogProps): ReactElement {
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
      title={target?.server === null ? t('mcp.addTitle') : t('mcp.editTitle', { alias: target?.server?.alias ?? '' })}
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
      {target === null ? null : (
        <ServerForm
          key={formKey}
          formId={formId}
          view={target.view}
          server={target.server}
          onClose={() => onOpenChange(false)}
          onPendingChange={setPending}
          onWritten={onWritten}
        />
      )}
    </Dialog>
  );
}

function ServerForm({
  formId,
  view,
  server,
  onClose,
  onPendingChange,
  onWritten,
}: {
  readonly formId: string;
  readonly view: McpServersView;
  readonly server: McpServerView | null;
  readonly onClose: () => void;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onWritten: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const keychain = useQuery(keychainQuery);
  const entries = (keychain.data?.entries ?? []).map((entry) => entry.name);
  const [draft, setDraft] = useState<ServerDraft>(() => draftOf(server));
  const [rows, setRows] = useState<readonly HeaderRow[]>(() =>
    server !== null && server.connection.kind === 'streamable_http'
      ? headerRowsFromNames(
          server.connection.headers.map((header) => header.name),
          keySourcesOf(server),
        )
      : [],
  );
  const [alias, setAlias] = useState(server?.alias ?? '');
  const [validation, setValidation] = useState<string | null>(null);
  const isStdio = server !== null && server.transport === 'stdio';
  const keySources = server !== null && server.connection.kind === 'streamable_http' ? keySourcesOf(server) : {};
  const nameBase = `mcp-${server?.alias ?? 'server'}`;

  const save = useMutation({
    mutationFn: (input: { readonly create: McpServerCreateInput; readonly update: McpServerInput }) =>
      server === null
        ? createMcpServer(input.create, view.revision)
        : updateMcpServer(server.alias, input.update, view.revision),
    onMutate: () => onPendingChange(true),
    onSuccess: (result) => {
      onWritten();
      // The apply outcome is part of the answer: applied, or saved but waiting
      // for a restart, exactly like every other config write reports it.
      write.succeeded(result.apply);
      onClose();
    },
    onError: (error) => {
      onWritten();
      if (isConfigConflict(error)) {
        onClose();
        toast.error(t('mcp.conflictBody'));
      }
    },
    onSettled: () => onPendingChange(false),
  });

  // A billed tool-model call that only fills the field: the operator reads and
  // edits the text, and nothing reaches the model until the form is saved.
  const describe = useMutation({
    mutationFn: (alias: string) => draftMcpServerDescription(alias),
    // A paid call: offline it fails now instead of pausing and firing later,
    // after the operator may have closed the dialog.
    networkMode: 'always',
    onSuccess: (result) => setDraft((current) => ({ ...current, description: result.description })),
  });

  // The draft endpoint describes the saved, running server; while the form
  // holds other connection or tool settings it would describe the wrong one.
  const unsavedConnection = ((): boolean => {
    if (server === null) {
      return true;
    }
    const payload = serverPayload(draft);
    if (payload.body === null || connectionChanged(server, payload.body)) {
      return true;
    }
    if (isStdio) {
      return false;
    }
    const headers = headerPayload(rows, removedHeaderNames(headerNamesOf(server), rows), nameBase);
    return headers.error !== null || headers.headers !== undefined;
  })();

  const draftErrorText = (error: ServerDraftError): string => {
    switch (error.kind) {
      case 'toolNeedsName':
        return t('mcp.errors.toolNeedsName');
      case 'toolListedTwice':
        return t('mcp.errors.toolListedTwice', { name: error.name });
      case 'toolTimeout':
        return t('mcp.errors.toolTimeout', { name: error.name });
      case 'defaultTimeout':
        return t('mcp.errors.defaultTimeout');
      case 'payloadRange':
        return t('mcp.errors.payloadRange');
      case 'resultRange':
        return t('mcp.errors.resultRange');
    }
  };

  const submit = (): void => {
    if (server === null && !ALIAS_PATTERN.test(alias)) {
      setValidation(t('mcp.errors.alias'));
      return;
    }
    if (!isStdio && draft.url.trim().length === 0) {
      setValidation(t('mcp.errors.url'));
      return;
    }
    const payload = serverPayload(draft);
    if (payload.error !== null || payload.body === null) {
      setValidation(payload.error === null ? t('mcp.errors.invalid') : draftErrorText(payload.error));
      return;
    }
    let updateHeaders: Readonly<Record<string, SecretInput | null>> | undefined;
    let createHeaders: Readonly<Record<string, SecretInput>> | undefined;
    if (!isStdio) {
      if (server === null) {
        const result = headerValues(rows, nameBase);
        if (result.error !== null || (rows.length > 0 && result.values === undefined)) {
          setValidation(result.error ?? t('mcp.errors.headers'));
          return;
        }
        createHeaders = result.values;
      } else {
        const result = headerPayload(rows, removedHeaderNames(headerNamesOf(server), rows), nameBase);
        if (result.error !== null) {
          setValidation(result.error);
          return;
        }
        updateHeaders = result.headers;
      }
    }
    setValidation(null);
    // Only the presentation changed: send only it, so the server keeps every
    // connection field byte for byte and nothing reconnects.
    const presentationOnly = server !== null && updateHeaders === undefined && !connectionChanged(server, payload.body);
    save.mutate({
      create: {
        alias,
        url: draft.url.trim(),
        ...payload.body,
        ...(createHeaders === undefined ? {} : { headers: createHeaders }),
      },
      update: presentationOnly
        ? presentationFields(payload.body)
        : { ...payload.body, ...(updateHeaders === undefined ? {} : { headers: updateHeaders }) },
    });
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
        {server === null ? (
          <Field label={t('mcp.fieldAlias')} help={t('mcp.fieldAliasHint')}>
            <Input value={alias} onChange={(event) => setAlias(event.target.value)} dir="ltr" />
          </Field>
        ) : (
          <SettingRow
            label={t('mcp.fieldAlias')}
            description={server.transport === 'stdio' ? 'stdio' : 'streamable_http'}
          >
            {({ id }) => <Input id={id} value={server.alias} readOnly dir="ltr" />}
          </SettingRow>
        )}
        {isStdio && server !== null ? (
          <SettingRow
            label={t('mcp.stdioConnection')}
            description={t('mcp.stdioConnectionHint', {
              program: server.connection.kind === 'stdio' ? server.connection.program : '',
            })}
          >
            {({ id }) => (
              <ul id={id} className={css({ margin: '0', paddingInlineStart: '4', listStyleType: 'disc' })}>
                {server.connection.kind === 'stdio'
                  ? server.connection.env.map((env) => (
                      <li key={env.name}>
                        <span className={css({ fontFamily: 'mono' })}>{env.name}</span>
                        {env.source?.kind === 'env'
                          ? ` — ${t('common.secret.providedByEnv', { env: env.source.env })}`
                          : env.source?.kind === 'command'
                            ? ` — ${t('common.secret.providedByCommand')}`
                            : null}
                      </li>
                    ))
                  : null}
              </ul>
            )}
          </SettingRow>
        ) : (
          <>
            <Field label={t('mcp.fieldUrl')} help={t('mcp.fieldUrlHint')}>
              <Input
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                placeholder="https://mcp.example.com/mcp"
                dir="ltr"
              />
            </Field>
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
              <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('mcp.fieldHeaders')}</h3>
              <HeaderFields
                rows={rows}
                onChange={setRows}
                valuesRequired={false}
                nameBase={nameBase}
                keychainEntries={entries}
                keySources={keySources}
              />
            </div>
          </>
        )}
        <RadioGroup
          label={t('mcp.fieldTools')}
          value={draft.toolsMode}
          onChange={(value) => {
            if (value === 'all' || value === 'selected') {
              setDraft({ ...draft, toolsMode: value });
            }
          }}
          options={[
            { value: 'all', label: t('mcp.toolsAll'), description: t('mcp.toolsAllHint') },
            { value: 'selected', label: t('mcp.toolsSelected'), description: t('mcp.toolsSelectedHint') },
          ]}
        />
        {draft.toolsMode === 'all' ? (
          <>
            <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '3', alignItems: 'flex-end' })}>
              <SettingRow label={t('mcp.policyReadOnly')} description={t('mcp.policyReadOnlyHint')}>
                {({ id, describedBy }) => (
                  <Switch
                    id={id}
                    aria-describedby={describedBy}
                    checked={draft.defaultReadOnly}
                    onCheckedChange={(next) => setDraft({ ...draft, defaultReadOnly: next })}
                  />
                )}
              </SettingRow>
              <Field label={t('mcp.policyTimeout')}>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.defaultTimeout}
                  onChange={(event) => setDraft({ ...draft, defaultTimeout: event.target.value })}
                  className={css({ width: '120px' })}
                  dir="ltr"
                />
              </Field>
            </div>
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
              <h3 className={css({ margin: '0', textStyle: 'label' })}>{t('mcp.overridesTitle')}</h3>
              <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>{t('mcp.overridesHint')}</p>
              <ToolPolicyRows
                rows={draft.tools}
                disabled={save.isPending}
                onChange={(tools) => setDraft({ ...draft, tools })}
              />
            </div>
          </>
        ) : (
          <>
            <ToolPolicyRows
              rows={draft.tools}
              disabled={save.isPending}
              onChange={(tools) => setDraft({ ...draft, tools })}
            />
            {draft.tools.length === 0 ? (
              <p className={css({ margin: '0', textStyle: 'small', color: 'warning-text' })}>
                {t('mcp.toolsEmptyHint')}
              </p>
            ) : null}
          </>
        )}
        <RadioGroup
          label={t('mcp.fieldExposure')}
          value={draft.exposure}
          onChange={(value) => {
            if (value === 'direct' || value === 'progressive') {
              setDraft({ ...draft, exposure: value });
            }
          }}
          options={[
            { value: 'direct', label: t('mcp.exposureDirect'), description: t('mcp.exposureDirectHint') },
            {
              value: 'progressive',
              label: t('mcp.exposureProgressive'),
              description: t('mcp.exposureProgressiveHint'),
            },
          ]}
        />
        <SkillsSwitch checked={draft.skills} onChange={(skills) => setDraft({ ...draft, skills })} />
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
          <Field label={t('mcp.fieldDescription')} help={t('mcp.fieldDescriptionHint')}>
            <Textarea
              rows={4}
              value={draft.description}
              // The draft replaces the text when it arrives; typing meanwhile would be lost.
              disabled={describe.isPending}
              maxLength={DESCRIPTION_MAX_LENGTH}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              dir="auto"
            />
          </Field>
          <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
            <Button
              type="button"
              variant="outline"
              color="secondary"
              disabled={unsavedConnection || describe.isPending}
              onClick={() => {
                if (server !== null) {
                  describe.mutate(server.alias);
                }
              }}
            >
              {describe.isPending ? t('mcp.drafting') : t('mcp.draftDescription')}
            </Button>
            <p className={css({ margin: '0', flex: '1', minWidth: '0', textStyle: 'small', color: 'text-muted' })}>
              {server === null
                ? t('mcp.draftNeedsServer')
                : unsavedConnection
                  ? t('mcp.draftNeedsSave')
                  : t('mcp.draftHint')}
            </p>
          </div>
          {describe.isError ? <Alert tone="error">{errorMessage(describe.error)}</Alert> : null}
          {draft.exposure === 'progressive' && draft.description.trim().length === 0 ? (
            <p className={css({ margin: '0', textStyle: 'small', color: 'warning-text' })}>
              {t('mcp.descriptionMissingHint')}
            </p>
          ) : null}
        </div>
        <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '3' })}>
          <Field label={t('mcp.fieldPayload')} help={t('mcp.fieldPayloadHint')}>
            <Input
              type="number"
              min={1}
              step={1}
              value={draft.payloadMax}
              onChange={(event) => setDraft({ ...draft, payloadMax: event.target.value })}
              className={css({ width: '160px' })}
              dir="ltr"
            />
          </Field>
          <Field label={t('mcp.fieldResult')} help={t('mcp.fieldResultHint')}>
            <Input
              type="number"
              min={1}
              step={1}
              value={draft.resultMax}
              onChange={(event) => setDraft({ ...draft, resultMax: event.target.value })}
              className={css({ width: '160px' })}
              dir="ltr"
            />
          </Field>
        </div>
      </fieldset>
      {server !== null ? <Alert tone="warning">{t('mcp.cutoverWarning')}</Alert> : null}
      {validation !== null ? (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text' })}>
          {validation}
        </p>
      ) : null}
      {save.isError && !isConfigConflict(save.error) ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
    </form>
  );
}

function keySourcesOf(server: McpServerView): Readonly<Record<string, SecretSource>> {
  if (server.connection.kind !== 'streamable_http') {
    return {};
  }
  const sources: Record<string, SecretSource> = {};
  for (const header of server.connection.headers) {
    sources[header.name] = header.source ?? null;
  }
  return sources;
}

function headerNamesOf(server: McpServerView): readonly string[] {
  return server.connection.kind === 'streamable_http' ? server.connection.headers.map((header) => header.name) : [];
}
