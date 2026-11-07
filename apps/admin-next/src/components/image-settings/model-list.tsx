import type React from 'react';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, ListFooter, TableShell, useClientPagination } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ModelCapabilities } from './model-capabilities.tsx';
import type { EditableModel } from './shared.ts';

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
        <div className="space-y-1">
          <p className="text-sm font-medium">{model.name}</p>
          <p className="text-muted-foreground break-all text-xs">
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
        <div className="space-y-2">
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
          <p className="text-muted-foreground text-xs">{t('image.settings.modelDescriptionHint')}</p>
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
          aria-label={t('image.settings.removeModel', { name: model.name })}
          onClick={() => setModels((current) => current.filter((item) => item.key !== model.key))}
        >
          {t('image.settings.remove')}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {mergedDuplicates > 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('image.settings.mergedDuplicates', { count: mergedDuplicates })}
        </p>
      ) : null}
      <div>
        <TableShell
          columns={columns}
          data={pagination.items}
          rowKey={(model) => model.key}
          frame={false}
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
