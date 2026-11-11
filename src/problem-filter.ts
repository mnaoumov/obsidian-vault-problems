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
What the Problems view groups its rows by.
*/
export type ProblemGrouping = 'file' | 'kind';

/**
How each row kind is named as a group heading.
*/
export const PROBLEM_KIND_LABELS: Readonly<Record<LinkProblem['row']['kind'], string>> = {
  embed: 'Embeds',
  frontmatter: 'Frontmatter links',
  html: 'HTML',
  link: 'Links',
  reference: 'Reference links',
  syntax: 'Syntax'
};

/**
Returns groups in note and source-position order without changing the engine's snapshot.

Grouped by file, each key is a source path. Grouped by kind, each key is a row kind, the kinds in heading order
and each kind's rows still in note and source-position order.
*/
export function groupProblems(problems: readonly LinkProblem[], filter: ProblemFilter, grouping: ProblemGrouping = 'file'): Map<string, LinkProblem[]> {
  const groups = new Map<string, LinkProblem[]>();
  if (grouping === 'kind') {
    for (const kind of Object.keys(PROBLEM_KIND_LABELS)) {
      groups.set(kind, []);
    }
  }
  const folder = filter.folder.trim().replaceAll(/^\/+|\/+$/gu, '');
  for (const problem of [...problems].sort((left, right) => left.row.sourcePath.localeCompare(right.row.sourcePath) || (left.row.position?.start.offset ?? -1) - (right.row.position?.start.offset ?? -1))) {
    const path = problem.row.sourcePath;
    if (isIgnoredPath(path, filter.ignoredPaths) || (filter.kind && problem.row.kind !== filter.kind) || (folder && !path.startsWith(`${folder}/`))) {
      continue;
    }
    const key = grouping === 'kind' ? problem.row.kind : path;
    const group = groups.get(key) ?? [];
    group.push(problem);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (group.length === 0) {
      groups.delete(key);
    }
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
