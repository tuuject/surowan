import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { IconButton } from '@tuuject/koi-react/button';
import { dialog as dialogRecipe } from '@tuuject/koi-react/styled-system/recipes';
import { X } from 'lucide-react';
import { Children, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * Koi-styled dialog under the pre-Koi composition API. Base UI supplies the
 * modal behaviour Koi's Dialog wraps (portal, focus trap, Esc, outside click,
 * scroll lock, focus return); every visual slot comes from Koi's dialog
 * recipe. The pages keep their header/body/footer structure, including forms
 * whose submit button lives inside DialogFooter.
 */
interface DialogRootProps {
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}

function Dialog({ open, defaultOpen, onOpenChange, children }: DialogRootProps): ReactElement {
  return (
    <BaseDialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {children}
    </BaseDialog.Root>
  );
}

function DialogTrigger({
  asChild = false,
  children,
  ...props
}: {
  readonly asChild?: boolean;
  readonly children: ReactElement;
} & Omit<ComponentProps<typeof BaseDialog.Trigger>, 'render' | 'children'>): ReactElement {
  // Without asChild the trigger is its own button, so `aria-label` and the
  // click target live on the button (the tool image uses this shape). With
  // asChild the caller's element becomes the trigger.
  return asChild ? (
    <BaseDialog.Trigger {...props} render={children} />
  ) : (
    <BaseDialog.Trigger {...props}>{children}</BaseDialog.Trigger>
  );
}

function DialogPortal({ children }: { readonly children: ReactNode }): ReactElement {
  return <BaseDialog.Portal>{children}</BaseDialog.Portal>;
}

function DialogOverlay({ className }: { readonly className?: string }): ReactElement {
  return <BaseDialog.Backdrop className={cn(dialogRecipe().backdrop, className)} />;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: {
  readonly className?: string;
  readonly children: ReactNode;
  readonly showCloseButton?: boolean;
  readonly 'aria-describedby'?: string | undefined;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className={dialogRecipe().backdrop} />
      <BaseDialog.Viewport className={dialogRecipe().viewport}>
        <BaseDialog.Popup data-slot="dialog-content" className={cn(dialogRecipe().popup, className)} {...props}>
          {children}
          {showCloseButton ? (
            <BaseDialog.Close
              className={dialogRecipe().close}
              render={
                <IconButton
                  label={t('layout.koi.close')}
                  icon={<X size={18} />}
                  size="sm"
                  variant="ghost"
                  color="secondary"
                />
              }
            />
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return <div className={cn('flex flex-col gap-2 pe-8', className)} {...props} />;
}

function DialogFooter({ className, children, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div className={cn('mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props}>
      {children}
    </div>
  );
}

function DialogTitle({ className, ...props }: ComponentProps<'h2'>): ReactElement {
  return <BaseDialog.Title className={cn(dialogRecipe().title, className)} {...props} />;
}

function DialogDescription({ className, ...props }: ComponentProps<'p'>): ReactElement {
  return <BaseDialog.Description className={cn(dialogRecipe().description, className)} {...props} />;
}

function DialogClose({
  asChild: _asChild,
  children,
  ...props
}: {
  readonly asChild?: boolean;
  readonly children: ReactElement;
} & Omit<ComponentProps<typeof BaseDialog.Close>, 'render' | 'children'>): ReactElement {
  return <BaseDialog.Close {...props} render={Children.only(children)} />;
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
