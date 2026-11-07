import { useNavigate } from '@tanstack/react-router';
import type { ChangeDetails } from '@tuuject/koi-react';
import type { NavItem, NavSection } from '@tuuject/koi-react/nav-menu';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NAV_GROUPS, type NavTo } from '@/nav';

const ROUTES = new Set<string>(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to)));

/**
 * Koi's parent/children tree: each former section heading is now a real
 * top-level parent with an icon and expandable pages. Values are stable across
 * languages, while labels rebuild with i18n. NavMenu automatically expands the
 * active page's ancestors and marks that parent as being on the current path.
 */
export function useNavMenu(onNavigate?: () => void) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const sections = useMemo<NavSection[]>(
    () => [
      {
        items: NAV_GROUPS.map<NavItem>((group) => ({
          value: `group:${group.labelKey}`,
          label: t(`layout.navGroups.${group.labelKey}`),
          icon: <group.icon size={sizes.icon} />,
          children: group.items.map((item) => ({
            value: item.to,
            label: t(`layout.nav.${item.titleKey}`),
            href: item.to,
          })),
        })),
      },
    ],
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
