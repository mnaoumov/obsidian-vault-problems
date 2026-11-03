import type {
  Tooltip,
  TooltipView
} from '@codemirror/view';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { LinkProblem } from './link-model.ts';

import { EditorProblems } from './editor-problems.ts';

interface HoverCapture {
  readonly hover: ((view: EditorView, pos: number) => null | Tooltip)[];
}

const captured = vi.hoisted((): HoverCapture => ({ hover: [] }));
vi.mock('@codemirror/view', async (importOriginal) => {
  const original = await importOriginal<typeof import('@codemirror/view')>();
  return {
    ...original,
    hoverTooltip: (source: (view: EditorView, pos: number) => null | Tooltip): ReturnType<typeof original.hoverTooltip> => {
      captured.hover.push(source);
      return original.hoverTooltip(source);
    }
  };
});

describe('Diagnostic hover', () => {
  it('shows diagnostic text and invokes fixes only while its range remains current', () => {
    const problem: LinkProblem = { cause: null, message: 'Missing note', row: { id: 'one', key: null, kind: 'link', link: 'Missing', position: { end: { col: 11, line: 0, offset: 11 }, start: { col: 0, line: 0, offset: 0 } }, sourcePath: 'Note.md', target: null, targetPath: null }, status: 'standing' };
    const showFixes = vi.fn();
    const diagnostics = new EditorProblems({ getPath: (): string => 'Note.md', getProblems: (): readonly LinkProblem[] => [problem], showFixes, subscribe: (): () => void => vi.fn() });
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: '[[Missing]] rest', extensions: diagnostics.extension }) });
    const hover = ensureNonNullable(captured.hover.at(-1));
    expect(hover(view, 12)).toBeNull();
    const tooltip = ensureNonNullable(hover(view, 1));
    const content: TooltipView = tooltip.create(view);
    expect(content.dom.textContent).toContain('Missing note');
    const button = ensureNonNullable(content.dom.querySelector('button'));
    button.click();
    expect(showFixes).toHaveBeenCalledWith(problem, view);
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    button.click();
    expect(showFixes).toHaveBeenCalledOnce();
    view.destroy();
  });

  it('ignores unrelated engine updates and queued snapshots overtaken by edits', async () => {
    let refresh: (path?: string) => void = vi.fn();
    let path = '';
    const diagnostics = new EditorProblems({
      getPath: (): string | undefined => path || undefined,
      getProblems: (): readonly LinkProblem[] => [],
      showFixes: vi.fn(),
      subscribe: (listener): () => void => {
        refresh = listener;
        return vi.fn();
      }
    });
    const view = new EditorView({ parent: document.body, state: EditorState.create({ extensions: diagnostics.extension }) });
    expect(diagnostics.getProblemAtCursor(view)).toBeUndefined();
    path = 'Note.md';
    view.dispatch({});
    const dispatch = vi.spyOn(view, 'dispatch');
    refresh('Other.md');
    await noopAsync();
    expect(dispatch).not.toHaveBeenCalled();
    refresh('Note.md');
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    await noopAsync();
    expect(dispatch).toHaveBeenCalledOnce();
    view.destroy();
    const bare = new EditorView({ parent: document.body });
    expect(diagnostics.getProblemAtCursor(bare)).toBeUndefined();
    bare.destroy();
  });
});
