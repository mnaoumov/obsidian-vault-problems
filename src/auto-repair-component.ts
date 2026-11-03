import type {
  StateField,
  Transaction
} from '@codemirror/state';
import type { ResourceLockComponent } from '@mnaoumov/obsidian-lib/resource-lock';
import type {
  App,
  CachedMetadata,
  MarkdownFileInfo,
  TFile
} from 'obsidian';

import { EditorView } from '@codemirror/view';
import {
  editReferencesInContent,
  generateMarkdownLink,
  LinkStyle
} from '@mnaoumov/obsidian-lib/link';
import { parseMetadata } from '@mnaoumov/obsidian-lib/metadata-cache';
import { parseLink } from '@mnaoumov/obsidian-lib/parse-link';
import { readSafe } from '@mnaoumov/obsidian-lib/vault';
import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { encodeUrl } from '@mnaoumov/typescript-lib/url';
import {
  Component,
  editorInfoField,
  parseLinktext,
  resolveSubpath
} from 'obsidian';

import type { LinkRow } from './link-model.ts';
import type { ReferenceRepair } from './reference-repair.ts';

import {
  detectHeadingEdit,
  matchCutPaste
} from './auto-repair.ts';
import { LinkEngine } from './link-engine.ts';
import { applyReferenceRepairs } from './reference-repair.ts';

/**
Runtime collaborators; notices stay owned by the plugin.
*/
export interface AutoRepairComponentConstructorParams {
  readonly app: App;
  readonly engine: LinkEngine;
  readonly isEnabled: () => boolean;
  readonly notify: (message: string, undo: () => Promise<void>) => void;
  readonly resourceLockComponent: ResourceLockComponent;
}

/**
A compare-and-swap edit, retained as the single Undo operation's journal.
*/
export interface RepairFileEdit {
  readonly after: string;
  readonly before: string;
  readonly path: string;
}

interface CutEvidence {
  readonly path: string;
  readonly rows: readonly LinkRow[];
  readonly transaction: Transaction;
}

interface RepairIntent {
  readonly expected: string;
  readonly newPath: string;
  readonly newSubpath: string;
  readonly offset: number;
  readonly oldPath: string;
  readonly oldSubpath: string;
  readonly rows: readonly LinkRow[];
}

class RepairConflictError extends Error {}

/**
Observes actual editor operations, then validates metadata before changing any backlinks.
*/
export class AutoRepairComponent extends Component {
  public readonly extension = EditorView.updateListener.of((update) => {
    // The host's CJS StateField is the same runtime value as CodeMirror's ESM field.
    const path = update.state.field(castTo<StateField<MarkdownFileInfo>>(editorInfoField), false)?.file?.path;
    if (path) {
      for (const transaction of update.transactions) {
        this.observe(path, transaction);
      }
    }
  });

  private cut: CutEvidence | null = null;
  private intents: RepairIntent[] = [];
  private isActive = false;
  private isApplying = false;
  private isRunning = false;
  private readonly params: AutoRepairComponentConstructorParams;
  private shouldRunAgain = false;

  public constructor(params: AutoRepairComponentConstructorParams) {
    super();
    this.params = params;
  }

  /**
  Captures evidence before the asynchronous metadata cycle loses the old target.
  */
  public observe(path: string, transaction: Transaction): void {
    if (!transaction.docChanged || this.isApplying) {
      return;
    }
    if (!this.params.isEnabled()) {
      this.clear();
      return;
    }
    const isUserEdit = ['input', 'delete', 'undo', 'redo'].some((userEvent) => transaction.isUserEvent(userEvent));
    if (!isUserEdit) {
      const content = transaction.newDoc.toString();
      // Opening another note replaces the editor document without editing either note.
      // Preserve clipboard evidence across that load, but invalidate changes to its original document.
      if (this.cut?.path === path && this.cut.transaction.newDoc.toString() !== content) {
        this.cut = null;
      }
      this.intents = this.intents.filter((intent) => intent.newPath !== path || intent.expected === content);
      return;
    }
    const rows = this.params.engine.getSourcesForTarget(path).flatMap((source) => this.params.engine.getRows(source));
    if (transaction.isUserEvent('delete.cut')) {
      this.cut = { path, rows, transaction };
      this.intents = this.intents.filter((intent) => intent.newPath !== path);
      return;
    }
    const cut = this.cut;
    this.cut = null;
    if (cut && transaction.isUserEvent('input.paste')) {
      const move = matchCutPaste(cut.transaction, transaction);
      if (move && cut.path !== path) {
        invokeAsyncSafely(() => this.recordMove(cut, path, transaction, move.from, move.to, move.text.length));
      }
    }
    const before = transaction.startState.doc.toString();
    const after = transaction.newDoc.toString();
    const edit = detectHeadingEdit(before, after);
    const previous = this.intents.filter((intent) => intent.oldPath === path && intent.newPath === path && intent.expected === before && intent.offset === edit?.offset);
    this.intents = this.intents.filter((intent) => intent.newPath !== path);
    if (edit && (transaction.isUserEvent('input') || transaction.isUserEvent('delete'))) {
      const file = this.params.app.vault.getFileByPath(path);
      const cache = file && this.params.app.metadataCache.getFileCache(file);
      const captured = previous.length > 0 ? previous.flatMap((intent) => intent.rows) : captureRows(rows, path, cache, 'heading', edit.offset);
      for (const oldSubpath of new Set(captured.map((row) => ensureNonNullable(row.target).subpath))) {
        this.intents.push({
          expected: after,
          newPath: path,
          newSubpath: `#${edit.newName}`,
          offset: edit.offset,
          oldPath: path,
          oldSubpath,
          rows: captured.filter((row) => ensureNonNullable(row.target).subpath === oldSubpath)
        });
      }
    }
    this.schedule();
  }

  public override onload(): void {
    this.isActive = true;
    this.register(() => {
      this.isActive = false;
      this.intents = [];
      this.cut = null;
    });
    this.registerEvent(this.params.app.metadataCache.on('resolved', () => {
      this.schedule();
    }));
    this.registerEvent(this.params.app.metadataCache.on('changed', () => {
      this.schedule();
    }));
    // A file operation invalidates editor evidence; its own handler owns link updates.
    this.registerEvent(this.params.app.vault.on('rename', () => {
      this.clear();
    }));
    this.registerEvent(this.params.app.vault.on('delete', () => {
      this.clear();
    }));
  }

  /**
  Restores all recorded files together, refusing to overwrite subsequent user edits.
  */
  public async undo(edits: readonly RepairFileEdit[]): Promise<void> {
    await this.applyEdits(edits.map((edit) => ({ after: edit.before, before: edit.after, path: edit.path })));
  }

  private async applyEdits(edits: readonly RepairFileEdit[], pathsToLock: readonly string[] = []): Promise<void> {
    const locks: Disposable[] = [];
    try {
      for (const path of new Set([...edits.map((edit) => edit.path), ...pathsToLock])) {
        locks.push(this.params.resourceLockComponent.lockForPath({ operationName: 'Repair links', pathOrFile: path }));
      }
      await this.writeEdits(edits);
    } finally {
      for (const lock of locks.reverse()) {
        lock[Symbol.dispose]();
      }
    }
  }

  private checkCanApply(): boolean {
    return this.isActive && this.params.isEnabled();
  }

  private clear(): void {
    this.cut = null;
    this.intents = [];
  }

  private findIntent(link: string, source: TFile, intents: readonly RepairIntent[]): RepairIntent | undefined {
    const { app } = this.params;
    let decoded: string;
    try {
      decoded = decodeURI(link);
    } catch {
      return;
    }
    const parsed = parseLinktext(decoded);
    const target = parsed.path ? app.metadataCache.getFirstLinkpathDest(parsed.path, source.path) : source;
    const intent = intents.find((candidate) =>
      candidate.oldPath === target?.path && candidate.oldSubpath === parsed.subpath
      && candidate.rows.some((row) => row.sourcePath === source.path && row.link === link)
    );
    if (!intent) {
      return;
    }
    const cache = app.metadataCache.getFileCache(ensureNonNullable(target));
    return cache && resolveSubpath(cache, parsed.subpath) ? undefined : intent;
  }

  private async findReady(): Promise<RepairIntent[]> {
    const { app } = this.params;
    const ready: RepairIntent[] = [];
    const groups = new Map<string, RepairIntent[]>();
    // eslint-disable-next-line unicorn/prefer-group-by -- Map.groupBy exceeds the supported ES2022 mobile baseline.
    for (const intent of this.intents) {
      const key = JSON.stringify([intent.oldPath, intent.newPath, intent.expected]);
      const group = groups.get(key) ?? [];
      group.push(intent);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const first = ensureNonNullable(group[0]);
      const oldFile = app.vault.getFileByPath(first.oldPath);
      const newFile = app.vault.getFileByPath(first.newPath);
      if (!newFile || await this.readCurrent(newFile) !== first.expected) {
        continue;
      }
      // All endpoints of one editor operation use the same settled cache snapshot.
      const cache = app.metadataCache.getFileCache(newFile);
      const oldCache = oldFile && app.metadataCache.getFileCache(oldFile);
      if (!oldCache || !cache) {
        continue;
      }
      for (const intent of group) {
        const resolved = resolveSubpath(cache, intent.newSubpath);
        const oldResolved = resolveSubpath(oldCache, intent.oldSubpath);
        if (!oldResolved && resolved?.start.offset === intent.offset && countEndpoints(cache, intent.newSubpath, intent.expected) === 1) {
          ready.push(intent);
        }
      }
    }
    return ready;
  }

  private async getReferenceRepairs(source: TFile, content: string, intents: readonly RepairIntent[]): Promise<readonly ReferenceRepair[]> {
    const { app } = this.params;
    const cache = await parseMetadata(app, content);
    return (cache.referenceLinks ?? []).flatMap((reference) => {
      const intent = this.findIntent(reference.link, source, intents);
      if (!intent) {
        return [];
      }
      const generated = generateMarkdownLink({
        alias: 'reference',
        app,
        linkStyle: LinkStyle.Markdown,
        originalLink: `[reference](<${reference.link}>)`,
        shouldUseAngleBrackets: false,
        sourcePathOrFile: source,
        subpath: intent.newSubpath,
        targetPathOrFile: intent.newPath
      });
      const destination = encodeUrl(ensureNonNullable(parseLink(generated)).url, true);
      return { destination, reference };
    });
  }

  private readCurrent(file: TFile): Promise<null | string> {
    // Flush dirty editors before comparing saved content; the library also handles deletion races.
    return readSafe(this.params.app, file);
  }

  private async recordMove(cut: CutEvidence, path: string, paste: Transaction, from: number, to: number, length: number): Promise<void> {
    const cache = await parseMetadata(this.params.app, cut.transaction.startState.doc.toString());
    const endpoints = [
      ...(cache.headings ?? []).map((heading) => ({ end: heading.position.end.offset, kind: 'heading' as const, offset: heading.position.start.offset, subpath: `#${heading.heading}` })),
      ...Object.values(cache.blocks ?? {}).map((block) => ({ end: block.position.end.offset, kind: 'block' as const, offset: block.position.start.offset, subpath: `#^${block.id}` }))
    ];
    if (!this.isActive || !this.params.isEnabled()) {
      return;
    }
    for (const endpoint of endpoints) {
      if (!(endpoint.offset >= from && endpoint.end <= from + length)) {
        continue;
      }

      const captured = captureRows(cut.rows, cut.path, cache, endpoint.kind, endpoint.offset);
      for (const oldSubpath of new Set(captured.map((row) => ensureNonNullable(row.target).subpath))) {
        this.intents.push({
          expected: paste.newDoc.toString(),
          newPath: path,
          newSubpath: endpoint.subpath,
          offset: to + endpoint.offset - from,
          oldPath: cut.path,
          oldSubpath,
          rows: captured.filter((row) => ensureNonNullable(row.target).subpath === oldSubpath).map((row) => {
            const wasMoved = row.sourcePath === cut.path && row.position && row.position.start.offset >= from && row.position.end.offset <= from + length;
            return wasMoved ? { ...row, sourcePath: path } : row;
          })
        });
      }
    }
    this.schedule();
  }

  private async repair(): Promise<void> {
    if (!this.checkCanApply()) {
      this.clear();
      return;
    }
    const { app } = this.params;
    const ready = await this.findReady();
    if (ready.length === 0) {
      return;
    }
    const paths = new Set(ready.flatMap((intent) => intent.rows.map((row) => row.sourcePath)));
    const edits: RepairFileEdit[] = [];
    for (const path of paths) {
      const file = app.vault.getFileByPath(path);
      if (!file) {
        continue;
      }
      const before = await this.readCurrent(file);
      if (before === null) {
        continue;
      }
      const referenceRepairs = await this.getReferenceRepairs(file, before, ready);
      const after = await editReferencesInContent({
        app,
        content: applyReferenceRepairs(before, referenceRepairs),
        referenceConverter: (reference) => {
          const intent = this.findIntent(reference.link, file, ready);
          if (!intent) {
            return;
          }
          const original = parseLink(reference.original);
          return generateMarkdownLink({
            app,
            originalLink: reference.original,
            sourcePathOrFile: file,
            subpath: intent.newSubpath,
            targetPathOrFile: intent.newPath,
            ...(original?.alias !== undefined && { alias: original.alias })
          });
        }
      });
      if (before !== after) {
        edits.push({ after, before, path });
      }
    }
    if (!this.checkCanApply() || edits.length === 0) {
      this.intents = this.intents.filter((intent) => !ready.includes(intent));
      return;
    }
    // Parsing backlinks is asynchronous. Recheck the user's target edit before committing its repair.
    for (const intent of ready) {
      const file = app.vault.getFileByPath(intent.newPath);
      if (!file || await this.readCurrent(file) !== intent.expected) {
        return;
      }
    }
    if (!this.checkCanApply() || ready.some((intent) => !this.intents.includes(intent))) {
      return;
    }
    try {
      await this.applyEdits(edits, ready.flatMap((intent) => [intent.oldPath, intent.newPath]));
    } catch (error) {
      if (error instanceof RepairConflictError) {
        return;
      }
      throw error;
    }
    this.intents = this.intents.filter((intent) => !ready.includes(intent));
    this.params.notify(`Updated links: ${ready.map((intent) => `${intent.oldPath}${intent.oldSubpath} → ${intent.newPath}${intent.newSubpath}`).join(', ')}`, () => this.undo(edits));
  }

  private schedule(): void {
    if (this.isRunning) {
      this.shouldRunAgain = true;
      return;
    }
    this.isRunning = true;
    invokeAsyncSafely(async () => {
      try {
        do {
          this.shouldRunAgain = false;
          await this.repair();
        } while (this.shouldContinue());
      } finally {
        this.isRunning = false;
      }
    });
  }

  private shouldContinue(): boolean {
    return this.shouldRunAgain && this.isActive;
  }

  private async writeEdits(edits: readonly RepairFileEdit[]): Promise<void> {
    const { app, engine } = this.params;
    for (const edit of edits) {
      const file = app.vault.getFileByPath(edit.path);
      if (!file || await this.readCurrent(file) !== edit.before) {
        throw new RepairConflictError(`Cannot change ${edit.path}: it changed after the repair was prepared.`);
      }
    }
    this.isApplying = true;
    const written: RepairFileEdit[] = [];
    try {
      await engine.runInBatch(async () => {
        try {
          for (const edit of edits) {
            const file = ensureNonNullable(app.vault.getFileByPath(edit.path));
            await app.vault.process(file, (content) => {
              if (content !== edit.before) {
                throw new RepairConflictError(`Cannot change ${edit.path}: it was edited concurrently.`);
              }
              return edit.after;
            });
            written.push(edit);
          }
        } catch (error) {
          for (const edit of written.reverse()) {
            const file = app.vault.getFileByPath(edit.path);
            if (file) {
              await app.vault.process(file, (content) => content === edit.after ? edit.before : content);
            }
          }
          throw error;
        }
      });
    } finally {
      this.isApplying = false;
    }
  }
}

function captureRows(rows: readonly LinkRow[], path: string, cache: CachedMetadata | null, kind: 'block' | 'heading', offset: number): readonly LinkRow[] {
  return cache ? rows.filter((row) => row.target?.path === path && row.target.kind === kind && resolveSubpath(cache, row.target.subpath)?.start.offset === offset) : [];
}

function countEndpoints(cache: CachedMetadata, subpath: string, content: string): number {
  if (subpath.startsWith('#^')) {
    // The block cache retains just one entry for a duplicated id. Count textual occurrences too;
    // an id inside code can only make this conservative, never cause a wrong repair.
    const id = subpath.slice('#^'.length);
    return content.split('\n').filter((line) => line.trimEnd().endsWith(` ^${id}`) || line.trim() === `^${id}`).length;
  }
  return ensureNonNullable(cache.headings).filter((heading) => resolveSubpath({ ...cache, headings: [heading] }, subpath)?.type === 'heading').length;
}
