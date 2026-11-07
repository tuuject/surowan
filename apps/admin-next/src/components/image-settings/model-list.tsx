import type React from 'react';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, ListFooter, TableShell, useClientPagination } from '@/components/business';
import { Button } from '@tuuject/koi-react/button';
import { Textarea } from '@tuuject/koi-react/textarea';
import { ModelCapabilities } from './model-capabilities.tsx';
import type { EditableModel } from './shared.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

/** The models that will be saved, with editable descriptions kept visible in each row. */
export function ModelList({
  models,
  setModels,
  mergedDuplicates,
}: {
  readonly models: readonly EditableModel[];
  readonly setModels: React.Dispatch<React.SetStateAction<EditableModel[]>>;
  readonly mergedDuplicates: number;
}): React.ReactElement {
  const { t } = useTranslation();
  const pagination = useClientPagination(models, 'image-settings-models');
  const columns: readonly ColumnSpec<EditableModel>[] = [
    {
      key: 'model',
      title: t('image.settings.modelsPanelTitle'),
      className: 'min-w-48',
      render: (model) => (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <p className={css({ textStyle: 'label' })}>{model.name}</p>
          <p className={css({ textStyle: 'small', color: 'text-muted', wordBreak: 'break-all' })}>
            {model.upstreamModel} · {model.providerTag} ·{' '}
            {t('image.settings.credentialRef', { name: model.credentialRef })}
          </p>
        </div>
      ),
    },
    {
      key: 'capabilities',
      title: t('image.settings.capabilitiesTitle'),
      render: (model) => <ModelCapabilities capabilities={model.capabilities} />,
    },
    {
      key: 'description',
      title: t('image.settings.modelDescriptionLabel'),
      className: 'min-w-72',
      render: (model) => (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <Textarea
            id={`model-description-${model.key}`}
            aria-label={t('image.settings.modelDescriptionLabel')}
            rows={2}
            maxLength={1000}
            value={model.description}
            placeholder={t('image.settings.modelDescriptionPlaceholder')}
            onChange={(event) =>
              setModels((current) =>
                current.map((item) => (item.key === model.key ? { ...item, description: event.target.value } : item)),
              )
            }
          />
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('image.settings.modelDescriptionHint')}</p>
        </div>
      ),
    },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      align: 'right',
      render: (model) => (
        <Button
          size="sm"
          variant="ghost"
          color="secondary"
          aria-label={t('image.settings.removeModel', { name: model.name })}
          onClick={() => setModels((current) => current.filter((item) => item.key !== model.key))}
        >
          {t('image.settings.remove')}
        </Button>
      ),
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
      {mergedDuplicates > 0 ? (
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>
          {t('image.settings.mergedDuplicates', { count: mergedDuplicates })}
        </p>
      ) : null}
      <div>
        <TableShell
          columns={columns}
          data={pagination.items}
          rowKey={(model) => model.key}
          emptyText={t('image.settings.noModelsYet')}
        />
        <ListFooter
          count={pagination.total}
          page={pagination.page}
          pageCount={pagination.pageCount}
          onPageChange={pagination.onPageChange}
        />
      </div>
    </div>
  );
}
