import type { CompleteCatalog } from '../catalog.ts';
import type { brand as brandEn } from '../en/brand.ts';

/** Mirrors `en/brand.ts` key for key. */
export const brand: CompleteCatalog<typeof brandEn> = {
  name: 'Surowan',
  adminTitle: 'Surowan Admin',
  loginTitle: 'تسجيل الدخول إلى لوحة Surowan',
};
