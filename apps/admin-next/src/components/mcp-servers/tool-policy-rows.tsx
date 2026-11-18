import { Button, IconButton } from '@tuuject/koi-react/button';
import { Input } from '@tuuject/koi-react/input';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { Switch } from '@tuuject/koi-react/switch';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { type ToolPolicyDraft, newToolRow } from './draft.ts';

/**
 * The per-tool policy rows the server editor uses in both modes: in "selected
 * tools" they are the explicit list with the policy each tool needs, in "all
 * tools" they are the wildcard server's per-tool overrides. One control, one
 * shape — the only difference is what the labels call them.
 */
export function ToolPolicyRows({
  rows,
  disabled,
  onChange,
}: {
  readonly rows: readonly ToolPolicyDraft[];
  readonly disabled: boolean;
  readonly onChange: (rows: readonly ToolPolicyDraft[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const setRow = (key: number, patch: (row: ToolPolicyDraft) => ToolPolicyDraft): void => {
    onChange(rows.map((row) => (row.key === key ? patch(row) : row)));
  };
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
      {rows.length === 0 ? (
        <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>{t('mcp.noPolicyRows')}</p>
      ) : null}
      {rows.map((row, index) => (
        <div key={row.key} className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
          <Input
            value={row.name}
            aria-label={`${t('mcp.toolName')} ${index + 1}`}
            placeholder="query"
            disabled={disabled}
            onChange={(event) => setRow(row.key, (current) => ({ ...current, name: event.target.value }))}
            dir="ltr"
          />
          <span className={css({ display: 'flex', alignItems: 'center', gap: '1', textStyle: 'small' })}>
            <Switch
              checked={row.readOnly}
              disabled={disabled}
              onCheckedChange={(next) => setRow(row.key, (current) => ({ ...current, readOnly: next }))}
              aria-label={`${t('mcp.policyReadOnly')} ${index + 1}`}
            />
            {t('mcp.policyReadOnly')}
          </span>
          <Input
            type="number"
            min={1}
            step={1}
            value={row.timeout}
            aria-label={`${t('mcp.policyTimeout')} ${index + 1}`}
            disabled={disabled}
            onChange={(event) => setRow(row.key, (current) => ({ ...current, timeout: event.target.value }))}
            className={css({ width: '120px' })}
            dir="ltr"
          />
          <IconButton
            variant="ghost"
            color="error"
            disabled={disabled}
            onClick={() => onChange(rows.filter((entry) => entry.key !== row.key))}
            label={t('mcp.removeTool')}
            icon={<TrashIcon />}
          />
        </div>
      ))}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          color="secondary"
          disabled={disabled}
          iconStart={<PlusIcon />}
          onClick={() => onChange([...rows, newToolRow()])}
        >
          {t('mcp.addTool')}
        </Button>
      </div>
    </div>
  );
}
