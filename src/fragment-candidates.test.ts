// Cspell:ignore Instalation -- a deliberate misspelling of a heading
import {
  describe,
  expect,
  it
} from 'vitest';

import {
  findUnambiguousFragment,
  MAX_FRAGMENT_CANDIDATES,
  normalizeHeading,
  rankFragmentCandidates,
  similarity
} from './fragment-candidates.ts';

describe('normalizeHeading', () => {
  it('reads link-unsafe characters and whitespace runs as one space, in lower case', () => {
    expect(normalizeHeading('  Step 1: Install | Setup  ')).toBe('step 1 install setup');
    expect(normalizeHeading('A[b]\\c^d%e#f')).toBe('a b c d e f');
  });
});

describe('similarity', () => {
  it('is 1 for texts equal after normalization, including two empty ones', () => {
    expect(similarity('Step 1: Install', 'step 1 install')).toBe(1);
    expect(similarity('', '')).toBe(1);
  });

  it('falls with the edit distance', () => {
    expect(similarity('Instal', 'Install')).toBeCloseTo(1 - 1 / 7);
    expect(similarity('abc', 'xyz')).toBe(0);
  });
});

describe('rankFragmentCandidates', () => {
  it('puts the closest heading first, then the rest by closeness, and blocks last in document order', () => {
    expect(rankFragmentCandidates('#Instalation', ['Overview', 'Usage', 'Installation', 'Install notes'], ['b2', 'b1'])).toEqual([
      '#Installation',
      '#Install notes',
      '#Usage',
      '#Overview',
      '#^b2',
      '#^b1'
    ]);
  });

  it('compares the last segment of a nested heading subpath', () => {
    expect(rankFragmentCandidates('#Parent#Childe', ['Parent', 'Child'], [])[0]).toBe('#Child');
  });

  it('keeps document order for a subpath with no heading text, which is equally far from every heading', () => {
    expect(rankFragmentCandidates('# ', ['Longer', 'A'], [])).toEqual(['#Longer', '#A']);
  });

  it('ranks block ids against a missing block id, ahead of headings', () => {
    expect(rankFragmentCandidates('#^abc123', ['abc123 heading'], ['zzz', 'abc124'])).toEqual(['#^abc124', '#^zzz', '#abc123 heading']);
  });

  it('keeps document order between equally close candidates', () => {
    expect(rankFragmentCandidates('#x', ['Aa', 'Bb', 'Cc'], [])).toEqual(['#Aa', '#Bb', '#Cc']);
  });

  it('caps the list', () => {
    const headings = Array.from({ length: MAX_FRAGMENT_CANDIDATES + 5 }, (_value, index) => `Heading ${String(index)}`);
    const ranked = rankFragmentCandidates('#Heading 14', headings, []);
    expect(ranked).toHaveLength(MAX_FRAGMENT_CANDIDATES);
    expect(ranked[0]).toBe('#Heading 14');
  });
});

describe('findUnambiguousFragment', () => {
  it('picks the one close heading, and gives up on none or several', () => {
    expect(findUnambiguousFragment('#Instalation', ['Overview', 'Installation'], [])).toBe('#Installation');
    expect(findUnambiguousFragment('#Gone', ['Overview', 'Installation'], [])).toBeNull();
    expect(findUnambiguousFragment('#Instal', ['Install', 'Installs'], [])).toBeNull();
  });

  it('counts a repeated heading once, and compares block ids only with block ids', () => {
    expect(findUnambiguousFragment('#Note', ['Notes', 'Notes'], [])).toBe('#Notes');
    expect(findUnambiguousFragment('#^abc123', ['abc124'], ['abc124'])).toBe('#^abc124');
    expect(findUnambiguousFragment('#^abc123', ['abc124'], [])).toBeNull();
  });
});
