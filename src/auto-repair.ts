import type { Transaction } from '@codemirror/state';

import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';

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
Multi-range operations, copies and transformed clipboard content provide no unique move evidence.
*/
export function matchCutPaste(cut: Transaction, paste: Transaction): CutPaste | null {
  if (!cut.isUserEvent('delete.cut') || !paste.isUserEvent('input.paste')) {
    return null;
  }
  const deletion = singleChange(cut);
  const insertion = singleChange(paste);
  return !deletion || !insertion || deletion.inserted || insertion.text || !deletion.text || deletion.text !== insertion.inserted ? null : { from: deletion.from, text: deletion.text, to: insertion.to };
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
