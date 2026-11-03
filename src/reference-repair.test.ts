import type { ReferenceLinkCache } from 'obsidian';

import {
  describe,
  expect,
  it
} from 'vitest';

import { applyReferenceRepairs } from './reference-repair.ts';

function reference(text: string, offset = 0): ReferenceLinkCache {
  return { id: 'reference', link: 'Target#Old', position: { end: { col: text.length, line: 0, offset: offset + text.length }, start: { col: 0, line: 0, offset } } };
}

describe('Reference definition destinations', () => {
  it('preserves labels, titles, angle brackets, escaped labels and line endings', () => {
    for (const text of ['[label]: Target#Old "Title"', '[label]: <Target#Old> "Title"', '[escaped\\]label]:\r\n  <Target#Old>\r\n  "Title"', '[label]: Target#Old']) {
      expect(applyReferenceRepairs(text, [{ destination: 'Target#New', reference: reference(text) }])).toBe(text.replace('Target#Old', 'Target#New'));
    }
  });

  it('edits multiple metadata ranges from the end so earlier offsets stay valid', () => {
    const first = '[alpha]: Target#Old\n';
    const second = '[bravo]: Target#Old';
    const text = first + second;
    expect(applyReferenceRepairs(text, [
      { destination: 'Destination#New', reference: reference(first) },
      { destination: 'Destination#New', reference: reference(second, first.length) }
    ])).toBe(text.replaceAll('Target#Old', 'Destination#New'));
  });

  it('refuses stale metadata, non-definition ranges and partial URI matches', () => {
    for (const text of ['[label](Target#Old)', '[label]: Other#Old "Target#Old"', '[label]: Target#OldSuffix', '[label]: <Target#OldSuffix>']) {
      expect(applyReferenceRepairs(text, [{ destination: 'Target#New', reference: reference(text) }])).toBe(text);
    }
  });

  it('refuses empty destinations and ranges outside the captured content', () => {
    const text = '[label]: Target#Old';
    const valid = reference(text);
    expect(applyReferenceRepairs(text, [{ destination: '', reference: valid }])).toBe(text);
    const ranges = [[-1, text.length], [0, text.length + 1], [text.length, 0]] as const;
    for (const [start, end] of ranges) {
      const invalid: ReferenceLinkCache = { ...valid, position: { end: { col: 0, line: 0, offset: end }, start: { col: 0, line: 0, offset: start } } };
      expect(applyReferenceRepairs(text, [{ destination: 'Target#New', reference: invalid }])).toBe(text);
    }
  });
});
