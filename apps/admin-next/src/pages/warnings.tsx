import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, ListFooter, ListPageHeader, SnapshotNotice, useSnapshotPages } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { WarningCard } from '@/components/warnings/warning-card';
import { useForegroundRefresh } from '@/hooks/use-foreground-refresh';
import type { EventWarning } from '@/lib/api/warnings.ts';
import { clearWarnings, markWarningRead } from '@/lib/api/warnings.ts';
import { errorMessage } from '@/lib/errors';
import { warningsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

export default function WarningsPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [clearOpen, setClearOpen] = useState(false);
  const { query, data, items, page, pageCount, total, newCount, onPageChange, renew } = useSnapshotPages(
    warningsQuery,
    'warnings',
  );
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
      // `count` must be numeric for i18next to pick a plural form; `{{count, number}}` keeps localized digits.
      toast.success(t('pages.warnings.cleared', { count: result.cleared }));
      void queryClient.invalidateQueries({ queryKey: ['warnings'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const standing = data?.standing ?? [];
  const unreadCount = data?.unread_count ?? 0;

  return (
    <div className={css({ '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader
        title={t('layout.nav.warnings')}
        description={t('pages.warnings.pageDescription')}
        actions={
          <Button
            variant="outline"
            color="error"
            disabled={items.length === 0 || clear.isPending}
            onClick={() => {
              clear.reset();
              setClearOpen(true);
            }}
          >
            {t('pages.warnings.clearHistory')}
          </Button>
        }
      />
      {/* A failed poll or page change keeps the loaded cards and reports above them. */}
      {query.isError && !query.isLoadingError ? (
        <Alert tone="error" title={t('pages.warnings.loadFailed')}>
          {errorMessage(query.error)}
        </Alert>
      ) : null}
      <Panel title={t('pages.warnings.standingTitle')}>
        {query.isPending ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
            <Skeleton className={css({ height: '64px', width: '100%' })} />
            <Skeleton className={css({ height: '64px', width: '100%' })} />
          </div>
        ) : query.isLoadingError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('pages.warnings.loadFailed')}：{errorMessage(query.error)}
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
        description={t('pages.warnings.unreadCount', { count: unreadCount })}
      >
        <SnapshotNotice count={newCount} onRenew={renew} className={css({ marginBlockEnd: '4' })} />
        {query.isPending ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
            <Skeleton className={css({ height: '64px', width: '100%' })} />
            <Skeleton className={css({ height: '64px', width: '100%' })} />
            <Skeleton className={css({ height: '64px', width: '100%' })} />
          </div>
        ) : query.isLoadingError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('pages.warnings.loadFailed')}：{errorMessage(query.error)}
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
            inset={false}
            count={total}
            page={page}
            pageCount={pageCount}
            busy={query.isPlaceholderData}
            onPageChange={onPageChange}
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
