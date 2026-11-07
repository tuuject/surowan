import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Tag } from '@tuuject/koi-react/tag';
import { useTranslation } from 'react-i18next';

/**
 * Pending-restart banner. `serve` has to be restarted by something outside the
 * process, so the button only appears when the deployment declared a supervisor
 * (`PLASTICWAN_SUPERVISED=1`); the paths are listed either way.
 */
export function RestartBanner({
  paths,
  supervised,
  pending,
  onRestart,
}: {
  readonly paths: readonly string[];
  readonly supervised: boolean;
  readonly pending: boolean;
  readonly onRestart: () => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  if (paths.length === 0) {
    return null;
  }
  return (
    <Alert
      tone="warning"
      title={t(paths.length === 1 ? 'models.models.restart.onePending' : 'models.models.restart.manyPending', {
        count: paths.length,
      })}
      {...(supervised
        ? {
            action: (
              <Button
                size="sm"
                variant="ghost"
                color="warning"
                loading={pending}
                loadingLabel={t('models.models.restart.restarting')}
                onClick={onRestart}
              >
                {t('models.models.restart.restartNow')}
              </Button>
            ),
          }
        : {})}
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
        <p className={css({ margin: '0' })}>
          {t('models.models.restart.writtenNote')}
          {supervised ? null : ` ${t('models.models.restart.noSupervisor')}`}
        </p>
        {/* One tag per path: a long joined line wraps into an unreadable paragraph once a few fields wait. */}
        <ul className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
          {paths.map((path) => (
            <li key={path}>
              <Tag>
                <span className={css({ fontFamily: 'mono' })}>{path}</span>
              </Tag>
            </li>
          ))}
        </ul>
      </div>
    </Alert>
  );
}
