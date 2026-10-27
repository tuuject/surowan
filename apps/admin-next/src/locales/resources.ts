import { brand } from './en/brand.ts';
import { common } from './en/common.ts';
import { dictionary } from './en/dictionary.ts';
import { harness } from './en/harness.ts';
import { image } from './en/image.ts';
import { invocations } from './en/invocations.ts';
import { layout } from './en/layout.ts';
import { models } from './en/models.ts';
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
import { models as modelsZh } from './zh-CN/models.ts';
import { pages as pagesZh } from './zh-CN/pages.ts';
import { playgroundZh } from './zh-CN/playground.ts';
import { search as searchZh } from './zh-CN/search.ts';

/**
 * English is the source catalog; every other locale must mirror its key
 * structure (enforced by the `typeof` annotations in each `zh-CN` file).
 * Areas are NESTED, not spread: keys are addressed as `t('area.group.name')`.
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

export { en, zhCN };

export const resources = {
  en: { translation: en },
  'zh-CN': { translation: zhCN },
};
