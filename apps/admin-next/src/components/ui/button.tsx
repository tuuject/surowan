import { IconButton, Button as KoiButton } from '@tuuject/koi-react/button';
import { button as buttonRecipe } from '@tuuject/koi-react/styled-system/recipes';
import { Children, cloneElement, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Compatibility surface for the pre-Koi call sites: the old variant and size
 * names resolve to Koi's semantic colours and control heights, so every page
 * inherits Koi's focus ring, ripple, disabled state and typography without
 * rewriting each button. `asChild` keeps the old slot behaviour for links and
 * labels by cloning the single child with Koi's button recipe classes.
 */
export type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
export type ButtonSize = 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';

interface LegacyButtonProps extends Omit<React.ComponentProps<'button'>, 'color'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly asChild?: boolean;
}

const SIZE_MAP: Record<'default' | 'xs' | 'sm' | 'lg', 'md' | 'sm' | 'lg'> = {
  default: 'md',
  xs: 'sm',
  sm: 'sm',
  lg: 'lg',
};

const ICON_SIZE_MAP: Record<'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg', 'sm' | 'md'> = {
  icon: 'sm',
  'icon-xs': 'sm',
  'icon-sm': 'sm',
  'icon-lg': 'md',
};

function iconEvidence(children: ReactNode): ReactNode {
  const only = Children.toArray(children)[0];
  return only ?? null;
}

function buttonLook(variant: ButtonVariant) {
  if (variant === 'destructive') {
    return { color: 'error' as const, variant: 'solid' as const };
  }
  switch (variant) {
    case 'outline':
      return { color: 'secondary' as const, variant: 'outline' as const };
    case 'secondary':
      return { color: 'secondary' as const, variant: 'soft' as const };
    case 'ghost':
    case 'link':
      return { color: 'secondary' as const, variant: 'ghost' as const };
    default:
      return { color: 'primary' as const, variant: 'solid' as const };
  }
}

export function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  children,
  ...props
}: LegacyButtonProps & { readonly children?: ReactNode }): ReactElement {
  const look = buttonLook(variant);
  const iconOnly = size.startsWith('icon');
  const koiSize = iconOnly
    ? ICON_SIZE_MAP[size as keyof typeof ICON_SIZE_MAP]
    : SIZE_MAP[size as keyof typeof SIZE_MAP];

  if (iconOnly) {
    const label =
      (props['aria-label'] as string | undefined) ??
      (typeof props.title === 'string' ? props.title : undefined) ??
      (typeof children === 'string' ? children : '');
    return (
      <IconButton
        {...(props as unknown as React.ComponentProps<typeof IconButton>)}
        label={label}
        icon={iconEvidence(children)}
        color={look.color}
        variant={look.variant}
        size={koiSize}
        {...(className === undefined ? {} : { className })}
      />
    );
  }

  if (asChild) {
    const child = Children.only(children) as ReactElement<{ className?: string }>;
    const recipeClass = buttonRecipe({
      color: look.color,
      variant: look.variant,
      size: koiSize,
      shape: 'rounded',
    });
    return cloneElement(child, {
      ...props,
      className: cn(recipeClass, className, child.props.className),
    });
  }

  return (
    <KoiButton
      {...(props as unknown as React.ComponentProps<typeof KoiButton>)}
      color={look.color}
      variant={look.variant}
      size={koiSize}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </KoiButton>
  );
}

export { buttonRecipe as buttonVariants };
