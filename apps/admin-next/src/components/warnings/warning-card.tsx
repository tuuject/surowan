import { Link } from '@tanstack/react-router';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import { formatTime } from '@/lib/format';
import type { EventWarning, WarningItem, WarningSeverity } from '@/lib/api/warnings.ts';

function numberVariable(variables: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = variables[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringVariable(variables: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = variables[key];
  return typeof value === 'string' ? value : null;
}

function stringListVariable(variables: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = variables[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function severityTone(severity: WarningSeverity): 'warning' | 'danger' {
  return severity === 'critical' ? 'danger' : 'warning';
}

function WarningDetails({ warning }: { readonly warning: WarningItem }): React.ReactElement {
  const { t } = useTranslation();
  const { variables } = warning;
  const lastFailedAt = stringVariable(variables, 'last_failed_at');
  switch (warning.code) {
    case 'developer_payload_recording':
      return (
        <p className="text-muted-foreground text-sm">{t('pages.warnings.codes.developer_payload_recording.body')}</p>
      );
    case 'agent_model_missing':
    case 'vision_model_missing': {
      const fields = stringListVariable(variables, 'missing_fields');
      return (
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">{t(`pages.warnings.codes.${warning.code}.body`)}</p>
          {fields.length > 0 ? (
            <p className="text-muted-foreground font-mono text-xs">
              {t('pages.warnings.missingFields', { fields: fields.join(', ') })}
            </p>
          ) : null}
        </div>
      );
    }
    case 'invocation_failure_rate': {
      const failed = numberVariable(variables, 'failed');
      const total = numberVariable(variables, 'total');
      const rate = numberVariable(variables, 'failure_rate');
      const threshold = numberVariable(variables, 'threshold');
      return (
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">
            {t('pages.warnings.codes.invocation_failure_rate.body', {
              failed: failed ?? '—',
              total: total ?? '—',
              rate: rate === null ? '—' : Math.round(rate * 100),
              threshold: threshold === null ? '—' : Math.round(threshold * 100),
            })}
          </p>
          {lastFailedAt !== null ? (
            <p className="text-muted-foreground text-xs">
              {t('pages.warnings.lastFailedAt', { time: formatTime(lastFailedAt) })}
            </p>
          ) : null}
        </div>
      );
    }
    case 'admin_login_failures': {
      const failures = numberVariable(variables, 'consecutive_failures');
      return (
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">
            {t('pages.warnings.codes.admin_login_failures.body', { count: failures ?? '—' })}
          </p>
          {lastFailedAt !== null ? (
            <p className="text-muted-foreground text-xs">
              {t('pages.warnings.lastFailedAt', { time: formatTime(lastFailedAt) })}
            </p>
          ) : null}
        </div>
      );
    }
    default:
      return (
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">
            {t('pages.warnings.codes.unknown.body', { code: warning.code })}
          </p>
          <pre className="bg-muted max-h-40 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">
            {JSON.stringify(warning.variables, null, 2)}
          </pre>
        </div>
      );
  }
}

function WarningAction({ code }: { readonly code: string }): React.ReactElement | null {
  const { t } = useTranslation();
  switch (code) {
    case 'developer_payload_recording':
      return (
        <Button asChild size="sm" variant="outline">
          <Link to="/developer">{t('pages.warnings.actions.openDeveloper')}</Link>
        </Button>
      );
    case 'agent_model_missing':
    case 'vision_model_missing':
      return (
        <Button asChild size="sm" variant="outline">
          <Link to="/models">{t('pages.warnings.actions.openModels')}</Link>
        </Button>
      );
    case 'invocation_failure_rate':
      return (
        <Button asChild size="sm" variant="outline">
          <Link to="/invocations">{t('pages.warnings.actions.openInvocations')}</Link>
        </Button>
      );
    case 'admin_login_failures':
      return (
        <Button asChild size="sm" variant="outline">
          <Link to="/settings">{t('pages.warnings.actions.openSettings')}</Link>
        </Button>
      );
    default:
      return null;
  }
}

/** Explicit cases keep the typed i18n catalog honest; unknown codes fall back to their raw variables. */
function WarningTitle({ warning }: { readonly warning: WarningItem }): React.ReactElement {
  const { t } = useTranslation();
  switch (warning.code) {
    case 'developer_payload_recording':
      return <>{t('pages.warnings.codes.developer_payload_recording.title')}</>;
    case 'agent_model_missing':
      return <>{t('pages.warnings.codes.agent_model_missing.title')}</>;
    case 'vision_model_missing':
      return <>{t('pages.warnings.codes.vision_model_missing.title')}</>;
    case 'invocation_failure_rate':
      return <>{t('pages.warnings.codes.invocation_failure_rate.title')}</>;
    case 'admin_login_failures':
      return <>{t('pages.warnings.codes.admin_login_failures.title')}</>;
    default:
      return <>{t('pages.warnings.codes.unknown.title', { code: warning.code })}</>;
  }
}

/**
 * One warning rendered through the template for its code. Variables are plain
 * data: every value is interpolated as text, never as HTML.
 */
export function WarningCard({
  warning,
  onMarkRead,
  pending = false,
}: {
  readonly warning: WarningItem;
  readonly onMarkRead?: (warning: EventWarning) => void;
  readonly pending?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const Icon = warning.severity === 'critical' ? CircleAlert : TriangleAlert;
  const event = warning.kind === 'event' ? warning : null;
  const unread = event !== null && event.read_at === null;
  return (
    <div className="space-y-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Icon
            className={
              warning.severity === 'critical'
                ? 'mt-0.5 size-5 shrink-0 text-danger'
                : 'mt-0.5 size-5 shrink-0 text-warning'
            }
          />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">
                <WarningTitle warning={warning} />
              </h3>
              <ToneBadge tone={severityTone(warning.severity)}>
                {t(`pages.warnings.severity.${warning.severity}`)}
              </ToneBadge>
              {warning.kind === 'standing' ? <ToneBadge tone="info">{t('pages.warnings.standing')}</ToneBadge> : null}
              {unread ? <ToneBadge tone="warning">{t('pages.warnings.unread')}</ToneBadge> : null}
            </div>
            <WarningDetails warning={warning} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <WarningAction code={warning.code} />
          {unread ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (event !== null) {
                  onMarkRead?.(event);
                }
              }}
            >
              {t('pages.warnings.markRead')}
            </Button>
          ) : null}
        </div>
      </div>
      {event !== null ? (
        <p className="text-muted-foreground text-xs">
          {t('pages.warnings.createdAt', { time: formatTime(event.created_at) })}
          {' · '}
          {t('pages.warnings.updatedAt', { time: formatTime(event.updated_at) })}
          {event.read_at === null ? '' : ` · ${t('pages.warnings.readAt', { time: formatTime(event.read_at) })}`}
        </p>
      ) : null}
    </div>
  );
}
