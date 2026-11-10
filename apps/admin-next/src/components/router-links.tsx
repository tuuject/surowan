import { createLink } from '@tanstack/react-router';
import { Button, type ButtonProps } from '@tuuject/koi-react/button';
import { Link, type LinkProps } from '@tuuject/koi-react/link';
import type { ReactElement } from 'react';

/**
 * Koi's link and button looks, wired to TanStack Router: typed `to` / `params` /
 * `search`, client-side navigation, and a real `<a href>` so modified clicks
 * still open a new tab.
 */
export const AppLink = createLink((props: LinkProps): ReactElement => <Link {...props} />);

/** A navigation that reads as an action ("Open settings", "New generation"). */
export const ButtonLink = createLink(
  (props: Omit<Extract<ButtonProps, { href: string }>, 'href'> & { href?: string }): ReactElement => (
    <Button {...(props as Extract<ButtonProps, { href: string }>)} />
  ),
);
