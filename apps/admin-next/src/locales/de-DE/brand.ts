import type { Catalog } from '../catalog.ts';
import type { brand as brandEn } from '../en/brand.ts';

/** Mirrors `en/brand.ts` key for key; the annotation fails the build on drift. */
export const brand: Catalog<typeof brandEn> = {
  name: 'Surowan',
  adminTitle: 'Surowan Admin',
  loginTitle: 'Anmeldung am Surowan-Admin',
};
