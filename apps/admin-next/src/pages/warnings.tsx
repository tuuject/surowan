import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { WarningCard } from '@/components/warnings/warning-card';
import { useForegroundRefresh } from '@/hooks/use-foreground-refresh';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { warningsQuery } from '@/lib/queries';
import { clearWarnings, markWarningRead } from '@/lib/api/warnings.ts';
import type { EventWarning } from '@/lib/api/warnings.ts';

export default function WarningsPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [clearOpen, setClearOpen] = useState(false);
  const query = useInfiniteQuery(warningsQuery());
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

  const first = query.data?.pages[0];
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const standing = first?.standing ?? [];
  const unreadCount = first?.unread_count ?? 0;

  return (
    <div className="space-y-6">
      <Panel title={t('pages.warnings.standingTitle')}>
        {query.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : query.isError ? (
          <p className="text-destructive text-sm break-words">
            {t('pages.warnings.loadFailed')}: {errorMessage(query.error)}
          </p>
        ) : standing.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('pages.warnings.noStanding')}</p>
        ) : (
          <div className="divide-y">
            {standing.map((warning) => (
              <WarningCard key={warning.code} warning={warning} />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title={t('pages.warnings.eventsTitle')}
        action={
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-sm">
              {t('pages.warnings.unreadCount', { count: formatNumber(unreadCount) })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={items.length === 0 || clear.isPending}
              onClick={() => setClearOpen(true)}
            >
              {t('pages.warnings.clearHistory')}
            </Button>
          </div>
        }
      >
        {query.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : query.isError ? (
          <p className="text-destructive text-sm break-words">
            {t('pages.warnings.loadFailed')}: {errorMessage(query.error)}
          </p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('pages.warnings.noEvents')}</p>
        ) : (
          <div className="divide-y">
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
        {query.hasNextPage ? (
          <div className="flex justify-center pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('pages.warnings.loadMore')}
            </Button>
          </div>
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
