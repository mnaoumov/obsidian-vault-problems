import type { ReferenceLinkCache } from 'obsidian';

import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { fromMarkdown } from 'mdast-util-from-markdown';

interface MarkdownNode {
  readonly alt?: null | string | undefined;
  readonly children?: readonly MarkdownNode[] | undefined;
  readonly identifier?: string | undefined;
  readonly position?: MarkdownPosition | undefined;
  readonly type: string;
}

interface MarkdownPoint {
  readonly offset?: number | undefined;
}

interface MarkdownPosition {
  readonly end: MarkdownPoint;
  readonly start: MarkdownPoint;
}

interface TextReplacement {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

/**
Unwraps reference use sites through a Markdown AST, preserving inline formatting and code.
*/
export function removeReference(content: string, definition: ReferenceLinkCache): string {
  // CommonMark does not recognize Obsidian comments. Refuse this case rather than touching hidden text.
  if (content.includes('%%')) {
    throw new Error('Reference removal in a note with Obsidian comments is unavailable. Choose a replacement target instead.');
  }
  const replacements: TextReplacement[] = [];
  const identifier = normalizeIdentifier(definition.id);
  function visit(node: MarkdownNode): void {
    if ((node.type === 'linkReference' || node.type === 'imageReference') && normalizeIdentifier(ensureNonNullable(node.identifier)) === identifier) {
      const position = ensureNonNullable(node.position);
      const start = ensureNonNullable(position.start.offset);
      const end = ensureNonNullable(position.end.offset);
      const first = node.children?.[0]?.position?.start.offset;
      const last = node.children?.at(-1)?.position?.end.offset;
      replacements.push({ end, start, text: first === undefined || last === undefined ? node.alt ?? '' : content.slice(first, last) });
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  }
  visit(fromMarkdown(content));
  replacements.push({ end: definition.position.end.offset, start: definition.position.start.offset, text: '' });
  let result = content;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
}
