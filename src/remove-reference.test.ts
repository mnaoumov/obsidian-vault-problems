import type { ReferenceLinkCache } from 'obsidian';

import {
  describe,
  expect,
  it
} from 'vitest';

import { removeReference } from './remove-reference.ts';

function definition(content: string): ReferenceLinkCache {
  const start = content.indexOf('[ref]:');
  return { id: 'ref', link: 'Missing.md', position: { end: { col: 0, line: 0, offset: content.length }, start: { col: 0, line: 0, offset: start } } };
}

describe('Remove reference-style links', () => {
  it('keeps caption formatting, nested brackets, image alt text and other references, and excludes code', () => {
    const content = '[**bold [caption]**][REF] ![image][ref] [ref][] [ref]\n\n`[code][ref]`\n\n    [code block][ref]\n\n[other][other]\n\n[other]: Present.md\n\n[ref]: Missing.md';
    expect(removeReference(content, definition(content))).toBe('**bold [caption]** image ref ref\n\n`[code][ref]`\n\n    [code block][ref]\n\n[other][other]\n\n[other]: Present.md\n\n');
  });

  it('removes an unused definition and empty caption without removing surrounding text', () => {
    const content = 'Before [][ref] after\n\n[ref]: Missing.md';
    expect(removeReference(content, definition(content))).toBe('Before  after\n\n');
    const unused = 'Before\n\n[ref]: Missing.md';
    expect(removeReference(unused, definition(unused))).toBe('Before\n\n');
  });

  it('refuses comments that the CommonMark parser cannot interpret', () => {
    const content = '%% [caption][ref] %%\n\n[ref]: Missing.md';
    expect(() => removeReference(content, definition(content))).toThrow('Obsidian comments');
  });
});
