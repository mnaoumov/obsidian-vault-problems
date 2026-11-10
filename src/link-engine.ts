import type { AsyncEventRef } from '@mnaoumov/typescript-lib/async-events';
import type {
  App,
  CachedMetadata,
  Pos
} from 'obsidian';

import { AsyncEventsBase } from '@mnaoumov/typescript-lib/async-events';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import {
  parseLinktext,
  resolveSubpath
} from 'obsidian';

import type { HtmlDiagnostic } from './advanced-metadata-cache.ts';
import type {
  LinkChange,
  LinkEngineChange,
  LinkEngineEventMap,
  LinkProblem,
  LinkRow,
  LinkTarget
} from './link-model.ts';
import type { SyntaxIssue } from './syntax-checks.ts';

/**
Longest tag source quoted in a problem message; a long tag is cut, never rewritten.
*/
const MAX_HTML_MESSAGE_LENGTH = 80;

/**
Collaborators for a metadata-backed link engine.
*/
export interface LinkEngineConstructorParams {
  readonly app: App;
  readonly notify: (problems: readonly LinkProblem[]) => void;
}

interface LinkReference {
  readonly key: null | string;
  readonly kind: LinkRow['kind'];
  readonly link: string;
  readonly position: null | Pos;
}

/**
A live snapshot shared by the problems view, repairs and editor diagnostics.
*/
export class LinkEngine extends AsyncEventsBase<LinkEngineEventMap> {
  private readonly app: App;
  private batchDepth = 0;
  private readonly htmlProblems = new Map<string, readonly LinkProblem[]>();
  private initialized = false;
  private readonly names = new Map<string, Set<string>>();
  private readonly notify: (problems: readonly LinkProblem[]) => void;
  private readonly pending: LinkChange[] = [];
  private readonly problems = new Map<string, readonly LinkProblem[]>();
  private readonly rows = new Map<string, readonly LinkRow[]>();
  private readonly syntaxProblems = new Map<string, readonly LinkProblem[]>();
  private readonly targets = new Map<string, Set<string>>();

  public constructor(params: LinkEngineConstructorParams) {
    super();
    this.app = params.app;
    this.notify = params.notify;
  }

  /**
  Opens a batch that another component ends, such as a provider's bulk-operation lifecycle.

  @returns An idempotent end; the outermost end compares every deferred change once.
  */
  public beginBatch(): () => void {
    this.batchDepth++;
    let isEnded = false;
    return (): void => {
      if (isEnded) {
        return;
      }
      isEnded = true;
      this.batchDepth--;
      if (this.batchDepth === 0) {
        this.applyChanges(this.pending.splice(0));
      }
    };
  }

  /**
  Drops every HTML problem, when their provider goes away; a later scan publishes them again.
  */
  public clearHtmlDiagnostics(): void {
    const sourcePaths = [...this.htmlProblems.keys()];
    if (sourcePaths.length === 0) {
      return;
    }
    this.htmlProblems.clear();
    this.trigger('changed', { newProblems: [], sourcePaths } satisfies LinkEngineChange);
  }

  /**
  All current problems, without another vault scan.
  */
  public getAllProblems(): readonly LinkProblem[] {
    return [...this.problems.values(), ...this.syntaxProblems.values(), ...this.htmlProblems.values()].flat();
  }

  /**
  Current problems for a note: link problems in metadata order, then syntax and HTML problems in source order.
  */
  public getProblems(sourcePath: string): readonly LinkProblem[] {
    return [...this.getLinkProblems(sourcePath), ...this.syntaxProblems.get(sourcePath) ?? [], ...this.htmlProblems.get(sourcePath) ?? []];
  }

  /**
  Current rows for a note, in metadata order.
  */
  public getRows(sourcePath: string): readonly LinkRow[] {
    return this.rows.get(sourcePath) ?? [];
  }

  /**
  Sources retained for a target, including links whose subpath just disappeared.
  */
  public getSourcesForTarget(targetPath: string): readonly string[] {
    return [...this.targets.get(targetPath) ?? []];
  }

  /**
  Takes the only vault-wide snapshot; repeated layout callbacks are harmless.
  */
  public initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const paths = this.app.vault.getMarkdownFiles().map((file) => file.path);
    this.recompute(paths, null);
  }

  /**
  Subscribes to atomic changes, including repairs and removed source notes.
  */
  public onChanged(callback: (change: LinkEngineChange) => void): AsyncEventRef {
    return this.on('changed', callback);
  }

  /**
  Defers all comparisons until the outermost operation finishes, even on failure.
  */
  public async runInBatch(operation: () => Promise<void>): Promise<void> {
    const end = this.beginBatch();
    try {
      await operation();
    } finally {
      end();
    }
  }

  /**
  Replaces a note's HTML problems, as the shared HTML index reported them, and publishes the change when it differs.
  */
  public setHtmlDiagnostics(sourcePath: string, diagnostics: readonly HtmlDiagnostic[]): void {
    const problems = [...diagnostics]
      .sort((left, right) => left.range.position.start.offset - right.range.position.start.offset || left.kind.localeCompare(right.kind))
      .map((diagnostic): LinkProblem => ({
        cause: null,
        html: diagnostic,
        message: describeHtmlDiagnostic(diagnostic),
        row: {
          id: `html:${diagnostic.kind}:${String(diagnostic.range.position.start.offset)}`,
          key: null,
          kind: 'html',
          link: diagnostic.range.html,
          position: diagnostic.range.position,
          sourcePath,
          target: null,
          targetPath: null
        },
        status: 'standing'
      }));
    this.replaceNoteProblems(this.htmlProblems, sourcePath, problems, (problem) => problem.html);
  }

  /**
  Replaces a note's syntax problems, computed from its text, and publishes the change when it differs.
  */
  public setSyntaxIssues(sourcePath: string, issues: readonly SyntaxIssue[]): void {
    const problems = issues.map((issue): LinkProblem => ({
      cause: null,
      message: issue.message,
      row: {
        id: `syntax:${issue.code}:${String(issue.position.start.offset)}`,
        key: null,
        kind: 'syntax',
        link: issue.code,
        position: issue.position,
        sourcePath,
        target: null,
        targetPath: null
      },
      status: 'standing',
      syntax: issue
    }));
    this.replaceNoteProblems(this.syntaxProblems, sourcePath, problems, (problem) => problem.syntax);
  }

  /**
  Refreshes a note and the sources whose resolution the operation can change.
  */
  public update(change: LinkChange): void {
    this.updateMany([change]);
  }

  /**
  Applies a settled metadata cycle as one comparison.
  */
  public updateMany(changes: readonly LinkChange[]): void {
    if (!this.initialized) {
      return;
    }
    if (this.batchDepth > 0) {
      this.pending.push(...changes);
      return;
    }
    this.applyChanges(changes);
  }

  private addIndexes(sourcePath: string): void {
    for (const row of this.getRows(sourcePath)) {
      if (row.targetPath) {
        addIndex(this.targets, row.targetPath, sourcePath);
      }
      addIndex(this.names, nameKey(parseLinktext(decodeLink(row.link)).path), sourcePath);
    }
  }

  private applyChanges(changes: readonly LinkChange[]): void {
    if (changes.length === 0) {
      return;
    }
    const affected = new Set<string>();
    for (const change of changes) {
      for (const path of [change.path, change.oldPath]) {
        if (path === undefined) {
          continue;
        }
        affected.add(path);
        for (const source of this.targets.get(path) ?? []) {
          affected.add(source);
        }
        for (const source of this.names.get(nameKey(path)) ?? []) {
          affected.add(source);
        }
        const file = this.app.vault.getFileByPath(path);
        if (file) {
          for (const source of this.app.metadataCache.getBacklinksForFile(file).keys()) {
            affected.add(source);
          }
        }
      }
      if (change.oldPath === undefined) {
        continue;
      }
      // Carry identities across a source rename, so its existing damage does not become new damage.
      const oldRows = this.getRows(change.oldPath);
      const oldProblems = this.getLinkProblems(change.oldPath);
      this.removeIndexes(change.oldPath);
      this.rows.delete(change.oldPath);
      this.problems.delete(change.oldPath);
      this.rows.set(change.path, oldRows);
      this.problems.set(change.path, oldProblems);
      for (const store of [this.syntaxProblems, this.htmlProblems]) {
        const oldNoteProblems = store.get(change.oldPath);
        store.delete(change.oldPath);
        if (oldNoteProblems) {
          store.set(change.path, oldNoteProblems.map((problem) => ({ ...problem, row: { ...problem.row, sourcePath: change.path } })));
        }
      }
    }
    const first = ensureNonNullable(changes[0]);
    const cause: LinkChange = changes.length === 1 ? first : { changes, kind: 'batch', path: first.path };
    this.recompute([...affected], cause);
  }

  private getLinkProblems(sourcePath: string): readonly LinkProblem[] {
    return this.problems.get(sourcePath) ?? [];
  }

  private readRows(sourcePath: string, cache: CachedMetadata): LinkRow[] {
    const rows: LinkRow[] = [];
    const counts = new Map<string, number>();
    const add = (reference: LinkReference): void => {
      const { key, kind, link, position } = reference;
      // External destinations belong to their protocol handler, not to the vault resolver.
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(link)) {
        return;
      }
      const identity = JSON.stringify([kind, link, key]);
      const occurrence = counts.get(identity) ?? 0;
      counts.set(identity, occurrence + 1);
      const { path, subpath } = parseLinktext(decodeLink(link));
      const file = path ? this.app.metadataCache.getFirstLinkpathDest(path, sourcePath) : this.app.vault.getFileByPath(sourcePath);
      let target: LinkTarget | null = null;
      if (file && this.app.vault.getFileByPath(file.path)) {
        if (subpath) {
          const targetCache = this.app.metadataCache.getFileCache(file);
          const resolved = targetCache && resolveSubpath(targetCache, subpath);
          if (resolved) {
            target = { kind: resolved.type === 'block' ? 'block' : 'heading', path: file.path, subpath };
          }
        } else {
          target = { kind: 'file', path: file.path, subpath };
        }
      }
      rows.push({ id: `${identity}:${String(occurrence)}`, key, kind, link, position, sourcePath, target, targetPath: file?.path ?? null });
    };
    for (const reference of cache.links ?? []) {
      add({ key: null, kind: 'link', link: reference.link, position: reference.position });
    }
    for (const reference of cache.embeds ?? []) {
      add({ key: null, kind: 'embed', link: reference.link, position: reference.position });
    }
    for (const reference of cache.frontmatterLinks ?? []) {
      add({ key: reference.key, kind: 'frontmatter', link: reference.link, position: null });
    }
    // Obsidian calls reference-style link occurrences `referenceLinks` in its public cache.
    for (const reference of cache.referenceLinks ?? []) {
      add({ key: reference.id, kind: 'reference', link: reference.link, position: reference.position });
    }
    return rows;
  }

  private recompute(paths: readonly string[], cause: LinkChange | null): void {
    const newProblems: LinkProblem[] = [];
    for (const path of paths) {
      const previousRows = new Map(this.getRows(path).map((row) => [row.id, row]));
      const previousProblems = new Map(this.getLinkProblems(path).map((problem) => [problem.row.id, problem]));
      this.removeIndexes(path);
      const file = this.app.vault.getFileByPath(path);
      const cache = file ? this.app.metadataCache.getFileCache(file) : null;
      // A newly created file may not have metadata yet. Preserve its snapshot until its changed event.
      if (file && !cache) {
        this.addIndexes(path);
        continue;
      }
      const rows = cache ? this.readRows(path, cache) : [];
      const currentIds = new Set(rows.map((row) => row.id));
      const problems: LinkProblem[] = [];
      for (const row of rows) {
        if (row.target) {
          continue;
        }
        const previous = previousProblems.get(row.id);
        // An edited destination retains its source anchor. Avoid claiming an inserted link whose old
        // neighbor merely moved down: that neighbor's identity still appears in the current rows.
        const previousRow = previousRows.get(row.id) ?? [...previousRows.values()].find((candidate) =>
          !currentIds.has(candidate.id)
          && candidate.kind === row.kind
          && candidate.key === row.key
          && candidate.position?.start.offset === row.position?.start.offset
        );
        const isNew = Boolean(cause && previousRow?.target);
        const problem: LinkProblem = {
          cause: isNew ? cause : previous?.cause ?? null,
          message: `Cannot resolve ${row.link}`,
          row,
          status: isNew ? 'new' : previous?.status ?? 'standing'
        };
        problems.push(problem);
        if (isNew) {
          newProblems.push(problem);
        }
      }
      if (file) {
        this.rows.set(path, rows);
        this.problems.set(path, problems);
        this.addIndexes(path);
      } else {
        this.rows.delete(path);
        this.problems.delete(path);
        this.syntaxProblems.delete(path);
        this.htmlProblems.delete(path);
      }
    }
    this.trigger('changed', { newProblems, sourcePaths: paths } satisfies LinkEngineChange);
    if (newProblems.length === 0) {
      return;
    }
    this.notify(newProblems);
  }

  private removeIndexes(sourcePath: string): void {
    for (const row of this.getRows(sourcePath)) {
      if (row.targetPath) {
        removeIndex(this.targets, row.targetPath, sourcePath);
      }
      removeIndex(this.names, nameKey(parseLinktext(decodeLink(row.link)).path), sourcePath);
    }
  }

  /**
  Replaces one note's problems in a text-derived store, publishing only a real difference.
  */
  private replaceNoteProblems(
    store: Map<string, readonly LinkProblem[]>,
    sourcePath: string,
    problems: readonly LinkProblem[],
    getDetail: (problem: LinkProblem) => unknown
  ): void {
    if (!this.app.vault.getFileByPath(sourcePath)) {
      return;
    }
    const previous = store.get(sourcePath) ?? [];
    if (JSON.stringify(previous.map((problem) => getDetail(problem))) === JSON.stringify(problems.map((problem) => getDetail(problem)))) {
      return;
    }
    if (problems.length === 0) {
      store.delete(sourcePath);
    } else {
      store.set(sourcePath, problems);
    }
    this.trigger('changed', { newProblems: [], sourcePaths: [sourcePath] } satisfies LinkEngineChange);
  }
}

function addIndex(index: Map<string, Set<string>>, key: string, sourcePath: string): void {
  const sources = index.get(key) ?? new Set<string>();
  sources.add(sourcePath);
  index.set(key, sources);
}

function decodeLink(link: string): string {
  try {
    return decodeURI(link);
  } catch {
    return link;
  }
}

/**
Names what Obsidian does to the tag when it renders the note; the source is never changed.
*/
function describeHtmlDiagnostic(diagnostic: HtmlDiagnostic): string {
  const html = diagnostic.range.html.length > MAX_HTML_MESSAGE_LENGTH
    ? `${diagnostic.range.html.slice(0, MAX_HTML_MESSAGE_LENGTH)}…`
    : diagnostic.range.html;
  return diagnostic.kind === 'unknown'
    ? `Unknown HTML tag ${html}: Obsidian renders it as an element no browser knows`
    : `Obsidian's sanitizer changes or removes ${html} when it renders this note`;
}

function nameKey(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/iu, '').toLowerCase();
}

function removeIndex(index: Map<string, Set<string>>, key: string, sourcePath: string): void {
  const sources = index.get(key);
  if (!sources) {
    return;
  }
  sources.delete(sourcePath);
  if (sources.size === 0) {
    index.delete(key);
  }
}
