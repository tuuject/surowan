import { IconButton } from '@tuuject/koi-react/button';
import { CheckIcon } from '@tuuject/koi-react/icons';
import { Menu } from '@tuuject/koi-react/menu';
import { useTranslation } from 'react-i18next';
import { LanguageIcon } from '@/components/icons';
import { type AppLanguage, currentLanguage, LANGUAGE_LABELS, LANGUAGES, setLanguage } from '@/lib/i18n';

/**
 * Header language picker: Koi's Menu with every supported language in its own
 * name, the active one marked. The choice is stored under `admin-language` by
 * `setLanguage`, which also flips `lang`/`dir` on the document.
 */
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const current: AppLanguage = currentLanguage(i18n.language);

  return (
    <Menu
      placement="bottom-end"
      trigger={
        <IconButton
          size="sm"
          icon={<LanguageIcon size={16} />}
          label={t('layout.switchLanguage')}
          title={LANGUAGE_LABELS[current]}
        />
      }
      items={LANGUAGES.map((language) => ({
        value: language,
        label: LANGUAGE_LABELS[language],
        current: language === current,
        ...(language === current ? { endContent: <CheckIcon size={14} /> } : {}),
      }))}
      onSelect={(value) => {
        if (value !== current) {
          setLanguage(value as AppLanguage);
        }
      }}
    />
  );
}
