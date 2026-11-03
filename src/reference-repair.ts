import type { ReferenceLinkCache } from 'obsidian';

import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';

/**
A new URI for a definition identified by Obsidian's parser.
*/
export interface ReferenceRepair {
  readonly destination: string;
  readonly reference: ReferenceLinkCache;
}

/**
Edits only a validated destination within a metadata-provided definition range.
*/
export function applyReferenceRepairs(content: string, repairs: readonly ReferenceRepair[]): string {
  let result = content;
  for (const { destination, reference } of [...repairs].sort((left, right) => right.reference.position.start.offset - left.reference.position.start.offset)) {
    const start = reference.position.start.offset;
    const end = reference.position.end.offset;
    if (!destination || start < 0 || end > content.length || end < start) {
      continue;
    }
    const definition = result.slice(start, end);
    const prefix = /^[\t ]*\[(?:\\.|[^\]\\\r\n])+\]:[\t ]*(?:\r?\n[\t ]*)?(?<angle><)?/u.exec(definition);
    if (!prefix) {
      continue;
    }
    const destinationStart = prefix[0].length;
    const destinationEnd = destinationStart + reference.link.length;
    if (definition.slice(destinationStart, destinationEnd) !== reference.link) {
      continue;
    }
    const boundary = definition.charAt(destinationEnd);
    const isAngle = ensureNonNullable(prefix.groups)['angle'] === '<';
    if (isAngle ? boundary !== '>' : boundary !== '' && !/\s/u.test(boundary)) {
      continue;
    }
    result = result.slice(0, start + destinationStart) + destination + result.slice(start + destinationEnd);
  }
  return result;
}
