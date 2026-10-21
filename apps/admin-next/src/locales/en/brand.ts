/**
 * Product identity for the admin UI. A rebrand should only need to change this
 * catalog and its `zh-CN` mirror; keep brand-bearing copy here instead of
 * scattering it through the feature catalogs. The WebAuthn `rpName` is the one
 * non-localized touchpoint and lives with the server
 * (`src/ingress/admin/passkeys.ts`).
 */
export const brand = {
  name: 'Surowan',
  adminTitle: 'Surowan Admin',
  loginTitle: 'Surowan admin sign-in',
};
