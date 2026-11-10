import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, MonoValue } from '@/components/business';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import { ModelPickerDialog, type ModelPickerMode } from '@/components/models/model-picker-dialog';
import { ProviderWizard } from '@/components/models/provider-wizard';
import type { ProviderApi, ProviderModelConfig, ProviderView } from '@/lib/api/providers.ts';
import { emptyModelForm, modelFormFromConfig } from '@/lib/model-form.ts';

export interface PickerTarget {
  readonly mode: ModelPickerMode;
  /**
   * The provider as it looked when the picker was opened: a background refetch
   * must not blank or change the dialog while it is open or fading out.
   */
  readonly provider: ProviderView;
  /** Starts a fresh picker session so its credentials and selection are empty. */
  readonly nonce: number;
}

export interface EditingTarget {
  readonly alias: string;
  readonly model: ProviderModelConfig;
  /** Snapshot: a refetch must not swap the form's API dialect mid-edit. */
  readonly api: ProviderApi;
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
 * Stand-in for the picker's provider before the first open. The dialog root has
 * to exist from the page's first render so its enter transition can play later;
 * with `open` false Base UI mounts no portal, so nothing here is ever shown.
 */
const NO_PICKER_PROVIDER: ProviderView = {
  alias: '',
  kind: 'custom',
  api: 'openai-completions',
  base_url: '',
  header_names: [],
  models: [],
};

/**
 * Every overlay the Providers page can show: the provider wizard, the model
 * picker, the model edit form and the two delete confirmations.
 *
 * The wizard and the picker are mounted for the page's lifetime and driven by
 * `open`: Base UI only plays the 300ms exit transition while the dialog root
 * stays mounted, so nothing here may appear or disappear with the flag.
 */
export function ModelsDialogs({
  revision,
  wizardOpen,
  wizardKey,
  onWizardClose,
  onProviderCreated,
  picker,
  pickerOpen,
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
  readonly revision: string;
  readonly wizardOpen: boolean;
  readonly wizardKey: number;
  readonly onWizardClose: () => void;
  readonly onProviderCreated: (alias: string) => void;
  readonly picker: PickerTarget | null;
  readonly pickerOpen: boolean;
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
  const editingApi = editing?.api ?? 'openai-completions';
  const deleteModelsDescription = (): string => {
    if (deletingModels.length > 1) {
      return t('models.models.page.deleteModelsDescription', { count: deletingModels.length });
    }
    const only = deletingModels[0];
    return only === undefined ? '' : t('models.models.page.deleteModelDescription', { ...only });
  };

  return (
    <>
      <ProviderWizard
        open={wizardOpen}
        formKey={wizardKey}
        revision={revision}
        onOpenChange={(next) => {
          if (!next) {
            onWizardClose();
          }
        }}
        onCreated={onProviderCreated}
      />

      <ModelPickerDialog
        open={pickerOpen}
        formKey={picker?.nonce ?? 0}
        mode={picker?.mode ?? 'discover'}
        provider={picker?.provider ?? NO_PICKER_PROVIDER}
        revision={revision}
        onOpenChange={(next) => {
          if (!next) {
            onPickerClose();
          }
        }}
      />

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
        description={deleteModelsDescription()}
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
