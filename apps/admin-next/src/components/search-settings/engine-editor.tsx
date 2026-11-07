import { Select } from '@tuuject/koi-react/select';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { SearchProviderView } from '@/lib/api/search.ts';
import { canKeepKey, type EngineDraft, type KeyMode, renameEngine, switchProvider } from './draft.ts';

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
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-3">
        <Label htmlFor={`${idPrefix}-enabled`} className="text-muted-foreground text-xs">
          {t('search.engineEnabled')}
        </Label>
        <Switch
          id={`${idPrefix}-enabled`}
          checked={draft.enabled}
          onCheckedChange={(next) => onChange({ enabled: next })}
          disabled={disabled}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-id`}>{t('search.fieldId')}</Label>
          <Input
            id={`${idPrefix}-id`}
            value={draft.id}
            onChange={(event) => onChange(renameEngine(draft, event.target.value))}
            placeholder="tavily-main"
            disabled={disabled}
          />
          <p className="text-muted-foreground text-xs">{t('search.fieldIdHint')}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-provider`}>{t('search.fieldProvider')}</Label>
          <Select
            id={`${idPrefix}-provider`}
            className="w-full"
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
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-endpoint`}>{t('search.fieldEndpoint')}</Label>
          <Input
            id={`${idPrefix}-endpoint`}
            value={draft.endpoint}
            onChange={(event) => onChange({ endpoint: event.target.value })}
            placeholder={provider?.default_endpoint ?? t('search.endpointRequired')}
            disabled={disabled}
          />
          <p className="text-muted-foreground text-xs">
            {provider?.default_endpoint === null ? t('search.endpointRequiredHint') : t('search.endpointHint')}
          </p>
        </div>
        <div className="space-y-1">
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
          <p className="text-muted-foreground text-xs">
            {provider?.supports_count === false ? t('search.resultsUnsupported') : t('search.resultsHint')}
          </p>
        </div>
        <div className="space-y-1">
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
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-note`}>{t('search.fieldNote')}</Label>
          <Textarea
            id={`${idPrefix}-note`}
            rows={2}
            value={draft.note}
            onChange={(event) => onChange({ note: event.target.value })}
            placeholder={t('search.notePlaceholder')}
            disabled={disabled}
          />
          <p className="text-muted-foreground text-xs">{t('search.noteHint')}</p>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={showKeyModeChoice ? `${idPrefix}-key-mode` : `${idPrefix}-key`}>{t('search.fieldKey')}</Label>
          {showKeyModeChoice ? (
            <Select
              id={`${idPrefix}-key-mode`}
              className="w-full sm:w-72"
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
              className="w-full sm:w-72"
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
          <p className="text-muted-foreground text-xs">
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
