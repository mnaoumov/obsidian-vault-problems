import {
  EditorState,
  Transaction
} from '@codemirror/state';
import {
  describe,
  expect,
  it
} from 'vitest';

import {
  detectHeadingEdit,
  matchCutPaste
} from './auto-repair.ts';

describe('repair evidence', () => {
  it('recognizes an isolated heading text edit and refuses a heading deletion or multiline replacement', () => {
    expect(detectHeadingEdit('# Original\nBody\n', '# Replacement\nBody\n')).toEqual({ newName: 'Replacement', offset: 0, oldName: 'Original' });
    expect(detectHeadingEdit('# Original\nBody\n', '# Replacement\nChanged\n')).toBeNull();
    expect(detectHeadingEdit('# Original\nBody\n', 'Body\n')).toBeNull();
    expect(detectHeadingEdit('# Original\n', '## Original\n')).toBeNull();
  });

  it('requires a real cut deletion followed by an identical paste insertion', () => {
    const state = EditorState.create({ doc: '# Alpha\n\nBody\n' });
    const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: 9 } });
    const paste = EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: '# Alpha\n\n' } });
    expect(matchCutPaste(cut, paste)).toEqual({ from: 0, text: '# Alpha\n\n', to: 0 });
    expect(matchCutPaste(cut, state.update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: 'different' } }))).toBeNull();
    expect(matchCutPaste(state.update({ changes: { from: 0, to: 9 } }), paste)).toBeNull();
  });

  it('supports setext headings and refuses unchanged text, body edits and changes to two headings', () => {
    expect(detectHeadingEdit('Original\n===\n', 'Revised\n===\n')).toEqual({ newName: 'Revised', offset: 0, oldName: 'Original' });
    expect(detectHeadingEdit('Same\n', 'Same\n')).toBeNull();
    expect(detectHeadingEdit('Original\n', 'Revised\n')).toBeNull();
    expect(detectHeadingEdit('# Original\n# Alpha\n', '# Revised\n# Bravo\n')).toBeNull();
    expect(detectHeadingEdit('Body\n\n', 'Body\nChanged\n')).toBeNull();
    expect(detectHeadingEdit('# Alpha ###\n', '# Alpha\n')).toBeNull();
    expect(detectHeadingEdit('# Alpha\n', 'Body\n')).toBeNull();
  });

  it('refuses missing, replacement and multiple clipboard changes', () => {
    const state = EditorState.create({ doc: 'Alpha Bravo' });
    const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: 5 } });
    const paste = state.update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: 'Alpha' } });
    expect(matchCutPaste(cut, state.update({ changes: { from: 0, insert: 'Alpha' } }))).toBeNull();
    expect(matchCutPaste(state.update({ annotations: Transaction.userEvent.of('delete.cut') }), paste)).toBeNull();
    expect(matchCutPaste(cut, state.update({ annotations: Transaction.userEvent.of('input.paste') }))).toBeNull();
    expect(matchCutPaste(state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, insert: 'R', to: 5 } }), paste)).toBeNull();
    expect(matchCutPaste(cut, state.update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: 'Alpha', to: 5 } }))).toBeNull();
    expect(matchCutPaste(state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: [{ from: 0, to: 2 }, { from: 6, to: 8 }] }), paste)).toBeNull();
    expect(matchCutPaste(state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, insert: 'Alpha' } }), paste)).toBeNull();
  });
});
