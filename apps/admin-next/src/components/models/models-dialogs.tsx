import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/business';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import { ModelPickerDialog, type ModelPickerMode } from '@/components/models/model-picker-dialog';
import { ProviderWizard } from '@/components/models/provider-wizard';

import { modelFormFromConfig } from '@/lib/model-manager.ts';
import type { ProviderModelConfig, ProviderView, ProvidersView } from '@/lib/api/providers.ts';

export interface PickerTarget {
  readonly mode: ModelPickerMode;
  readonly alias: string;
  /** Remounts the dialog so its credentials and selection start empty. */
  readonly nonce: number;
}

export interface EditingTarget {
  readonly alias: string;
  readonly model: ProviderModelConfig;
  readonly revision: string;
}

export interface DeletingModelTarget {
  readonly alias: string;
  readonly model: string;
}

/** A write the edit form drives; the page owns the mutation. */
export interface ModelSaveState {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (model: ProviderModelConfig) => void;
}

/** A write a confirmation dialog drives; the page owns the mutation. */
export interface ConfirmState {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
}

/**
 * Every overlay the page can show: the provider wizard, the model picker, the
 * model edit form and the two delete confirmations.
 */
export function ModelsDialogs({
  view,
  revision,
  wizardOpen,
  onWizardClose,
  onProviderCreated,
  picker,
  pickerProvider,
  onPickerClose,
  editing,
  onEditingClose,
  save,
  deletingModel,
  onDeletingModelClose,
  removeModel,
  deletingProvider,
  onDeletingProviderClose,
  removeProvider,
}: {
  readonly view: ProvidersView;
  readonly revision: string;
  readonly wizardOpen: boolean;
  readonly onWizardClose: () => void;
  readonly onProviderCreated: (alias: string) => void;
  readonly picker: PickerTarget | null;
  readonly pickerProvider: ProviderView | null;
  readonly onPickerClose: () => void;
  readonly editing: EditingTarget | null;
  readonly onEditingClose: () => void;
  readonly save: ModelSaveState;
  readonly deletingModel: DeletingModelTarget | null;
  readonly onDeletingModelClose: () => void;
  readonly removeModel: ConfirmState;
  readonly deletingProvider: ProviderView | null;
  readonly onDeletingProviderClose: () => void;
  readonly removeProvider: ConfirmState;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {wizardOpen ? <ProviderWizard revision={revision} onClose={onWizardClose} onCreated={onProviderCreated} /> : null}

      {picker === null || pickerProvider === null ? null : (
        <ModelPickerDialog
          key={`${picker.mode}-${picker.alias}-${String(picker.nonce)}`}
          mode={picker.mode}
          provider={pickerProvider}
          revision={revision}
          onClose={onPickerClose}
        />
      )}

      {editing === null ? null : (
        <ModelEditDialog
          key={`edit-${editing.alias}/${editing.model.id}`}
          open
          onOpenChange={(next) => {
            if (!next) {
              onEditingClose();
            }
          }}
          api={view.providers.find((provider) => provider.alias === editing.alias)?.api ?? 'openai-completions'}
          title={t('models.models.page.editTitle', { model: editing.model.id })}
          description={t('models.models.page.editDescription')}
          initial={modelFormFromConfig(
            editing.model,
            view.providers.find((provider) => provider.alias === editing.alias)?.api ?? 'openai-completions',
          )}
          lockId
          draft={null}
          pending={save.pending}
          error={save.error}
          onSubmit={save.onSubmit}
        />
      )}

      <ConfirmDialog
        open={deletingModel !== null}
        onOpenChange={(open) => {
          if (!open && !removeModel.pending) {
            onDeletingModelClose();
          }
        }}
        title={t('models.models.page.deleteModelTitle')}
        description={
          deletingModel === null
            ? ''
            : t('models.models.page.deleteModelDescription', { model: deletingModel.model, alias: deletingModel.alias })
        }
        confirmText={t('models.models.page.deleteModelConfirm')}
        destructive
        pending={removeModel.pending}
        error={removeModel.error}
        onConfirm={removeModel.onConfirm}
      />

      <ConfirmDialog
        open={deletingProvider !== null}
        onOpenChange={(open) => {
          if (!open && !removeProvider.pending) {
            onDeletingProviderClose();
          }
        }}
        title={t('models.models.page.deleteProviderTitle')}
        description={
          deletingProvider === null
            ? ''
            : t('models.models.page.deleteProviderDescription', { alias: deletingProvider.alias })
        }
        confirmText={t('models.models.page.deleteProviderConfirm')}
        destructive
        pending={removeProvider.pending}
        error={removeProvider.error}
        onConfirm={removeProvider.onConfirm}
      />
    </>
  );
}
