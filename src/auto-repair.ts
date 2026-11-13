import type { Transaction } from '@codemirror/state';

import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';

/**
A single typed character is never taken for an input-method paste, even when it equals the cut.
*/
const MINIMUM_INPUT_METHOD_PASTE_LENGTH = 2;

/**
A single cut deletion matched to one paste insertion.
*/
export interface CutPaste {
  readonly from: number;
  readonly text: string;
  readonly to: number;
}

/**
Evidence for an isolated heading edit; metadata validates its meaning before writing.
*/
export interface HeadingEdit {
  readonly newName: string;
  readonly offset: number;
  readonly oldName: string;
}

interface HeadingLine {
  readonly level: string;
  readonly name: string;
}

interface TextChange {
  readonly from: number;
  readonly inserted: string;
  readonly text: string;
  readonly to: number;
}

/**
Refuses changes outside a single heading line, including heading insertion and deletion.
*/
export function detectHeadingEdit(before: string, after: string): HeadingEdit | null {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  if (oldLines.length !== newLines.length) {
    return null;
  }
  let result: HeadingEdit | null = null;
  let offset = 0;
  for (const [index, oldLine] of oldLines.entries()) {
    const newLine = newLines[index];
    if (oldLine !== newLine) {
      const oldHeading = readHeadingLine(oldLine, oldLines[index + 1]);
      const newHeading = readHeadingLine(ensureNonNullable(newLine), newLines[index + 1]);
      if (result || !newHeading || oldHeading?.level !== newHeading.level || oldHeading.name === newHeading.name) {
        return null;
      }
      result = { newName: newHeading.name, offset, oldName: oldHeading.name };
    }
    offset += oldLine.length + 1;
  }
  return result;
}

/**
An Android keyboard's clipboard suggestion (Gboard's clipboard chip) commits the clipboard through the input method,
not the WebView's Paste command, so CodeMirror sees `input.type` rather than `input.paste`. A cut that ends in a line
break arrives in two transactions: the text without its final line break, then that line break as an Enter (`input`).
This recognizes the first half; {@link matchSplitImePaste} completes it.
*/
export function isSplitImePasteStart(cut: Transaction, first: Transaction): boolean {
  const deletion = cut.isUserEvent('delete.cut') ? singleChange(cut) : null;
  const insertion = isImeCommit(first) ? singleChange(first) : null;
  return !!deletion && !!insertion && !deletion.inserted && !insertion.text && deletion.text.length > 1 && deletion.text.endsWith('\n')
    && insertion.inserted === deletion.text.slice(0, -1);
}

/**
Multi-range operations, copies and transformed clipboard content provide no unique move evidence. The paste is either
the WebView's Paste command (`input.paste`) or an input method committing the identical text in one go (`input.type`).
*/
export function matchCutPaste(cut: Transaction, paste: Transaction): CutPaste | null {
  const isPaste = paste.isUserEvent('input.paste');
  if (!cut.isUserEvent('delete.cut') || !(isPaste || isImeCommit(paste))) {
    return null;
  }
  const deletion = singleChange(cut);
  const insertion = singleChange(paste);
  const minimumLength = isPaste ? 1 : MINIMUM_INPUT_METHOD_PASTE_LENGTH;
  return !deletion || !insertion || deletion.inserted || insertion.text || deletion.text.length < minimumLength || deletion.text !== insertion.inserted
    ? null
    : { from: deletion.from, text: deletion.text, to: insertion.to };
}

/**
Matches the two-transaction input-method paste described in {@link isSplitImePasteStart}: the line break must be the
very next change, inserted exactly where the first half ended.
*/
export function matchSplitImePaste(cut: Transaction, first: Transaction, second: Transaction): CutPaste | null {
  if (!isSplitImePasteStart(cut, first) || !second.isUserEvent('input') || second.isUserEvent('input.paste') || !second.startState.doc.eq(first.newDoc)) {
    return null;
  }
  const deletion = ensureNonNullable(singleChange(cut));
  const insertion = ensureNonNullable(singleChange(first));
  const lineBreak = singleChange(second);
  return !lineBreak || lineBreak.text || lineBreak.inserted !== '\n' || lineBreak.from !== insertion.to + insertion.inserted.length
    ? null
    : { from: deletion.from, text: deletion.text, to: insertion.to };
}

/**
Typing composes (`input.type.compose`); an input method committing finished text, such as a clipboard suggestion, does not.
*/
function isImeCommit(transaction: Transaction): boolean {
  return transaction.isUserEvent('input.type') && !transaction.isUserEvent('input.type.compose');
}

function readHeadingLine(line: string, next: string | undefined): HeadingLine | null {
  const match = /^ {0,3}(?<level>#{1,6})[\t ]+(?<name>.*?)(?:[\t ]+#+)?[\t ]*\r?$/u.exec(line)?.groups;
  if (match) {
    return { level: ensureNonNullable(match['level']), name: ensureNonNullable(match['name']) };
  }
  if (line.trim() && next && /^ {0,3}(?:=+|-+)[\t ]*\r?$/u.test(next)) {
    return { level: next.trim(), name: line.trim() };
  }
  return null;
}

function singleChange(transaction: Transaction): null | TextChange {
  const changes: TextChange[] = [];
  transaction.changes.iterChanges((from, to, fromNew, _toNew, inserted) => {
    changes.push({ from, inserted: inserted.toString(), text: transaction.startState.doc.sliceString(from, to), to: fromNew });
  });
  return changes.length === 1 ? ensureNonNullable(changes[0]) : null;
}
