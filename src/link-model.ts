import type { Pos } from 'obsidian';

import type { SyntaxIssue } from './syntax-checks.ts';

/**
The operation against which a snapshot is compared.
*/
export interface LinkChange {
  /**
  The operations represented by a single batch comparison.
  */
  readonly changes?: readonly LinkChange[];
  readonly kind: 'batch' | 'changed' | 'delete' | 'rename' | 'resolved';
  readonly oldPath?: string;
  readonly path: string;
}

/**
Published only after every affected note has been recomputed.
*/
export interface LinkEngineChange {
  readonly newProblems: readonly LinkProblem[];
  readonly sourcePaths: readonly string[];
}

/**
Typed event contract for diagnostics consumers.
*/
export interface LinkEngineEventMap {
  readonly changed: [change: LinkEngineChange];
}

/**
An unresolved row; a new break keeps its cause until it is repaired.
*/
export interface LinkProblem {
  readonly cause: LinkChange | null;
  readonly message: string;
  readonly row: LinkRow;
  readonly status: 'new' | 'standing';
  /**
  Present only on a syntax problem, whose row has the syntax kind and no target.
  */
  readonly syntax?: SyntaxIssue;
}

/**
One metadata reference and its current resolution.
*/
export interface LinkRow {
  readonly id: string;
  readonly key: null | string;
  readonly kind: 'embed' | 'frontmatter' | 'link' | 'reference' | 'syntax';
  readonly link: string;
  /**
  Frontmatter metadata supplies a key rather than an exact text range.
  */
  readonly position: null | Pos;
  readonly sourcePath: string;
  readonly target: LinkTarget | null;
  /**
  Retains the file endpoint when only its heading or block is missing.
  */
  readonly targetPath: null | string;
}

/**
A resolved endpoint, including a subpath when one is present.
*/
export interface LinkTarget {
  readonly kind: 'block' | 'file' | 'heading';
  readonly path: string;
  readonly subpath: string;
}
