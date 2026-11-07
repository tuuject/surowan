import { Select } from '@tuuject/koi-react/select';
import { useTranslation } from 'react-i18next';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@tuuject/koi-react/switch';
import { Textarea } from '@tuuject/koi-react/textarea';
import type { SearchProviderView } from '@/lib/api/search.ts';
import { canKeepKey, type EngineDraft, type KeyMode, renameEngine, switchProvider } from './draft.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

/**
 * One engine's fields. The key control is a source choice rather than a value:
 * the page never receives a configured key, only whether one exists.
 */
export function EngineEditor({
  draft,
  providers,
  provider,
  deepseekKeys,
  disabled,
  onChange,
}: {
  readonly draft: EngineDraft;
  readonly providers: readonly SearchProviderView[];
  readonly provider: SearchProviderView | undefined;
  readonly deepseekKeys: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (change: Partial<EngineDraft>) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const idPrefix = `search-engine-${draft.key}`;
  const canReuseModelKey = provider?.id === 'deepseek' && deepseekKeys.length > 0;
  const keyModes: KeyMode[] = [
    ...(canKeepKey(draft) ? (['keep'] as const) : []),
    'new',
    ...(canReuseModelKey ? (['alias'] as const) : []),
  ];
  const keyMode: KeyMode = keyModes.includes(draft.keyMode) ? draft.keyMode : (keyModes[0] ?? 'new');
  // Only "new" available means no choice to make: show the paste field alone.
  const showKeyModeChoice = keyModes.length > 1;
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '3' })}>
        <Label htmlFor={`${idPrefix}-enabled`} className={css({ textStyle: 'small', color: 'text-muted' })}>
          {t('search.engineEnabled')}
        </Label>
        <Switch
          id={`${idPrefix}-enabled`}
          checked={draft.enabled}
          onCheckedChange={(next) => onChange({ enabled: next })}
          disabled={disabled}
        />
      </div>
      <div className={css({ display: 'grid', gap: '3', md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } })}>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <Label htmlFor={`${idPrefix}-id`}>{t('search.fieldId')}</Label>
          <Input
            id={`${idPrefix}-id`}
            value={draft.id}
            onChange={(event) => onChange(renameEngine(draft, event.target.value))}
            placeholder="tavily-main"
            disabled={disabled}
          />
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('search.fieldIdHint')}</p>
        </div>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <Label htmlFor={`${idPrefix}-provider`}>{t('search.fieldProvider')}</Label>
          <Select
            id={`${idPrefix}-provider`}
            className={css({ width: '100%' })}
            value={draft.provider}
            onChange={(event) => {
              const next = providers.find((entry) => entry.id === event.target.value);
              if (next !== undefined && next.id !== draft.provider) {
                onChange(switchProvider(next));
              }
            }}
            disabled={disabled}
          >
            {providers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
        </div>
        <div
          className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' }, md: { gridColumn: 'span 2 / span 2' } })}
        >
          <Label htmlFor={`${idPrefix}-endpoint`}>{t('search.fieldEndpoint')}</Label>
          <Input
            id={`${idPrefix}-endpoint`}
            value={draft.endpoint}
            onChange={(event) => onChange({ endpoint: event.target.value })}
            placeholder={provider?.default_endpoint ?? t('search.endpointRequired')}
            disabled={disabled}
          />
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>
            {provider?.default_endpoint === null ? t('search.endpointRequiredHint') : t('search.endpointHint')}
          </p>
        </div>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <Label htmlFor={`${idPrefix}-results`}>{t('search.fieldResults')}</Label>
          <Input
            id={`${idPrefix}-results`}
            type="number"
            min={1}
            max={10}
            value={draft.results}
            onChange={(event) => onChange({ results: event.target.value })}
            disabled={disabled || provider?.supports_count === false}
          />
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>
            {provider?.supports_count === false ? t('search.resultsUnsupported') : t('search.resultsHint')}
          </p>
        </div>
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <Label htmlFor={`${idPrefix}-timeout`}>{t('search.fieldTimeout')}</Label>
          <Input
            id={`${idPrefix}-timeout`}
            type="number"
            min={5}
            max={30}
            value={draft.timeout}
            onChange={(event) => onChange({ timeout: event.target.value })}
            disabled={disabled}
          />
        </div>
        <div
          className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' }, md: { gridColumn: 'span 2 / span 2' } })}
        >
          <Label htmlFor={`${idPrefix}-note`}>{t('search.fieldNote')}</Label>
          <Textarea
            id={`${idPrefix}-note`}
            rows={2}
            value={draft.note}
            onChange={(event) => onChange({ note: event.target.value })}
            placeholder={t('search.notePlaceholder')}
            disabled={disabled}
          />
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('search.noteHint')}</p>
        </div>
        <div
          className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' }, md: { gridColumn: 'span 2 / span 2' } })}
        >
          <Label htmlFor={showKeyModeChoice ? `${idPrefix}-key-mode` : `${idPrefix}-key`}>{t('search.fieldKey')}</Label>
          {showKeyModeChoice ? (
            <Select
              id={`${idPrefix}-key-mode`}
              className={css({ width: '100%', md: { width: '288px' } })}
              value={keyMode}
              onChange={(event) => {
                // Entering alias mode stores the alias the picker shows, so a
                // single available alias needs no extra pick before saving.
                const value = event.target.value;
                onChange(
                  value === 'alias' && draft.keyAlias === ''
                    ? { keyMode: 'alias', keyAlias: deepseekKeys[0] ?? '' }
                    : { keyMode: value as KeyMode },
                );
              }}
              disabled={disabled}
            >
              {keyModes.includes('keep') ? <option value="keep">{t('search.keyKeep')}</option> : null}
              {keyModes.includes('new') ? <option value="new">{t('search.keyNew')}</option> : null}
              {keyModes.includes('alias') ? <option value="alias">{t('search.keyReuse')}</option> : null}
            </Select>
          ) : null}
          {keyMode === 'new' ? (
            <Input
              id={`${idPrefix}-key`}
              type="password"
              autoComplete="off"
              aria-label={t('search.keyNew')}
              value={draft.apiKey}
              onChange={(event) => onChange({ apiKey: event.target.value })}
              placeholder={t('search.keyPlaceholder')}
              disabled={disabled}
            />
          ) : null}
          {keyMode === 'alias' ? (
            <Select
              className={css({ width: '100%', md: { width: '288px' } })}
              value={draft.keyAlias}
              onChange={(event) => onChange({ keyAlias: event.target.value })}
              disabled={disabled}
            >
              {deepseekKeys.map((alias) => (
                <option key={alias} value={alias}>
                  {alias}
                </option>
              ))}
            </Select>
          ) : null}
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>
            {provider?.key === 'forbidden'
              ? t('search.keyForbidden')
              : provider?.key === 'optional'
                ? t('search.keyOptional')
                : t('search.keyRequired')}
          </p>
        </div>
      </div>
    </div>
  );
}
