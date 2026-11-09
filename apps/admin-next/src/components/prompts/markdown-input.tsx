import { Field as BaseField } from '@base-ui/react/field';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { css } from '@tuuject/koi-react/styled-system/css';
import CodeMirror from '@uiw/react-codemirror';
import { type ComponentProps, type Ref, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useTheme } from '@/components/themes/theme-provider';

type MarkdownInputProps = Pick<
  ComponentProps<typeof BaseField.Control>,
  'id' | 'disabled' | 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid'
> & {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly minHeight?: string;
};

const markdownExtensions = [markdown(), EditorView.lineWrapping];
const basicSetup = {
  autocompletion: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
};

function MarkdownControl({
  ref,
  id,
  value,
  onChange,
  placeholder,
  minHeight = '160px',
  disabled,
  'aria-label': label,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: MarkdownInputProps & { readonly ref?: Ref<HTMLElement | null> | undefined }) {
  const { resolved } = useTheme();
  const [view, setView] = useState<EditorView | null>(null);
  // Field labels and descriptions must target the editable DOM, not its wrapper.
  useImperativeHandle<HTMLElement | null, HTMLElement | null>(ref, () => view?.contentDOM ?? null, [view]);
  useEffect(() => {
    if (view === null || labelledBy === undefined) {
      return;
    }
    // Contenteditable has no native label-click focus behavior.
    const labels = labelledBy.split(/\s+/).map((labelId) => view.dom.ownerDocument.getElementById(labelId));
    const focus = () => view.focus();
    for (const element of labels) {
      element?.addEventListener('click', focus);
    }
    return () => {
      for (const element of labels) {
        element?.removeEventListener('click', focus);
      }
    };
  }, [view, labelledBy]);
  const extensions = useMemo(
    () => [
      ...markdownExtensions,
      EditorView.contentAttributes.of({
        id: id ?? '',
        'aria-label': label ?? '',
        'aria-labelledby': labelledBy ?? '',
        'aria-describedby': describedBy ?? '',
        'aria-invalid': String(invalid ?? false),
        'aria-multiline': 'true',
        spellcheck: 'false',
      }),
    ],
    [id, label, labelledBy, describedBy, invalid],
  );
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      onCreateEditor={setView}
      theme={resolved}
      extensions={extensions}
      basicSetup={basicSetup}
      indentWithTab={false}
      editable={!disabled}
      readOnly={disabled === true}
      placeholder={placeholder ?? ''}
      minHeight={minHeight}
      maxHeight="640px"
      className={css({
        width: '100%',
        minWidth: '0',
        overflow: 'hidden',
        borderWidth: '1px',
        borderColor: 'border',
        borderRadius: 'xl',
        _focusWithin: {
          borderColor: 'focus-ring',
          outline: '2px solid token(colors.focus-ring)',
          outlineOffset: '2px',
        },
        '& .cm-editor': { bg: 'surface', color: 'text' },
        '& .cm-editor.cm-focused': { outline: 'none' },
        '& .cm-scroller': { fontFamily: 'mono', textStyle: 'small' },
        '& .cm-content': { paddingBlock: '3', caretColor: 'text' },
        '& .cm-cursor': { borderLeftColor: 'text' },
        '& .cm-gutters': { bg: 'surface-muted', color: 'text-muted', borderColor: 'border' },
        '& .cm-placeholder': { color: 'text-muted' },
      })}
    />
  );
}

export function MarkdownInput({ value, onChange, placeholder, minHeight, ...props }: MarkdownInputProps) {
  return (
    <BaseField.Control
      {...props}
      value={value}
      render={(controlProps) => (
        <MarkdownControl
          {...controlProps}
          value={value}
          onChange={onChange}
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(minHeight === undefined ? {} : { minHeight })}
        />
      )}
    />
  );
}
