import { Switch } from '@tuuject/koi-react/switch';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '@/stores/ui';

/**
 * The one Auto refresh control both Invocation pages share. The preference is
 * remembered in the browser, so a reader who turns it off keeps it off.
 */
export function AutoRefreshSwitch(): ReactElement {
  const { t } = useTranslation();
  const autoRefresh = useUiStore((state) => state.invocationAutoRefresh);
  const setAutoRefresh = useUiStore((state) => state.setInvocationAutoRefresh);
  return <Switch label={t('layout.business.autoRefresh')} checked={autoRefresh} onCheckedChange={setAutoRefresh} />;
}
