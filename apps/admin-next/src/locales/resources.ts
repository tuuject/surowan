import { brand } from './en/brand.ts';
import { common } from './en/common.ts';
import { dictionary } from './en/dictionary.ts';
import { harness } from './en/harness.ts';
import { image } from './en/image.ts';
import { invocations } from './en/invocations.ts';
import { layout } from './en/layout.ts';
import { models } from './en/models/index.ts';
import { pages } from './en/pages.ts';
import { playground } from './en/playground.ts';
import { search } from './en/search.ts';

import { brand as brandZh } from './zh-CN/brand.ts';
import { common as commonZh } from './zh-CN/common.ts';
import { dictionary as dictionaryZh } from './zh-CN/dictionary.ts';
import { harness as harnessZh } from './zh-CN/harness.ts';
import { image as imageZh } from './zh-CN/image.ts';
import { invocations as invocationsZh } from './zh-CN/invocations.ts';
import { layout as layoutZh } from './zh-CN/layout.ts';
import { models as modelsZh } from './zh-CN/models/index.ts';
import { pages as pagesZh } from './zh-CN/pages.ts';
import { playgroundZh } from './zh-CN/playground.ts';
import { search as searchZh } from './zh-CN/search.ts';

import { brand as brandDe } from './de-DE/brand.ts';
import { common as commonDe } from './de-DE/common.ts';
import { dictionary as dictionaryDe } from './de-DE/dictionary.ts';
import { harness as harnessDe } from './de-DE/harness.ts';
import { image as imageDe } from './de-DE/image.ts';
import { invocations as invocationsDe } from './de-DE/invocations.ts';
import { layout as layoutDe } from './de-DE/layout.ts';
import { models as modelsDe } from './de-DE/models/index.ts';
import { pages as pagesDe } from './de-DE/pages.ts';
import { playground as playgroundDe } from './de-DE/playground.ts';
import { search as searchDe } from './de-DE/search.ts';

import { brand as brandAr } from './ar/brand.ts';
import { common as commonAr } from './ar/common.ts';
import { dictionary as dictionaryAr } from './ar/dictionary.ts';
import { harness as harnessAr } from './ar/harness.ts';
import { image as imageAr } from './ar/image.ts';
import { invocations as invocationsAr } from './ar/invocations.ts';
import { layout as layoutAr } from './ar/layout.ts';
import { models as modelsAr } from './ar/models/index.ts';
import { pages as pagesAr } from './ar/pages.ts';
import { playground as playgroundAr } from './ar/playground.ts';
import { search as searchAr } from './ar/search.ts';

/**
 * English is the source catalog: every other locale must mirror its key
 * structure (enforced by the `Catalog`/`CompleteCatalog` annotations in each
 * translated file, see `./catalog.ts`). Areas are NESTED, not spread: keys are
 * addressed as `t('area.group.name')`.
 */
const en = {
  common,
  brand,
  layout,
  invocations,
  models,
  pages,
  image,
  dictionary,
  harness,
  playground,
  search,
};

const zhCN: typeof en = {
  common: commonZh,
  brand: brandZh,
  layout: layoutZh,
  invocations: invocationsZh,
  models: modelsZh,
  pages: pagesZh,
  image: imageZh,
  dictionary: dictionaryZh,
  harness: harnessZh,
  playground: playgroundZh,
  search: searchZh,
};

const deDE: typeof en = {
  common: commonDe,
  brand: brandDe,
  layout: layoutDe,
  invocations: invocationsDe,
  models: modelsDe,
  pages: pagesDe,
  image: imageDe,
  dictionary: dictionaryDe,
  harness: harnessDe,
  playground: playgroundDe,
  search: searchDe,
};

/**
 * Arabic adds the CLDR plural categories German and Chinese don't use, so the
 * assembled catalog is widened: the extra `_zero`/`_two`/`_few`/`_many` keys
 * are part of it (each Arabic file's `CompleteCatalog` annotation requires
 * them), while the shape of every English key still comes from `en`.
 */
const ar: typeof en = {
  common: commonAr,
  brand: brandAr,
  layout: layoutAr,
  invocations: invocationsAr,
  models: modelsAr,
  pages: pagesAr,
  image: imageAr,
  dictionary: dictionaryAr,
  harness: harnessAr,
  playground: playgroundAr,
  search: searchAr,
};

export { ar, deDE, en, zhCN };

export const resources = {
  en: { translation: en },
  'zh-CN': { translation: zhCN },
  'de-DE': { translation: deDE },
  ar: { translation: ar },
};
