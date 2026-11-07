import type React from 'react';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, ListFooter, RowActions, TableShell, useClientPagination } from '@/components/business';
import { Alert } from '@tuuject/koi-react/alert';
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
      render: (model) => (
        <div className={css({ minWidth: '0', whiteSpace: 'normal' })}>
          <p className={css({ margin: '0' })}>{model.name}</p>
          <p
            className={css({
              margin: '0',
              display: 'flex',
              flexWrap: 'wrap',
              columnGap: '2',
              textStyle: 'small',
              color: 'text-muted',
              overflowWrap: 'anywhere',
            })}
          >
            <span>{model.upstreamModel}</span>
            <span>{model.providerTag}</span>
            <span>{t('image.settings.credentialRef', { name: model.credentialRef })}</span>
          </p>
        </div>
      ),
    },
    {
      key: 'capabilities',
      title: t('image.settings.capabilitiesTitle'),
      className: css({ whiteSpace: 'normal' }),
      render: (model) => <ModelCapabilities capabilities={model.capabilities} />,
    },
    {
      key: 'description',
      title: t('image.settings.modelDescriptionLabel'),
      className: css({ whiteSpace: 'normal' }),
      render: (model) => (
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '1', paddingBlock: '2' })}>
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
      width: 88,
      render: (model) => (
        <RowActions>
          <Button
            size="sm"
            variant="ghost"
            color="error"
            aria-label={t('image.settings.removeModel', { name: model.name })}
            onClick={() => setModels((current) => current.filter((item) => item.key !== model.key))}
          >
            {t('image.settings.remove')}
          </Button>
        </RowActions>
      ),
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
      {mergedDuplicates > 0 ? (
        <Alert tone="info">{t('image.settings.mergedDuplicates', { count: mergedDuplicates })}</Alert>
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
