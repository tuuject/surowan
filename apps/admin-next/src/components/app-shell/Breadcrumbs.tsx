import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { ChangeDetails } from '@tuuject/koi-react';
import { Breadcrumb, type BreadcrumbItem } from '@tuuject/koi-react/breadcrumb';
import { useTranslation } from 'react-i18next';
import type { layout as layoutEn } from '@/locales/en/layout.ts';
import { NAV_GROUPS } from '@/nav';

type NavKey = keyof typeof layoutEn.nav;

/**
 * First-level path segments share their label with the sidebar entry for the
 * same destination (one name per place, per language). Deeper segments are
 * entity IDs and fall back to slug title-casing.
 */
const SEGMENT_TO_NAV: Partial<Record<string, NavKey>> = Object.fromEntries(
  NAV_GROUPS.flatMap((group) =>
    group.items.flatMap((item) => (item.to === '/' ? [] : [[item.to.slice(1), item.titleKey]])),
  ),
) as Partial<Record<string, NavKey>>;

function useCrumbs(): Array<{ title: string; href?: string }> {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { t } = useTranslation();
  const segments = pathname.split('/').filter(Boolean);
  const home = { title: t('layout.nav.overview'), href: '/' };
  if (segments.length === 0) {
    return [home];
  }
  const crumbs = segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    const navKey = index === 0 ? SEGMENT_TO_NAV[segment] : undefined;
    const title =
      navKey === undefined
        ? segment.replace(/-/g, ' ').replace(/\b\w/g, (character: string) => character.toUpperCase())
        : t(`layout.nav.${navKey}`);
    return { title, href };
  });
  return [home, ...crumbs];
}

/** The trail from the router location, rendered by Koi's Breadcrumb; a modified click keeps native anchor behavior. */
export function Breadcrumbs() {
  const navigate = useNavigate();
  const crumbs = useCrumbs();
  const items: BreadcrumbItem<Event>[] = crumbs.map((crumb, index) => {
    const current = index === crumbs.length - 1;
    if (current) {
      return { label: crumb.title, current: true };
    }
    return {
      label: crumb.title,
      ...(crumb.href === undefined ? {} : { href: crumb.href }),
      onSelect: (details: ChangeDetails) => {
        const event = details.event as MouseEvent;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        if (crumb.href !== undefined) {
          void navigate({ to: crumb.href as never });
        }
      },
    };
  });
  return <Breadcrumb items={items} />;
}
