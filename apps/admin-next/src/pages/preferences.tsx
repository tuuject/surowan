import { Select } from '@tuuject/koi-react/select';
import { useTranslation } from 'react-i18next';
import { type ThemeMode, useTheme } from '@/components/themes/theme-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { type AppLanguage, LANGUAGE_LABELS, LANGUAGES, setLanguage } from '@/lib/i18n';
import { setShowConfigKeys, useShowConfigKeys } from '@/lib/panel-preferences';

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** Browser-local display preferences; theme and language are also on the header toggles. */
export default function PreferencesPage(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { mode, setMode } = useTheme();
  const showConfigKeys = useShowConfigKeys();
  const language: AppLanguage = i18n.language === 'zh-CN' ? 'zh-CN' : 'en';

  return (
    <div className="max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('pages.preferences.displayTitle')}</CardTitle>
          <CardDescription>{t('pages.preferences.displayDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="preference-theme">{t('pages.preferences.themeLabel')}</Label>
            <Select
              id="preference-theme"
              className="w-40"
              value={mode}
              onChange={(event) => setMode(event.target.value as ThemeMode)}
            >
              {THEME_MODES.map((item) => (
                <option key={item} value={item}>
                  {t(`layout.theme.${item}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="preference-language">{t('pages.preferences.languageLabel')}</Label>
            <Select
              id="preference-language"
              className="w-40"
              value={language}
              onChange={(event) => setLanguage(event.target.value as AppLanguage)}
            >
              {LANGUAGES.map((item) => (
                <option key={item} value={item}>
                  {LANGUAGE_LABELS[item]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Label htmlFor="show-config-keys">{t('pages.preferences.configKeysLabel')}</Label>
              <p id="show-config-keys-description" className="text-muted-foreground text-sm">
                {t('pages.preferences.configKeysDescription')}
              </p>
            </div>
            <Switch
              id="show-config-keys"
              aria-describedby="show-config-keys-description"
              checked={showConfigKeys}
              onCheckedChange={setShowConfigKeys}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
