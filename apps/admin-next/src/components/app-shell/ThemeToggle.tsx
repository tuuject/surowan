import { IconButton } from '@tuuject/koi-react/button';
import { MonitorIcon, MoonIcon, SunIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { type ThemeMode, useTheme } from '@/components/themes/theme-provider';

const NEXT: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const ICON = { light: SunIcon, dark: MoonIcon, system: MonitorIcon } as const;

const LABEL = {
  light: 'layout.theme.light',
  dark: 'layout.theme.dark',
  system: 'layout.theme.system',
} as const;

/** Light → dark → system, persisted by the panel's ThemeProvider; Koi reads the resulting data-theme attribute. */
export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const { t } = useTranslation();
  const Icon = ICON[mode];
  const modeLabel = t(LABEL[mode]);

  return (
    <IconButton
      size="sm"
      icon={<Icon size={16} />}
      label={t('layout.theme.toggleTheme', { mode: modeLabel })}
      onClick={() => setMode(NEXT[mode])}
    />
  );
}
