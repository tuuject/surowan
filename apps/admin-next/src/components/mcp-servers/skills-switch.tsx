import { Switch } from '@tuuject/koi-react/switch';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingRow } from '@/components/business';

/** Whether the model may read the skills a server publishes. */
export function SkillsSwitch({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <SettingRow label={t('mcp.fieldSkills')}>
      {({ id, describedBy }) => (
        <Switch id={id} aria-describedby={describedBy} checked={checked} onCheckedChange={onChange} />
      )}
    </SettingRow>
  );
}
