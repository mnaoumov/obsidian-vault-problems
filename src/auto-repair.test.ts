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
  isSplitImePasteStart,
  matchCutPaste,
  matchSplitImePaste
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

  it('accepts an input-method commit of the identical text as a paste, but not typing', () => {
    const state = EditorState.create({ doc: '# Alpha\nBody' });
    const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: 7 } });
    const empty = EditorState.create({ doc: '' });
    expect(matchCutPaste(cut, empty.update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 0, insert: '# Alpha' } }))).toEqual({ from: 0, text: '# Alpha', to: 0 });
    // Composition is typing, and so is a single character, even when it equals the cut.
    expect(matchCutPaste(cut, empty.update({ annotations: Transaction.userEvent.of('input.type.compose'), changes: { from: 0, insert: '# Alpha' } }))).toBeNull();
    const oneCharacterCut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: 1 } });
    expect(matchCutPaste(oneCharacterCut, empty.update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 0, insert: '#' } }))).toBeNull();
    expect(matchCutPaste(oneCharacterCut, empty.update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: '#' } }))).toEqual({ from: 0, text: '#', to: 0 });
    expect(matchCutPaste(cut, empty.update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 0, insert: '# Alpha!' } }))).toBeNull();
  });

  it('matches a keyboard clipboard paste that commits the final line break as a separate Enter', () => {
    const text = '# Alpha\n\nA block. ^alpha\n';
    const state = EditorState.create({ doc: `${text}Rest` });
    const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: text.length } });
    const destination = EditorState.create({ doc: 'Intro\n' });
    const first = destination.update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 6, insert: text.slice(0, -1) } });
    const second = first.state.update({ annotations: Transaction.userEvent.of('input'), changes: { from: 6 + text.length - 1, insert: '\n' } });
    expect(matchCutPaste(cut, first)).toBeNull();
    expect(isSplitImePasteStart(cut, first)).toBe(true);
    expect(matchSplitImePaste(cut, first, second)).toEqual({ from: 0, text, to: 6 });
  });

  it('refuses a split input-method paste whose second half is not the missing line break right after the first', () => {
    const text = '# Alpha\n';
    const state = EditorState.create({ doc: text });
    const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: text.length } });
    const first = EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 0, insert: '# Alpha' } });
    function lineBreak(from: number, insert = '\n', userEvent = 'input'): Transaction {
      return first.state.update({ annotations: Transaction.userEvent.of(userEvent), changes: { from, insert } });
    }
    expect(matchSplitImePaste(cut, first, lineBreak(7))).toEqual({ from: 0, text, to: 0 });
    expect(matchSplitImePaste(cut, first, lineBreak(3))).toBeNull();
    expect(matchSplitImePaste(cut, first, lineBreak(7, '\n  '))).toBeNull();
    expect(matchSplitImePaste(cut, first, lineBreak(7, '\n', 'input.paste'))).toBeNull();
    expect(matchSplitImePaste(cut, first, lineBreak(7, '\n', 'select'))).toBeNull();
    expect(matchSplitImePaste(cut, first, first.state.update({ annotations: Transaction.userEvent.of('input'), changes: { from: 6, insert: '\n', to: 7 } }))).toBeNull();
    expect(matchSplitImePaste(cut, first, first.state.update({ annotations: Transaction.userEvent.of('input'), changes: [{ from: 0, insert: 'x' }, { from: 7, insert: '\n' }] }))).toBeNull();
    // The second half must follow the first in the same document.
    expect(matchSplitImePaste(cut, first, EditorState.create({ doc: 'Other' }).update({ annotations: Transaction.userEvent.of('input'), changes: { from: 5, insert: '\n' } }))).toBeNull();
    // A cut without a final line break, or a first half that is a composition, is no split paste.
    const bare = EditorState.create({ doc: '# Alpha' });
    expect(isSplitImePasteStart(bare.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: 7 } }), first)).toBe(false);
    expect(isSplitImePasteStart(cut, EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.type.compose'), changes: { from: 0, insert: '# Alpha' } }))).toBe(false);
    expect(isSplitImePasteStart(state.update({ changes: { from: 0, to: text.length } }), first)).toBe(false);
    expect(isSplitImePasteStart(EditorState.create({ doc: '\n' }).update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: 1 } }), EditorState.create({ doc: 'x' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 1, insert: '' } }))).toBe(false);
  });
});
