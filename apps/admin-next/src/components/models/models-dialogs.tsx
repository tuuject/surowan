import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, MonoValue } from '@/components/business';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import { ModelPickerDialog, type ModelPickerMode } from '@/components/models/model-picker-dialog';
import { ProviderWizard } from '@/components/models/provider-wizard';
import type { ProviderModelConfig, ProvidersView, ProviderView } from '@/lib/api/providers.ts';
import { emptyModelForm, modelFormFromConfig } from '@/lib/model-form.ts';

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
  readonly nonce: number;
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

/** A write a confirmation dialog drives; the page owns the mutation and whether the dialog shows. */
export interface ConfirmState {
  readonly open: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * Every overlay the Providers page can show: the provider wizard, the model
 * picker, the model edit form and the two delete confirmations.
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
  editingOpen,
  onEditingClose,
  save,
  deletingModels,
  removeModel,
  deletingProvider,
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
  readonly editingOpen: boolean;
  readonly onEditingClose: () => void;
  readonly save: ModelSaveState;
  readonly deletingModels: readonly DeletingModelTarget[];
  readonly removeModel: ConfirmState;
  readonly deletingProvider: ProviderView | null;
  readonly removeProvider: ConfirmState;
}): ReactElement {
  const { t } = useTranslation();
  const editingApi = view.providers.find((provider) => provider.alias === editing?.alias)?.api ?? 'openai-completions';
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

      <ModelEditDialog
        open={editingOpen}
        onOpenChange={(next) => {
          if (!next) {
            onEditingClose();
          }
        }}
        api={editingApi}
        title={editing === null ? '' : t('models.models.page.editTitle', { model: editing.model.id })}
        description={t('models.models.page.editDescription')}
        initial={editing === null ? emptyModelForm(editingApi) : modelFormFromConfig(editing.model, editingApi)}
        formKey={editing?.nonce}
        lockId
        draft={null}
        pending={save.pending}
        error={save.error}
        onSubmit={save.onSubmit}
      />

      {/* `open` stays apart from the target so the text doesn't blank out while the exit fade plays. */}
      <ConfirmDialog
        open={removeModel.open}
        onOpenChange={(open) => {
          if (!open && !removeModel.pending) {
            removeModel.onClose();
          }
        }}
        title={t(
          deletingModels.length > 1 ? 'models.models.page.deleteModelsTitle' : 'models.models.page.deleteModelTitle',
        )}
        description={
          deletingModels.length > 1
            ? t('models.models.page.deleteModelsDescription', { count: deletingModels.length })
            : deletingModels[0] === undefined
              ? ''
              : t('models.models.page.deleteModelDescription', { ...deletingModels[0] })
        }
        confirmText={t(
          deletingModels.length > 1
            ? 'models.models.page.deleteModelsConfirm'
            : 'models.models.page.deleteModelConfirm',
        )}
        destructive
        pending={removeModel.pending}
        error={removeModel.error}
        onConfirm={removeModel.onConfirm}
      >
        {deletingModels.length > 1 ? (
          <ul
            className={css({
              maxHeight: '256px',
              overflow: 'auto',
              paddingInlineStart: '5',
              overflowWrap: 'anywhere',
            })}
          >
            {deletingModels.map((target) => (
              <li key={`${target.alias}/${target.model}`}>
                <MonoValue value={`${target.alias}/${target.model}`} />
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={removeProvider.open}
        onOpenChange={(open) => {
          if (!open && !removeProvider.pending) {
            removeProvider.onClose();
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
