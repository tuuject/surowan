import { Select } from '@tuuject/koi-react/select';
import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/layout/panel';
import { type ThemeMode, useTheme } from '@/components/themes/theme-provider';
import { Label } from '@/components/ui/label';
import { Switch } from '@tuuject/koi-react/switch';
import { type AppLanguage, LANGUAGE_LABELS, LANGUAGES, setLanguage } from '@/lib/i18n';
import { setShowConfigKeys, useShowConfigKeys } from '@/lib/panel-preferences';
import { css } from '@tuuject/koi-react/styled-system/css';

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** Browser-local display preferences; theme and language are also on the header toggles. */
export default function PreferencesPage(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { mode, setMode } = useTheme();
  const showConfigKeys = useShowConfigKeys();
  const language: AppLanguage = i18n.language === 'zh-CN' ? 'zh-CN' : 'en';

  return (
    <div className={css({ maxWidth: '32rem', '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <Panel title={t('pages.preferences.displayTitle')} description={t('pages.preferences.displayDescription')}>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
          <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4' })}>
            <Label htmlFor="preference-theme">{t('pages.preferences.themeLabel')}</Label>
            <Select
              id="preference-theme"
              className={css({ width: '160px' })}
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
          <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4' })}>
            <Label htmlFor="preference-language">{t('pages.preferences.languageLabel')}</Label>
            <Select
              id="preference-language"
              className={css({ width: '160px' })}
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
          <div
            className={css({ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '4' })}
          >
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
              <Label htmlFor="show-config-keys">{t('pages.preferences.configKeysLabel')}</Label>
              <p id="show-config-keys-description" className={css({ textStyle: 'body', color: 'text-muted' })}>
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
        </div>
      </Panel>
    </div>
  );
}
