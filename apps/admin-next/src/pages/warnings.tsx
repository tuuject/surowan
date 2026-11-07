import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, ListFooter, useCursorPages } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Button } from '@tuuject/koi-react/button';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { WarningCard } from '@/components/warnings/warning-card';
import { useForegroundRefresh } from '@/hooks/use-foreground-refresh';
import type { EventWarning } from '@/lib/api/warnings.ts';
import { clearWarnings, markWarningRead } from '@/lib/api/warnings.ts';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { warningsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

export default function WarningsPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [clearOpen, setClearOpen] = useState(false);
  const { query, pages, items, page, pageCount, onPageChange } = useCursorPages(warningsQuery());
  useForegroundRefresh(() => {
    void query.refetch();
  });

  const markRead = useMutation({
    mutationFn: (warning: EventWarning) => markWarningRead(warning.id),
    onSuccess: () => {
      toast.success(t('pages.warnings.markedRead'));
      void queryClient.invalidateQueries({ queryKey: ['warnings'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const clear = useMutation({
    mutationFn: clearWarnings,
    onSuccess: (result) => {
      setClearOpen(false);
      toast.success(t('pages.warnings.cleared', { count: formatNumber(result.cleared) }));
      void queryClient.invalidateQueries({ queryKey: ['warnings'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const first = pages[0];
  const standing = first?.standing ?? [];
  const unreadCount = first?.unread_count ?? 0;

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '6' } })}>
      {/* A failed poll or next page keeps the loaded cards and reports above them. */}
      {query.isError && !query.isLoadingError ? (
        <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
          {t('pages.warnings.loadFailed')}: {errorMessage(query.error)}
        </p>
      ) : null}
      <Panel title={t('pages.warnings.standingTitle')}>
        {query.isPending ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
            <Skeleton className={css({ height: '64px', width: '100%' })} />
            <Skeleton className={css({ height: '64px', width: '100%' })} />
          </div>
        ) : query.isLoadingError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('pages.warnings.loadFailed')}: {errorMessage(query.error)}
          </p>
        ) : standing.length === 0 ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('pages.warnings.noStanding')}</p>
        ) : (
          <div className={css({ '& > :not(:last-child)': { borderBottomWidth: '1px', borderColor: 'divider' } })}>
            {standing.map((warning) => (
              <WarningCard key={warning.code} warning={warning} />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title={t('pages.warnings.eventsTitle')}
        action={
          <div className={css({ display: 'flex', alignItems: 'center', gap: '3' })}>
            <span className={css({ textStyle: 'body', color: 'text-muted' })}>
              {t('pages.warnings.unreadCount', { count: formatNumber(unreadCount) })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              color="secondary"
              disabled={items.length === 0 || clear.isPending}
              onClick={() => setClearOpen(true)}
            >
              {t('pages.warnings.clearHistory')}
            </Button>
          </div>
        }
      >
        {query.isPending ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
            <Skeleton className={css({ height: '64px', width: '100%' })} />
            <Skeleton className={css({ height: '64px', width: '100%' })} />
            <Skeleton className={css({ height: '64px', width: '100%' })} />
          </div>
        ) : query.isLoadingError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('pages.warnings.loadFailed')}: {errorMessage(query.error)}
          </p>
        ) : items.length === 0 ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('pages.warnings.noEvents')}</p>
        ) : (
          <div className={css({ '& > :not(:last-child)': { borderBottomWidth: '1px', borderColor: 'divider' } })}>
            {items.map((warning) => (
              <WarningCard
                key={warning.id}
                warning={warning}
                pending={markRead.isPending}
                onMarkRead={(item) => markRead.mutate(item)}
              />
            ))}
          </div>
        )}
        {!query.isPending && !query.isLoadingError ? (
          <ListFooter
            count={items.length}
            cursor
            page={page}
            pageCount={pageCount}
            busy={query.isFetchingNextPage}
            onPageChange={(next) => void onPageChange(next)}
          />
        ) : null}
      </Panel>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={(open) => {
          if (!open && !clear.isPending) {
            setClearOpen(false);
          }
        }}
        title={t('pages.warnings.clearTitle')}
        description={t('pages.warnings.clearDescription')}
        confirmText={t('pages.warnings.clearConfirm')}
        destructive
        pending={clear.isPending}
        error={clear.isError ? errorMessage(clear.error) : null}
        onConfirm={() => clear.mutate()}
      />
    </div>
  );
}
