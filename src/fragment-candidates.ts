import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';

/**
The most fragment candidates offered for one broken heading or block link.
*/
export const MAX_FRAGMENT_CANDIDATES = 10;

const BLOCK_PREFIX = '#^';

/**
Characters Obsidian does not keep inside a heading link; it reads each one as a space.
*/
const LINK_UNSAFE_CHARACTERS = new Set([':', '[', ']', '\\', '#', '%', '^', '|']);

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface ScoredCandidate {
  readonly index: number;
  readonly score: number;
  readonly subpath: string;
}

/**
Heading text as Obsidian matches it inside a link: link-unsafe characters and whitespace runs become one space, trimmed,
in lower case.

@param text - The heading text.
@returns The normalized text.
*/
export function normalizeHeading(text: string): string {
  return graphemes(text).map((grapheme) => LINK_UNSAFE_CHARACTERS.has(grapheme) ? ' ' : grapheme).join('').replaceAll(/\s+/gu, ' ').trim()
    .toLowerCase();
}

/**
The least similarity at which a heading or block id is taken as the one a broken fragment link meant, as in
`Broken Heading Links`.
*/
export const MIN_UNAMBIGUOUS_FRAGMENT_SIMILARITY = 0.5;

/**
The one heading or block a broken fragment link plainly meant, for a repair applied without asking which.

Only candidates of the link's own kind count: a heading for a missing heading, a block id for a missing block id. The
fragment is unambiguous when exactly one of them is at least {@link MIN_UNAMBIGUOUS_FRAGMENT_SIMILARITY} similar.

@param missingSubpath - The subpath the link asks for, such as `#Old heading` or `#^block-id`.
@param headings - The note's heading texts, in document order.
@param blockIds - The note's block ids, in document order.
@returns The subpath to retarget the link to, or `null` when no candidate or several qualify.
*/
export function findUnambiguousFragment(missingSubpath: string, headings: readonly string[], blockIds: readonly string[]): null | string {
  const isBlock = missingSubpath.startsWith(BLOCK_PREFIX);
  const wanted = isBlock ? missingSubpath.slice(BLOCK_PREFIX.length) : lastHeadingSegment(missingSubpath);
  const texts = new Set(isBlock ? blockIds : headings);
  const matches = [...texts].filter((text) => similarity(wanted, text) >= MIN_UNAMBIGUOUS_FRAGMENT_SIMILARITY);
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) {
    return null;
  }
  return isBlock ? `${BLOCK_PREFIX}${match}` : `#${match}`;
}

/**
Orders the headings and blocks of a note by how close each is to a missing subpath, closest first, and keeps the first
{@link MAX_FRAGMENT_CANDIDATES}.

A missing heading is compared with every heading, a missing block id with every block id, after Obsidian's heading
normalization and then by edit distance. Candidates of the other kind follow in document order.

@param missingSubpath - The subpath the link asks for, such as `#Old heading` or `#^block-id`.
@param headings - The note's heading texts, in document order.
@param blockIds - The note's block ids, in document order.
@returns Subpaths such as `#Heading` or `#^id`, ready to retarget the link to.
*/
export function rankFragmentCandidates(missingSubpath: string, headings: readonly string[], blockIds: readonly string[]): string[] {
  const isBlock = missingSubpath.startsWith(BLOCK_PREFIX);
  const wanted = isBlock ? missingSubpath.slice(BLOCK_PREFIX.length) : lastHeadingSegment(missingSubpath);
  const candidates = [
    ...headings.map((heading) => ({ isBlock: false, subpath: `#${heading}`, text: heading })),
    ...blockIds.map((id) => ({ isBlock: true, subpath: `${BLOCK_PREFIX}${id}`, text: id }))
  ];
  const scored = candidates.map((candidate, index): ScoredCandidate => ({
    index,
    score: candidate.isBlock === isBlock ? similarity(wanted, candidate.text) : -1,
    subpath: candidate.subpath
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, MAX_FRAGMENT_CANDIDATES).map((candidate) => candidate.subpath);
}

/**
Similarity from `0` (nothing alike) to `1` (the same after normalization), by edit distance over graphemes.

@param a - One text.
@param b - The other text.
@returns The similarity.
*/
export function similarity(a: string, b: string): number {
  const left = graphemes(normalizeHeading(a));
  const right = graphemes(normalizeHeading(b));
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - editDistance(left, right) / longest;
}

/**
Levenshtein distance, one row at a time.
*/
function editDistance(left: readonly string[], right: readonly string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (const [leftIndex, leftGrapheme] of left.entries()) {
    const current = [leftIndex + 1];
    for (const [rightIndex, rightGrapheme] of right.entries()) {
      current.push(Math.min(
        ensureNonNullable(previous[rightIndex + 1]) + 1,
        ensureNonNullable(current[rightIndex]) + 1,
        ensureNonNullable(previous[rightIndex]) + (leftGrapheme === rightGrapheme ? 0 : 1)
      ));
    }
    previous = current;
  }
  return ensureNonNullable(previous[right.length]);
}

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

/**
The heading a subpath points at: the last segment of `#H1#H2`.
*/
function lastHeadingSegment(subpath: string): string {
  const segments = subpath.split('#').map((part) => part.trim());
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (segment) {
      return segment;
    }
  }
  return '';
}
