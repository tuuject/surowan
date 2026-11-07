import { IconButton } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyIcon } from '@/components/icons';
import { toast } from '@/lib/toast.ts';
import { MonoValue } from './kv-list';

export function CopyableValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const [copying, setCopying] = useState(false);
  const action = t('common.copyValue', { label, value: value ?? '' });
  return (
    <span
      className={css({
        textStyle: 'small',
        color: 'text-muted',
        display: 'inline-flex',
        maxWidth: '100%',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '1',
      })}
    >
      <span>{label}:</span>
      <MonoValue value={value} />
      {value === null ? null : (
        <IconButton
          variant="ghost"
          color="secondary"
          label={action}
          title={action}
          icon={<CopyIcon />}
          disabled={copying}
          onClick={async () => {
            setCopying(true);
            try {
              await navigator.clipboard.writeText(value);
              toast.success(t('common.copied'));
            } catch {
              toast.error(t('common.copyFailed'));
            } finally {
              setCopying(false);
            }
          }}
        />
      )}
    </span>
  );
}
