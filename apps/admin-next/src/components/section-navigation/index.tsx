import { SelectItem, SelectPanel } from '@tuuject/koi-react/select-panel';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactNode, useState, useSyncExternalStore } from 'react';
import { focusRing, HEADER_HEIGHT, HEADER_OFFSET, SAFE_BOTTOM } from '@/components/app-shell/shared';
import { SectionMarks } from './markers';
import { SectionOutline } from './outline';

const WIDE_TOP = `calc(var(${HEADER_OFFSET}, ${HEADER_HEIGHT}) + 24px)`;
const STACKED_TOP = `calc(var(${HEADER_OFFSET}, ${HEADER_HEIGHT}) + 52px + 16px)`;

interface SectionEntry {
  readonly id: string;
  readonly title: string;
  readonly invalid: boolean;
  readonly changed: boolean;
}

export function SectionNavigation({
  sections,
  labels,
  children,
}: {
  readonly sections: readonly SectionEntry[];
  readonly labels: {
    readonly navigation: string;
    readonly jump: string;
    readonly invalid: string;
    readonly changed: string;
  };
  readonly children: ReactNode;
}) {
  const [outline] = useState(() => new SectionOutline());
  const active = useSyncExternalStore(outline.subscribe, outline.getActiveId);
  const items = sections.map((section) => ({ value: section.id, label: section.title }));
  const marks = (id: string) => {
    const section = sections.find((entry) => entry.id === id);
    return <SectionMarks invalid={section?.invalid ?? false} changed={section?.changed ?? false} labels={labels} />;
  };

  return (
    <div
      ref={outline.attach}
      className={css({
        containerType: 'inline-size',
        '& [data-form-section], & [data-form-section] *': {
          scrollMarginTop: STACKED_TOP,
          scrollMarginBottom: `calc(100px + ${SAFE_BOTTOM})`,
        },
        '& [data-form-section] h2': { borderRadius: 'sm', outline: 'none', _focusVisible: focusRing },
      })}
    >
      <div
        className={css({
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          '@container (min-width: 720px)': {
            gridTemplateColumns: '200px minmax(0, 1fr)',
            columnGap: '8',
            '& [data-form-section], & [data-form-section] *': { scrollMarginTop: WIDE_TOP },
          },
        })}
      >
        <nav
          aria-label={labels.navigation}
          className={css({
            display: 'none',
            '@container (min-width: 720px)': {
              display: 'block',
              position: 'sticky',
              top: WIDE_TOP,
              alignSelf: 'start',
              maxHeight: `calc(100dvh - ${WIDE_TOP} - max(24px, ${SAFE_BOTTOM}))`,
              overflowY: 'auto',
            },
          })}
        >
          <ul className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
            {sections.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  aria-current={section.id === active ? 'location' : undefined}
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2',
                    width: '100%',
                    minHeight: 'control-md',
                    paddingInline: '3',
                    borderRadius: 'xl',
                    color: 'nav-item-text',
                    textStyle: 'body',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transitionProperty: 'background-color, color',
                    transitionDuration: 'fast',
                    _hover: { bg: 'nav-item-hover' },
                    _focusVisible: focusRing,
                    '&[aria-current=location]': { bg: 'nav-item-active', color: 'text', fontWeight: 'bold' },
                  })}
                  onClick={() => outline.goToSection(section.id, { focus: true })}
                >
                  <span className={css({ flex: '1', minWidth: '0' })}>{section.title}</span>
                  {marks(section.id)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className={css({ minWidth: '0' })}>
          <div
            className={css({
              position: 'sticky',
              top: `var(${HEADER_OFFSET}, ${HEADER_HEIGHT})`,
              zIndex: 30,
              paddingBlock: '2',
              bg: 'page-bg',
              '@container (min-width: 720px)': { display: 'none' },
            })}
          >
            <SelectPanel
              aria-label={labels.jump}
              items={items}
              value={active}
              onChange={(id) => {
                if (id) {
                  outline.goToSection(id);
                }
              }}
              renderValue={(item) => (
                <span className={css({ display: 'flex', alignItems: 'center', gap: '2' })}>
                  {item.label}
                  {marks(item.value)}
                </span>
              )}
            >
              {(entries) =>
                entries.map((item) => (
                  <SelectItem key={item.value} value={item.value} label={item.label}>
                    <span className={css({ display: 'flex', alignItems: 'center', gap: '2' })}>
                      {item.label}
                      {marks(item.value)}
                    </span>
                  </SelectItem>
                ))
              }
            </SelectPanel>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
