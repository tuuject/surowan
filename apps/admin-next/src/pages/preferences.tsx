import { Field } from '@tuuject/koi-react/field';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ListPageHeader } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { type ThemeMode, useTheme } from '@/components/themes/theme-provider';
import { type AppLanguage, LANGUAGE_LABELS, LANGUAGES, setLanguage } from '@/lib/i18n';

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** Browser-local display preferences; theme and language are also on the header toggles. */
export default function PreferencesPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const { mode, setMode } = useTheme();
  const language: AppLanguage = i18n.language === 'zh-CN' ? 'zh-CN' : 'en';

  return (
    <div className={css({ maxWidth: '768px', marginInline: 'auto', '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader title={t('layout.nav.preferences')} />
      <Panel title={t('pages.preferences.displayTitle')} description={t('pages.preferences.displayDescription')}>
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '4', maxWidth: '480px' })}>
            <Field label={t('pages.preferences.themeLabel')}>
              <Select
                value={mode}
                onChange={(event) => setMode(event.target.value as ThemeMode)}
                options={THEME_MODES.map((item) => ({ value: item, label: t(`layout.theme.${item}`) }))}
              />
            </Field>
            <Field label={t('pages.preferences.languageLabel')}>
              <Select
                value={language}
                onChange={(event) => setLanguage(event.target.value as AppLanguage)}
                options={LANGUAGES.map((item) => ({ value: item, label: LANGUAGE_LABELS[item] }))}
              />
            </Field>
          </div>
        </div>
      </Panel>
    </div>
  );
}
