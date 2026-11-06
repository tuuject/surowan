import { useNavigate } from '@tanstack/react-router';
import type { ChangeDetails } from '@tuuject/koi-react';
import type { NavItem, NavSection } from '@tuuject/koi-react/nav-menu';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NAV_GROUPS, type NavTo } from '@/nav';

const ROUTES = new Set<string>(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to)));

/**
 * `NAV_GROUPS` as NavMenu's sections: the group title is the section heading
 * and every row stays a leaf link, exactly the two-level hierarchy the panel
 * had before the Koi shell. Rebuilt per language so labels follow i18n.
 */
export function useNavMenu(onNavigate?: () => void) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const sections = useMemo<NavSection[]>(
    () =>
      NAV_GROUPS.map((group) => ({
        label: t(`layout.navGroups.${group.labelKey}`),
        items: group.items.map<NavItem>((item) => ({
          value: item.to,
          label: t(`layout.nav.${item.titleKey}`),
          href: item.to,
          icon: <item.icon size={sizes.icon} />,
        })),
      })),
    // react-i18next gives `t` a new identity on a language change.
    [t],
  );

  const onSelect = (_value: string, item: NavItem, details: ChangeDetails) => {
    const event = details.event as MouseEvent;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      // A new tab or a download is not a navigation in this app; keep the current row.
      details.cancel();
      return;
    }
    event.preventDefault();
    if (!ROUTES.has(item.value)) {
      return;
    }
    navigate({ to: item.value as NavTo });
    onNavigate?.();
  };

  return { sections, onSelect };
}
