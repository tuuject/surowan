import { Collapsible } from '@base-ui/react/collapsible';
import { IconButton } from '@tuuject/koi-react/button';
import { Card } from '@tuuject/koi-react/card';
import { ChevronDownIcon } from '@tuuject/koi-react/icons';
import { PageHeader } from '@tuuject/koi-react/page-header';
import { Pagination } from '@tuuject/koi-react/pagination';
import { css } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { focusRing } from '@/components/app-shell/shared';
import { RefreshIcon } from '@/components/icons';
import { useMediaQuery } from '@/hooks/use-media-query';

const toggleClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '2',
  width: '100%',
  paddingBlock: '4',
  paddingInline: '5',
  border: 'none',
  bg: 'transparent',
  color: 'text',
  textStyle: 'heading-3',
  textAlign: 'left',
  cursor: 'pointer',
  transitionProperty: 'background-color',
  transitionDuration: 'fast',
  _hover: { bg: 'surface-muted' },
  _focusVisible: { ...focusRing, outlineOffset: '-2px' },
});

const panelClass = css({
  overflow: 'hidden',
  height: 'var(--collapsible-panel-height)',
  transition: 'height token(durations.fast) token(easings.out)',
  // The panel clips while it animates and when it is closed. Once a height
  // transition settles, let the control's outward focus ring paint outside the
  // measured content box; keeping overflow hidden for the whole open state
  // flattens the ring on the grid's flush left/right/bottom edges.
  '&[data-open]:not([data-starting-style]):not([data-ending-style])': { overflow: 'visible' },
  '&[data-starting-style], &[data-ending-style]': { height: '0' },
});

export function ListPageHeader({
  title,
  description,
  actions,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}): React.ReactElement {
  return <PageHeader title={title} {...(description === undefined ? {} : { description })} actions={actions} />;
}

/** The only Card in authenticated page content: query and filter conditions. */
export function ListFilterCard({
  children,
  activeCount = 0,
}: {
  readonly children: ReactNode;
  readonly activeCount?: number;
}): React.ReactElement {
  const { t } = useTranslation();
  const desktop = useMediaQuery('(min-width: 768px)');
  const [mobileOpen, setMobileOpen] = useState(false);
  const expanded = desktop || mobileOpen;

  return (
    <Collapsible.Root
      open={expanded}
      onOpenChange={(next) => {
        if (!desktop) {
          setMobileOpen(next);
        }
      }}
    >
      <Card
        data-list-filter="true"
        padding="none"
        title={
          desktop ? (
            t('layout.business.filters')
          ) : (
            <Collapsible.Trigger className={toggleClass}>
              <span>{t('layout.business.filters')}</span>
              {activeCount > 0 ? (
                <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                  {t('layout.business.appliedFilters', { count: activeCount })}
                </span>
              ) : null}
              <ChevronDownIcon
                size={sizes['icon-sm']}
                className={css({
                  flexShrink: '0',
                  marginInlineStart: 'auto',
                  color: 'text-muted',
                  transition: 'transform token(durations.check) token(easings.spring)',
                  '[data-panel-open] > &': { transform: 'rotate(180deg)' },
                })}
              />
            </Collapsible.Trigger>
          )
        }
        className={css({ gap: { base: '0', md: '4' }, md: { padding: '5' } })}
      >
        <Collapsible.Panel className={panelClass}>{children}</Collapsible.Panel>
      </Card>
    </Collapsible.Root>
  );
}

/** Actions on the left, selection metadata and refresh on the right, as on Orders. */
export function ListToolbar({
  children,
  trailing,
  onRefresh,
  refreshing = false,
}: {
  readonly children?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className={css({
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '3',
      })}
    >
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>{children}</div>
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
        {trailing}
        {onRefresh === undefined ? null : (
          <IconButton
            label={t('layout.business.refreshList')}
            icon={<RefreshIcon />}
            disabled={refreshing}
            onClick={onRefresh}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A truthful count and Koi page navigation. Cursor lists pass their current
 * page size and a pageCount of known pages plus one possible next page; they
 * never invent a total. Offset and whole-array lists pass their real total.
 */
export function ListFooter({
  count,
  cursor = false,
  page = 1,
  pageCount,
  onPageChange,
  busy = false,
  inset = true,
  children,
}: {
  /** Under a table the 16px inset lines the count up with the cells; elsewhere it sits flush. */
  readonly inset?: boolean;
  readonly count: number;
  readonly cursor?: boolean;
  readonly page?: number;
  readonly pageCount?: number;
  readonly onPageChange?: (page: number) => void;
  readonly busy?: boolean;
  readonly children?: ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const paginated = pageCount !== undefined && onPageChange !== undefined;
  return (
    <div
      className={css(
        {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '3',
        },
        inset ? { padding: '4' } : { paddingBlockStart: '4' },
      )}
    >
      <span className={css({ textStyle: 'small', color: 'text-muted', fontVariantNumeric: 'tabular-nums' })}>
        {t(cursor ? 'layout.business.cursorPageCount' : 'layout.business.totalCount', { count, page })}
      </span>
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
        {children}
        {paginated ? (
          <Pagination
            variant="compact"
            page={page}
            pageCount={pageCount}
            siblings={1}
            aria-busy={busy || undefined}
            onChange={(next) => {
              if (!busy || next !== page + 1) {
                onPageChange(next);
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A table row's actions, per the Koi Table spec: no gap between the `sm ghost`
 * buttons (or `md` IconButtons in a `paddingBlock: 'none'` cell), end-aligned
 * and pulled 8px outward so the last label lines up with the header.
 */
export function RowActions({ children }: { readonly children: ReactNode }): React.ReactElement {
  return (
    <span className={css({ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginInlineEnd: '-2' })}>
      {children}
    </span>
  );
}
