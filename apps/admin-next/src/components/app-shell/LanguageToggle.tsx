import { IconButton } from '@tuuject/koi-react/button';
import { Tooltip } from '@tuuject/koi-react/tooltip';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type AppLanguage, LANGUAGE_LABELS, setLanguage } from '@/lib/i18n';

const NEXT: Record<AppLanguage, AppLanguage> = {
  en: 'zh-CN',
  'zh-CN': 'en',
};

/** One button cycles the two supported languages; the choice is stored under `admin-language`. */
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const current: AppLanguage = i18n.language === 'zh-CN' ? 'zh-CN' : 'en';
  return (
    <Tooltip content={LANGUAGE_LABELS[current]}>
      <IconButton
        size="sm"
        icon={<Languages size={16} />}
        label={t('layout.switchLanguage')}
        onClick={() => setLanguage(NEXT[current])}
      />
    </Tooltip>
  );
}
