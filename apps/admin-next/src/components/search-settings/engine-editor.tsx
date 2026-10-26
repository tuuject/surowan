import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { SearchProviderView } from '@/lib/api/search.ts';
import type { EngineDraft, KeyMode } from './draft.ts';

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
  onRemove,
  index,
}: {
  readonly draft: EngineDraft;
  readonly providers: readonly SearchProviderView[];
  readonly provider: SearchProviderView | undefined;
  readonly deepseekKeys: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (change: Partial<EngineDraft>) => void;
  readonly onRemove: () => void;
  readonly index: number;
}): React.ReactElement {
  const { t } = useTranslation();
  const idPrefix = `search-engine-${draft.key}`;
  const canReuseModelKey = provider?.id === 'deepseek' && deepseekKeys.length > 0;
  const keyModes: KeyMode[] = [
    ...(draft.keyConfigured ? (['keep'] as const) : []),
    'new',
    ...(canReuseModelKey ? (['alias'] as const) : []),
  ];
  const keyMode: KeyMode = keyModes.includes(draft.keyMode) ? draft.keyMode : (keyModes[0] ?? 'new');
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{t('search.engineHeading', { index: index + 1 })}</p>
        <div className="flex items-center gap-3">
          <Label htmlFor={`${idPrefix}-enabled`} className="text-muted-foreground text-xs">
            {t('search.engineEnabled')}
          </Label>
          <Switch
            id={`${idPrefix}-enabled`}
            checked={draft.enabled}
            onCheckedChange={(next) => onChange({ enabled: next })}
            disabled={disabled}
          />
          <Button type="button" variant="ghost" size="sm" onClick={onRemove} disabled={disabled}>
            <Trash2 aria-hidden /> {t('search.removeEngine')}
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-id`}>{t('search.fieldId')}</Label>
          <Input
            id={`${idPrefix}-id`}
            value={draft.id}
            onChange={(event) => onChange({ id: event.target.value })}
            placeholder="tavily-main"
            disabled={disabled}
          />
          <p className="text-muted-foreground text-xs">{t('search.fieldIdHint')}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-provider`}>{t('search.fieldProvider')}</Label>
          <Select value={draft.provider} onValueChange={(value) => onChange({ provider: value })} disabled={disabled}>
            <SelectTrigger id={`${idPrefix}-provider`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
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
          <Label htmlFor={`${idPrefix}-key-mode`}>{t('search.fieldKey')}</Label>
          <Select
            value={keyMode}
            onValueChange={(value) => onChange({ keyMode: value as KeyMode })}
            disabled={disabled || keyModes.length === 0}
          >
            <SelectTrigger id={`${idPrefix}-key-mode`} className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {keyModes.includes('keep') ? <SelectItem value="keep">{t('search.keyKeep')}</SelectItem> : null}
              {keyModes.includes('new') ? <SelectItem value="new">{t('search.keyNew')}</SelectItem> : null}
              {keyModes.includes('alias') ? <SelectItem value="alias">{t('search.keyReuse')}</SelectItem> : null}
            </SelectContent>
          </Select>
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
              value={draft.keyAlias === '' ? (deepseekKeys[0] ?? '') : draft.keyAlias}
              onValueChange={(value) => onChange({ keyAlias: value })}
              disabled={disabled}
            >
              <SelectTrigger className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {deepseekKeys.map((alias) => (
                  <SelectItem key={alias} value={alias}>
                    {alias}
                  </SelectItem>
                ))}
              </SelectContent>
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
