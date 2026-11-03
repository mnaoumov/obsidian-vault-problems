import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { noopAsync } from '@mnaoumov/typescript-lib/function';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { LinkProblem } from './link-model.ts';

import { EditorProblems } from './editor-problems.ts';

const problem: LinkProblem = {
  cause: null,
  message: 'Missing target',
  row: { id: 'one', key: null, kind: 'link', link: 'Missing', position: { end: { col: 11, line: 0, offset: 11 }, start: { col: 0, line: 0, offset: 0 } }, sourcePath: 'Note.md', target: null, targetPath: null },
  status: 'standing'
};

describe('EditorProblems', () => {
  it('projects engine ranges, clears stale marks during edits, refreshes and unsubscribes', async () => {
    let refresh: (path?: string) => void = vi.fn();
    let problems: readonly LinkProblem[] = [problem];
    const unsubscribe = vi.fn();
    const diagnostics = new EditorProblems({
      getPath: (): string => 'Note.md',
      getProblems: (): readonly LinkProblem[] => problems,
      showFixes: vi.fn(),
      subscribe: (listener): () => void => {
        refresh = listener;
        return unsubscribe;
      }
    });
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: '[[Missing]]', extensions: diagnostics.extension }) });
    expect(view.dom.querySelector('.vault-problems-underline')?.textContent).toBe('[[Missing]]');
    expect(diagnostics.getProblemAtCursor(view)).toBe(problem);
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(view.dom.querySelector('.vault-problems-underline')).toBeNull();
    expect(diagnostics.getProblemAtCursor(view)).toBeUndefined();
    problems = [];
    refresh();
    await noopAsync();
    expect(view.dom.querySelector('.vault-problems-underline')).toBeNull();
    problems = [problem];
    refresh();
    await noopAsync();
    expect(view.dom.querySelector('.vault-problems-underline')).not.toBeNull();
    view.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
    refresh();
    await noopAsync();
  });

  it('omits missing, invalid and other-note ranges and follows editor file changes', () => {
    let path = 'Other.md';
    const diagnostics = new EditorProblems({
      getPath: (): string => path,
      getProblems: (): readonly LinkProblem[] => [problem, { ...problem, row: { ...problem.row, position: null } }, { ...problem, row: { ...problem.row, position: { end: { col: 0, line: 0, offset: 110 }, start: { col: 0, line: 0, offset: 100 } } } }],
      showFixes: vi.fn(),
      subscribe: (): () => void => vi.fn()
    });
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: '[[Missing]]', extensions: diagnostics.extension }) });
    expect(view.dom.querySelector('.vault-problems-underline')).toBeNull();
    path = 'Note.md';
    view.dispatch({});
    expect(view.dom.querySelectorAll('.vault-problems-underline')).toHaveLength(1);
    view.dispatch({ selection: { anchor: 11 } });
    expect(diagnostics.getProblemAtCursor(view)).toBeUndefined();
    view.destroy();
  });
});
