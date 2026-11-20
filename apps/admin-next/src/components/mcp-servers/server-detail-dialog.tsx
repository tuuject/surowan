import { Dialog } from '@tuuject/koi-react/dialog';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, JsonViewer, KvList, MonoValue, TableShell, ToneBadge } from '@/components/business';
import { AppLink } from '@/components/router-links';
import type { McpAdvertisedToolView, McpServerView, McpSkillView } from '@/lib/api/mcp-servers.ts';
import type { SecretSource } from '@/lib/api/keychain.ts';

function secretRow(row: { readonly name: string; readonly source?: SecretSource }): string {
  if (row.source?.kind === 'entry') {
    return `${row.name} (${row.source.name})`;
  }
  if (row.source?.kind === 'env') {
    return `${row.name} (${row.source.env})`;
  }
  return row.name;
}

/**
 * Read-only detail for one server: what it connects through, the tools it
 * advertised (descriptions and input schemas are untrusted server data, shown
 * as plain text and preformatted JSON), and which Chats reach it.
 */
export function ServerDetailDialog({
  open,
  onOpenChange,
  server,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Kept after close so the exit transition keeps its content; `null` before the first open. */
  readonly server: McpServerView | null;
}): ReactElement {
  const { t } = useTranslation();
  if (server === null) {
    return (
      <Dialog open={false} onOpenChange={onOpenChange} title="">
        {null}
      </Dialog>
    );
  }
  const connection =
    server.connection.kind === 'stdio'
      ? [
          { label: t('mcp.colTransport'), value: 'stdio' },
          { label: t('mcp.colProgram'), value: <MonoValue value={server.connection.program} /> },
          { label: t('mcp.colArguments'), value: server.connection.argument_count },
          {
            label: t('mcp.colEnv'),
            value:
              server.connection.env.length === 0 ? t('mcp.noEnv') : server.connection.env.map(secretRow).join(', '),
          },
        ]
      : [
          { label: t('mcp.colTransport'), value: 'streamable_http' },
          { label: t('mcp.colUrl'), value: <MonoValue value={server.connection.url} /> },
          {
            label: t('mcp.colHeaders'),
            value:
              server.connection.headers.length === 0
                ? t('mcp.noHeaders')
                : server.connection.headers.map(secretRow).join(', '),
          },
        ];
  const columns: readonly ColumnSpec<McpAdvertisedToolView>[] = [
    {
      key: 'name',
      title: t('mcp.colTool'),
      width: 160,
      render: (tool) => <MonoValue value={tool.name} />,
    },
    {
      key: 'exposed',
      title: t('mcp.colExposed'),
      width: 120,
      render: (tool) =>
        tool.exposed ? (
          <ToneBadge tone="success">{t('mcp.exposedYes')}</ToneBadge>
        ) : (
          <ToneBadge tone="neutral">{t('mcp.exposedNo')}</ToneBadge>
        ),
    },
    {
      key: 'policy',
      title: t('mcp.colPolicy'),
      width: 140,
      render: (tool) =>
        tool.policy === null
          ? '—'
          : tool.policy.read_only
            ? t('mcp.policyReadOnlyShort')
            : t('mcp.policyWritableShort'),
    },
    {
      key: 'description',
      title: t('mcp.colDescription'),
      render: (tool) => (
        <div dir="auto" className={css({ minWidth: '0' })}>
          <p className={css({ margin: '0', whiteSpace: 'normal' })}>{tool.description ?? '—'}</p>
          <div className={css({ marginBlockStart: '2' })}>
            <JsonViewer value={tool.input_schema === null ? null : JSON.stringify(tool.input_schema)} />
          </div>
        </div>
      ),
    },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('mcp.detailTitle', { alias: server.alias })} size="lg">
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
        <KvList
          items={[
            ...connection,
            {
              label: t('mcp.fieldExposure'),
              value: server.exposure === 'progressive' ? t('mcp.exposureProgressive') : t('mcp.exposureDirect'),
            },
            {
              label: t('mcp.fieldSkills'),
              value: server.skills_enabled ? t('mcp.skillsExposed') : t('mcp.skillsHidden'),
            },
            {
              label: t('mcp.fieldDescription'),
              value: (
                <span dir="auto" className={css({ whiteSpace: 'pre-wrap' })}>
                  {server.description ?? t('mcp.noDescription')}
                </span>
              ),
            },
          ]}
        />
        <section>
          <h3 className={css({ margin: '0 0 2', textStyle: 'heading-3' })}>{t('mcp.advertisedTitle')}</h3>
          {server.advertised_tools.length === 0 ? (
            <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>{t('mcp.noAdvertised')}</p>
          ) : (
            <TableShell
              columns={columns}
              data={server.advertised_tools}
              rowKey={(tool) => tool.name}
              minWidth={720}
              emptyText={t('mcp.noAdvertised')}
            />
          )}
        </section>
        <section>
          <h3 className={css({ margin: '0 0 2', textStyle: 'heading-3' })}>{t('mcp.skillsTitle')}</h3>
          {server.skills_error === null ? null : (
            <p className={css({ margin: '0 0 2', textStyle: 'small', color: 'warning-text' })}>
              {t('mcp.skillsError')} <MonoValue value={server.skills_error} />
            </p>
          )}
          {server.skills.length === 0 ? (
            <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>{t('mcp.noSkills')}</p>
          ) : (
            <ul
              className={css({
                margin: '0',
                padding: '0',
                listStyle: 'none',
                '& > li + li': { marginBlockStart: '3' },
              })}
            >
              {server.skills.map((skill) => (
                <SkillItem key={skill.name} skill={skill} />
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className={css({ margin: '0 0 2', textStyle: 'heading-3' })}>{t('mcp.usageTitle')}</h3>
          {server.bound_chats.length === 0 ? (
            <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>{t('mcp.noBoundChats')}</p>
          ) : (
            <ul className={css({ margin: '0', paddingInlineStart: '4', listStyleType: 'disc' })}>
              {server.bound_chats.map((chat) => (
                <li key={chat.chat_id}>
                  <AppLink to="/chats" search={{ search: chat.chat_id }}>
                    {chat.chat_id}
                  </AppLink>
                  <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                    {' '}
                    — {chat.tools === '*' ? t('mcp.toolsAll') : chat.tools.join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}

/** One skill: untrusted server data, so its description is plain text. */
function SkillItem({ skill }: { readonly skill: McpSkillView }): ReactElement {
  const { t } = useTranslation();
  return (
    <li>
      <MonoValue value={skill.name} />
      <p dir="auto" className={css({ margin: '0', whiteSpace: 'pre-wrap' })}>
        {skill.description}
      </p>
      <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
        {t('mcp.skillsFiles', { files: skill.file_count, bytes: skill.total_bytes })}
      </p>
    </li>
  );
}
