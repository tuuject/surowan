import { useTranslation } from 'react-i18next';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';

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
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <p className={css({ textStyle: 'small' })}>{t('models.models.restart.writtenNote')}</p>
        {/* One chip per path: a long joined line wraps into an unreadable
              paragraph as soon as a few fields are waiting. */}
        <ul className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
          {paths.map((path) => (
            <li
              key={path}
              className={css({
                textStyle: 'small',
                bg: 'surface-muted',
                color: 'text-muted',
                borderRadius: 'lg',
                paddingInline: '2',
                paddingBlock: '1',
                fontFamily: 'mono',
              })}
            >
              {path}
            </li>
          ))}
        </ul>
        {supervised ? (
          <Button type="button" size="sm" disabled={pending} onClick={onRestart}>
            {pending ? t('models.models.restart.restarting') : t('models.models.restart.restartNow')}
          </Button>
        ) : (
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('models.models.restart.noSupervisor')}</p>
        )}
      </div>
    </Alert>
  );
}
