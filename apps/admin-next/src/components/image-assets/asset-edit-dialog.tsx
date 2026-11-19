import { useMutation } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingRow } from '@/components/business';
import { SparklesIcon } from '@/components/icons';
import { MarkdownInput } from '@/components/prompts/markdown-input';
import { AppLink } from '@/components/router-links';
import type { ExtractionModelOption, ImageAssetInfo } from '@/lib/api/images.ts';
import { extractImageAsset, ToolModelNoImageInputError, updateImageAsset } from '@/lib/api/images.ts';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast.ts';

/**
 * The image-asset editor: name, description, category, keywords and the
 * agent-visibility switch. "Suggest with AI" is a two-step preview — a model
 * looks at the picture and proposes a name and keywords, nothing is saved until
 * the admin saves the dialog, and only the fields that changed since it opened
 * are sent, so a save can never silently re-promote an asset another admin
 * demoted meanwhile. When the tool model cannot read images, the dialog
 * explains that, links to where the tool model is configured, and offers a
 * one-off image-capable model for this run only (never persisted).
 *
 * Every opening is a fresh edit session: fields and extraction state are
 * seeded and cleared on the open edge — including reopening the same row — and
 * an extraction that lands after its session closed is ignored.
 */
export function AssetEditDialog({
  target,
  onClose,
  onSaved,
}: {
  readonly target: ImageAssetInfo | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [keywords, setKeywords] = useState('');
  const [agentVisible, setAgentVisible] = useState(false);
  // The open edge seeds a fresh session; `session` marks which extraction
  // replies still belong to it.
  const [wasOpen, setWasOpen] = useState(false);
  const sessionRef = useRef(0);
  const [blockedModels, setBlockedModels] = useState<readonly ExtractionModelOption[] | null>(null);
  const [modelChoice, setModelChoice] = useState('');
  const [thinkingChoice, setThinkingChoice] = useState('');
  const [extractFailed, setExtractFailed] = useState<string | null>(null);
  const [lastTarget, setLastTarget] = useState<ImageAssetInfo | null>(null);
  if (target !== null && !wasOpen) {
    setWasOpen(true);
    sessionRef.current += 1;
    setLastTarget(target);
    setName(target.name);
    setDescription(target.description);
    setCategory(target.category);
    setKeywords(target.keywords);
    setAgentVisible(target.agentVisible);
    setBlockedModels(null);
    setModelChoice('');
    setThinkingChoice('');
    setExtractFailed(null);
  }
  if (target === null && wasOpen) {
    setWasOpen(false);
  }

  /** Only the fields the admin actually changed; an untouched dialog saves nothing. */
  const changedFields = () => {
    if (lastTarget === null) {
      return {} as Record<string, never>;
    }
    const body: {
      name?: string;
      description?: string;
      category?: string;
      keywords?: string;
      agentVisible?: boolean;
    } = {};
    if (name !== lastTarget.name) {
      body.name = name;
    }
    if (description !== lastTarget.description) {
      body.description = description;
    }
    if (category !== lastTarget.category) {
      body.category = category;
    }
    if (keywords !== lastTarget.keywords) {
      body.keywords = keywords;
    }
    if (agentVisible !== lastTarget.agentVisible) {
      body.agentVisible = agentVisible;
    }
    return body;
  };
  const hasChanges = Object.keys(changedFields()).length > 0;

  const save = useMutation({
    mutationFn: async () => {
      if (lastTarget === null) {
        return;
      }
      return updateImageAsset(lastTarget.id, changedFields());
    },
    onSuccess: () => {
      toast.success(t('image.assets.savedToast'));
      onSaved();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const extract = useMutation({
    mutationFn: async (session: number) => {
      if (lastTarget === null) {
        return;
      }
      const override = oneOffOverride(modelChoice, thinkingChoice, blockedModels);
      return { session, metadata: await extractImageAsset(lastTarget.id, override) };
    },
    onSuccess: (outcome) => {
      if (outcome === undefined || outcome.session !== sessionRef.current) {
        return;
      }
      setBlockedModels(null);
      setExtractFailed(null);
      setName(outcome.metadata.name);
      setKeywords(outcome.metadata.keywords.join(', '));
    },
    onError: (error, session) => {
      if (session !== sessionRef.current) {
        return;
      }
      if (error instanceof ToolModelNoImageInputError) {
        setBlockedModels(error.models);
        setExtractFailed(null);
        const first = error.models[0];
        setModelChoice(first === undefined ? '' : `${first.provider}/${first.model}`);
        setThinkingChoice(first?.thinking_levels[0] ?? '');
        return;
      }
      setExtractFailed(errorMessage(error));
    },
  });

  const selected = blockedModels?.find((option) => `${option.provider}/${option.model}` === modelChoice) ?? undefined;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => !next && !save.isPending && onClose()}
      title={lastTarget === null ? '' : t('image.assets.editTitle', { name: lastTarget.name })}
      size="lg"
      footer={
        <>
          <Button variant="ghost" color="secondary" onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => (hasChanges ? save.mutate() : onClose())}
            disabled={save.isPending || name.trim() === ''}
            loading={save.isPending}
            loadingLabel={t('common.submitting')}
          >
            {t('image.assets.save')}
          </Button>
        </>
      }
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        <SettingRow label={t('image.assets.extract')} description={t('image.assets.extractHelp')}>
          {({ id }) => (
            <Button
              id={id}
              variant="outline"
              color="secondary"
              iconStart={<SparklesIcon />}
              loading={extract.isPending}
              loadingLabel={t('image.assets.extracting')}
              onClick={() => extract.mutate(sessionRef.current)}
            >
              {t('image.assets.extract')}
            </Button>
          )}
        </SettingRow>
        {blockedModels !== null ? (
          <Alert tone="warning">
            <p className={css({ margin: '0' })}>{t('image.assets.extractNoImageInput')}</p>
            <p className={css({ margin: '0', marginBlockStart: '1' })}>
              <AppLink to="/models">{t('image.assets.extractConfigureToolModel')}</AppLink>
            </p>
            {blockedModels.length > 0 ? (
              <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2', marginBlockStart: '2' })}>
                <Select
                  aria-label={t('image.assets.extractOneOffModel')}
                  value={modelChoice}
                  onChange={(event) => {
                    setModelChoice(event.target.value);
                    const next = blockedModels.find(
                      (option) => `${option.provider}/${option.model}` === event.target.value,
                    );
                    setThinkingChoice(next?.thinking_levels[0] ?? '');
                  }}
                  options={blockedModels.map((option) => ({
                    value: `${option.provider}/${option.model}`,
                    label: option.name,
                  }))}
                />
                {selected !== undefined && selected.thinking_levels.length > 0 ? (
                  <Select
                    aria-label={t('image.assets.extractOneOffThinking')}
                    value={thinkingChoice}
                    onChange={(event) => setThinkingChoice(event.target.value)}
                    options={selected.thinking_levels.map((level) => ({ value: level, label: level }))}
                  />
                ) : null}
              </div>
            ) : (
              <p className={css({ margin: '0', marginBlockStart: '1' })}>{t('image.assets.extractNoImageModels')}</p>
            )}
          </Alert>
        ) : null}
        {extractFailed !== null ? (
          <p role="alert" className={css({ margin: '0', color: 'error-text', overflowWrap: 'anywhere' })}>
            {extractFailed}
          </p>
        ) : null}
        <Field label={t('image.assets.columnName')}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('image.assets.namePlaceholder')}
            dir="auto"
          />
        </Field>
        <Field label={t('image.assets.descriptionLabel')}>
          <MarkdownInput
            value={description}
            onChange={setDescription}
            minHeight="96px"
            placeholder={t('image.assets.descriptionPlaceholder')}
          />
        </Field>
        <Field label={t('image.assets.columnCategory')}>
          <Input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder={t('image.assets.categoryPlaceholder')}
            dir="auto"
          />
        </Field>
        <Field label={t('image.assets.columnKeywords')} help={t('image.assets.keywordsHelp')}>
          <Input
            value={keywords}
            onChange={(event) => setKeywords(event.target.value)}
            placeholder={t('image.assets.keywordsPlaceholder')}
            dir="auto"
          />
        </Field>
        <SettingRow label={t('image.assets.agentVisible')} description={t('image.assets.agentVisibleHint')}>
          {({ id, describedBy }) => (
            <Switch id={id} aria-describedby={describedBy} checked={agentVisible} onCheckedChange={setAgentVisible} />
          )}
        </SettingRow>
      </div>
    </Dialog>
  );
}

/** Rebuilds the one-off override the picker selected; undefined keeps the tool model. */
function oneOffOverride(
  modelChoice: string,
  thinkingChoice: string,
  blockedModels: readonly ExtractionModelOption[] | null,
): { provider: string; model: string; thinking_level: string } | undefined {
  if (blockedModels === null || modelChoice === '' || thinkingChoice === '') {
    return undefined;
  }
  const found = blockedModels.find((option) => `${option.provider}/${option.model}` === modelChoice);
  if (found === undefined) {
    return undefined;
  }
  return { provider: found.provider, model: found.model, thinking_level: thinkingChoice };
}
