import { Button } from '@tuuject/koi-react/button';
import { ErrorIcon, WarningIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ToneBadge } from '@/components/business';
import { ButtonLink } from '@/components/router-links';
import type { EventWarning, WarningItem, WarningSeverity } from '@/lib/api/warnings.ts';
import { formatTime } from '@/lib/format';

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

function invalidApiKeyLabels(variables: Readonly<Record<string, unknown>>): readonly string[] {
  const value = variables.keys;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || !('name' in item) || typeof item.name !== 'string') {
      return [];
    }
    return [item.name];
  });
}

function severityTone(severity: WarningSeverity): 'warning' | 'danger' {
  return severity === 'critical' ? 'danger' : 'warning';
}

function WarningDetails({ warning }: { readonly warning: WarningItem }): ReactElement {
  const { t } = useTranslation();
  const { variables } = warning;
  const lastFailedAt = stringVariable(variables, 'last_failed_at');
  switch (warning.code) {
    case 'developer_payload_recording':
      return (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {t('pages.warnings.codes.developer_payload_recording.body')}
        </p>
      );
    case 'agent_model_missing':
    case 'vision_model_missing': {
      const fields = stringListVariable(variables, 'missing_fields');
      return (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>
            {t(`pages.warnings.codes.${warning.code}.body`)}
          </p>
          {fields.length > 0 ? (
            <p className={css({ textStyle: 'small', color: 'text-muted', fontFamily: 'mono' })}>
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
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>
            {t('pages.warnings.codes.invocation_failure_rate.body', {
              failed: failed ?? '—',
              total: total ?? '—',
              rate: rate === null ? '—' : Math.round(rate * 100),
              threshold: threshold === null ? '—' : Math.round(threshold * 100),
            })}
          </p>
          {lastFailedAt !== null ? (
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('pages.warnings.lastFailedAt', { time: formatTime(lastFailedAt) })}
            </p>
          ) : null}
        </div>
      );
    }
    case 'admin_login_failures': {
      const failures = numberVariable(variables, 'consecutive_failures');
      return (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>
            {t('pages.warnings.codes.admin_login_failures.body', { count: failures ?? '—' })}
          </p>
          {lastFailedAt !== null ? (
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('pages.warnings.lastFailedAt', { time: formatTime(lastFailedAt) })}
            </p>
          ) : null}
        </div>
      );
    }
    case 'telegram_network_error':
      return (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {t('pages.warnings.codes.telegram_network_error.body')}
        </p>
      );
    case 'telegram_config_error': {
      const reason = stringVariable(variables, 'reason');
      const body =
        reason === 'unauthorized' || reason === 'conflict' || reason === 'token_unreadable'
          ? t(`pages.warnings.codes.telegram_config_error.body.${reason}`)
          : t('pages.warnings.codes.telegram_config_error.body.unknown');
      return <p className={css({ textStyle: 'body', color: 'text-muted' })}>{body}</p>;
    }
    case 'api_key_invalid_permissions': {
      const names = invalidApiKeyLabels(variables);
      return (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>
            {t('pages.warnings.codes.api_key_invalid_permissions.body')}
          </p>
          {names.length > 0 ? (
            <p className={css({ textStyle: 'small', color: 'text-muted', fontFamily: 'mono' })}>
              {t('pages.warnings.invalidApiKeys', { keys: names.join(', ') })}
            </p>
          ) : null}
        </div>
      );
    }
    default:
      return (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>
            {t('pages.warnings.codes.unknown.body', { code: warning.code })}
          </p>
          <pre
            className={css({
              textStyle: 'small',
              bg: 'surface-muted',
              maxHeight: '160px',
              overflow: 'auto',
              borderRadius: 'lg',
              padding: '2',
              whiteSpace: 'pre-wrap',
            })}
          >
            {JSON.stringify(warning.variables, null, 2)}
          </pre>
        </div>
      );
  }
}

function WarningAction({ code }: { readonly code: string }): ReactElement | null {
  const { t } = useTranslation();
  switch (code) {
    case 'developer_payload_recording':
      return (
        <ButtonLink to="/developer" variant="outline" color="secondary">
          {t('pages.warnings.actions.openDeveloper')}
        </ButtonLink>
      );
    case 'agent_model_missing':
    case 'vision_model_missing':
      return (
        <ButtonLink to="/models" variant="outline" color="secondary">
          {t('pages.warnings.actions.openModels')}
        </ButtonLink>
      );
    case 'invocation_failure_rate':
      return (
        <ButtonLink to="/invocations" variant="outline" color="secondary">
          {t('pages.warnings.actions.openInvocations')}
        </ButtonLink>
      );
    case 'admin_login_failures':
      return (
        <ButtonLink to="/settings" variant="outline" color="secondary">
          {t('pages.warnings.actions.openSettings')}
        </ButtonLink>
      );
    case 'telegram_network_error':
    case 'telegram_config_error':
      return (
        <ButtonLink to="/telegram" variant="outline" color="secondary">
          {t('pages.warnings.actions.openTelegram')}
        </ButtonLink>
      );
    case 'api_key_invalid_permissions':
      return (
        <ButtonLink to="/api-keys" variant="outline" color="secondary">
          {t('pages.warnings.actions.openApiKeys')}
        </ButtonLink>
      );
    default:
      return null;
  }
}

/** Explicit cases keep the typed i18n catalog honest; unknown codes fall back to their raw variables. */
function WarningTitle({ warning }: { readonly warning: WarningItem }): ReactElement {
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
    case 'telegram_network_error':
      return <>{t('pages.warnings.codes.telegram_network_error.title')}</>;
    case 'api_key_invalid_permissions':
      return <>{t('pages.warnings.codes.api_key_invalid_permissions.title')}</>;
    case 'telegram_config_error': {
      const reason = stringVariable(warning.variables, 'reason');
      switch (reason) {
        case 'unauthorized':
          return <>{t('pages.warnings.codes.telegram_config_error.unauthorized')}</>;
        case 'conflict':
          return <>{t('pages.warnings.codes.telegram_config_error.conflict')}</>;
        case 'token_unreadable':
          return <>{t('pages.warnings.codes.telegram_config_error.token_unreadable')}</>;
        default:
          return <>{t('pages.warnings.codes.telegram_config_error.title')}</>;
      }
    }
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
}): ReactElement {
  const { t } = useTranslation();
  const Icon = warning.severity === 'critical' ? ErrorIcon : WarningIcon;
  const event = warning.kind === 'event' ? warning : null;
  const unread = event !== null && event.read_at === null;
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' }, paddingBlock: '3' })}>
      <div
        className={css({
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '3',
        })}
      >
        <div className={css({ display: 'flex', minWidth: '0', alignItems: 'flex-start', gap: '3' })}>
          <Icon
            size={sizes['icon-lg']}
            className={css({
              flexShrink: '0',
              marginBlockStart: '1px',
              color: warning.severity === 'critical' ? 'error-text' : 'warning-text',
            })}
          />
          <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
              <h3 className={css({ textStyle: 'label' })}>
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
        <div className={css({ display: 'flex', flexShrink: '0', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
          <WarningAction code={warning.code} />
          {unread ? (
            <Button
              type="button"
              variant="ghost"
              color="secondary"
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
        <p
          className={css({
            display: 'flex',
            flexWrap: 'wrap',
            columnGap: '4',
            rowGap: '1',
            margin: '0',
            textStyle: 'small',
            color: 'text-muted',
          })}
        >
          <span>{t('pages.warnings.createdAt', { time: formatTime(event.created_at) })}</span>
          <span>{t('pages.warnings.updatedAt', { time: formatTime(event.updated_at) })}</span>
          {event.read_at === null ? null : (
            <span>{t('pages.warnings.readAt', { time: formatTime(event.read_at) })}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}
