import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Button } from '@tuuject/koi-react/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@tuuject/koi-react/switch';
import { clearModelPayloads, updateDeveloperSettings } from '@/lib/api/config.ts';
import { errorMessage } from '@/lib/errors';
import { developerQuery } from '@/lib/queries';
import { useProviderWrite } from '@/lib/use-provider-write';
import { css } from '@tuuject/koi-react/styled-system/css';

/** The two independent switches the page mutates through the same PUT /developer endpoint. */
type DeveloperSwitch = 'record_model_payloads' | 'record_agent_thinking';

export default function DeveloperPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery(developerQuery);
  const write = useProviderWrite();
  const [confirmClear, setConfirmClear] = useState(false);
  const update = useMutation({
    mutationFn: ({ field, enabled, revision }: { field: DeveloperSwitch; enabled: boolean; revision: string }) =>
      updateDeveloperSettings(
        field === 'record_model_payloads' ? { record_model_payloads: enabled } : { record_agent_thinking: enabled },
        revision,
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(developerQuery.queryKey, result);
      write.succeeded(result.apply);
    },
    onError: write.failed,
  });
  const clear = useMutation({
    mutationFn: clearModelPayloads,
    onSuccess: () => {
      setConfirmClear(false);
    },
    onSettled: () => {
      // Even a failed sweep may have committed earlier batches.
      void queryClient.invalidateQueries({ queryKey: ['invocation'] });
    },
  });
  const current = settings.data;

  return (
    <div className={css({ maxWidth: '32rem', '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <Panel title={t('models.developer.debugTitle')} description={t('models.developer.debugDescription')}>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
          {settings.isPending ? (
            <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('common.loading')}</p>
          ) : settings.isError || current === undefined ? (
            <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {errorMessage(settings.error)}
            </p>
          ) : (
            <>
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '4',
                })}
              >
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
                  <Label htmlFor="record-model-payloads">{t('models.developer.recordLabel')}</Label>
                  <p id="payload-description" className={css({ textStyle: 'body', color: 'text-muted' })}>
                    {t('models.developer.recordDescription')}
                  </p>
                </div>
                <Switch
                  id="record-model-payloads"
                  aria-describedby="payload-description"
                  checked={current.record_model_payloads}
                  disabled={update.isPending}
                  onCheckedChange={(enabled) =>
                    update.mutate({ field: 'record_model_payloads', enabled, revision: current.revision })
                  }
                />
              </div>
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('models.developer.recordHint')}</p>
              {current.record_model_payloads !== current.active_record_model_payloads ? (
                <p role="status" className={css({ textStyle: 'body', color: 'warning-text' })}>
                  {t('models.developer.stateMismatch', {
                    status: current.active_record_model_payloads ? t('common.on') : t('common.off'),
                  })}
                </p>
              ) : null}
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '4',
                })}
              >
                <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
                  <Label htmlFor="record-agent-thinking">{t('models.developer.thinkingLabel')}</Label>
                  <p id="thinking-description" className={css({ textStyle: 'body', color: 'text-muted' })}>
                    {t('models.developer.thinkingDescription')}
                  </p>
                </div>
                <Switch
                  id="record-agent-thinking"
                  aria-describedby="thinking-description"
                  checked={current.record_agent_thinking}
                  disabled={update.isPending}
                  onCheckedChange={(enabled) =>
                    update.mutate({ field: 'record_agent_thinking', enabled, revision: current.revision })
                  }
                />
              </div>
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('models.developer.thinkingHint')}</p>
              {current.record_agent_thinking !== current.active_record_agent_thinking ? (
                <p role="status" className={css({ textStyle: 'body', color: 'warning-text' })}>
                  {t('models.developer.stateMismatch', {
                    status: current.active_record_agent_thinking ? t('common.on') : t('common.off'),
                  })}
                </p>
              ) : null}
              {update.isError ? (
                <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
                  {errorMessage(update.error)}
                </p>
              ) : null}
            </>
          )}
        </div>
      </Panel>
      <Panel title={t('models.developer.historyTitle')} description={t('models.developer.historyDescription')}>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
          <Button
            color="error"
            className={css({ height: 'auto', minHeight: 'control-md', whiteSpace: 'normal', textAlign: 'start' })}
            disabled={clear.isPending}
            onClick={() => {
              clear.reset();
              setConfirmClear(true);
            }}
          >
            {t('models.developer.clearButton')}
          </Button>
          {clear.isSuccess ? (
            <p role="status" className={css({ textStyle: 'body', color: 'text-brand' })}>
              {t('models.developer.cleared', { count: clear.data.cleared_model_calls })}
            </p>
          ) : null}
        </div>
      </Panel>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={(open) => {
          if (!clear.isPending) {
            setConfirmClear(open);
          }
        }}
        title={t('models.developer.confirmTitle')}
        description={t('models.developer.confirmDescription')}
        confirmText={t('models.developer.confirmClear')}
        cancelText={t('common.cancel')}
        destructive
        pending={clear.isPending}
        error={clear.isError ? errorMessage(clear.error) : null}
        onConfirm={() => clear.mutate()}
      />
    </div>
  );
}
