import type { LinkProblem } from './link-model.ts';

/**
View filters also provide the shared path exclusion policy for diagnostics consumers.
*/
export interface ProblemFilter {
  readonly folder: string;
  readonly ignoredPaths: readonly string[];
  readonly kind: string;
}

/**
Returns groups in note and source-position order without changing the engine's snapshot.
*/
export function groupProblems(problems: readonly LinkProblem[], filter: ProblemFilter): Map<string, LinkProblem[]> {
  const groups = new Map<string, LinkProblem[]>();
  const folder = filter.folder.trim().replaceAll(/^\/+|\/+$/gu, '');
  for (const problem of [...problems].sort((left, right) => left.row.sourcePath.localeCompare(right.row.sourcePath) || (left.row.position?.start.offset ?? -1) - (right.row.position?.start.offset ?? -1))) {
    const path = problem.row.sourcePath;
    if (isIgnoredPath(path, filter.ignoredPaths) || (filter.kind && problem.row.kind !== filter.kind) || (folder && !path.startsWith(`${folder}/`))) {
      continue;
    }
    const group = groups.get(path) ?? [];
    group.push(problem);
    groups.set(path, group);
  }
  return groups;
}

/**
Matches vault-relative paths and folders, with `*`, `**` and `?` glob wildcards.
*/
export function isIgnoredPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.trim().replaceAll('\\', '/').replaceAll(/^\/+|\/+$/gu, '');
    if (!normalized) {
      return false;
    }
    const expression = normalized.split(/(?<wildcard>\*\*\/|\*\*|\*|\?)/u).map((part) => {
      switch (part) {
        case '?': {
          return '[^/]';
        }
        case '*': {
          return '[^/]*';
        }
        case '**': {
          return '.*';
        }
        case '**/': {
          return '(?:.*/)?';
        }
        default: {
          return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        }
      }
    }).join('');
    return new RegExp(`^(?:${expression})(?:/.*)?$`, 'u').test(path);
  });
}
