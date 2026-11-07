import { Radio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { radioGroup } from '@tuuject/koi-react/styled-system/recipes';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The two Chat dialogs compose a card around each radio, so they need the
 * RadioGroup/RadioGroupItem split rather than Koi's option-list API. Behaviour
 * is Base UI's radio group (the same primitive Koi uses) and the visual parts
 * come from Koi's radio-group recipe.
 */
function RadioGroup<T extends string>({
  className,
  children,
  value,
  defaultValue,
  onValueChange,
  disabled,
  name,
}: {
  readonly className?: string;
  readonly children: ReactNode;
  readonly value?: T;
  readonly defaultValue?: T;
  readonly onValueChange?: (value: T) => void;
  readonly disabled?: boolean;
  readonly name?: string;
}): React.ReactElement {
  return (
    <BaseRadioGroup
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        if (typeof next === 'string') {
          onValueChange?.(next as T);
        }
      }}
      disabled={disabled}
      name={name}
      className={cn(radioGroup().root, className)}
    >
      {children}
    </BaseRadioGroup>
  );
}

function RadioGroupItem({
  value,
  className,
  id,
}: {
  readonly value: string;
  readonly className?: string;
  readonly id?: string;
}): React.ReactElement {
  const recipe = radioGroup();
  return (
    <Radio.Root value={value} id={id} className={cn(recipe.control, 'shrink-0', className)}>
      <Radio.Indicator keepMounted className={recipe.indicator} />
    </Radio.Root>
  );
}

export { RadioGroup, RadioGroupItem };
