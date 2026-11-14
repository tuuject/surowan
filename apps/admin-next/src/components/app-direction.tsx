import { DirectionProvider } from '@tuuject/koi-react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLanguage, directionFor, type TextDirection } from '@/lib/i18n';

/**
 * The active writing direction. Derived from `i18n.language` through
 * react-i18next, so it re-renders exactly when the language changes — no
 * effect, no local state.
 */
export function useTextDirection(): TextDirection {
  const { i18n } = useTranslation();
  return directionFor(currentLanguage(i18n.language));
}

/**
 * Koi's direction context: floating panel placement, keyboard behaviour and the
 * `dir` Koi writes on its own portalled panels all read it. It renders no
 * element — CSS direction comes from `<html dir>` (and `lang`), which i18n keeps
 * in sync, so the two never disagree. Mounted once in `main.tsx`.
 */
export function AppDirectionProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const direction = useTextDirection();
  return <DirectionProvider direction={direction}>{children}</DirectionProvider>;
}
