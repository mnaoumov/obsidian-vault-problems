import type {
  App,
  Reference,
  TFile
} from 'obsidian';

import { BrokenLinkCandidateFinder } from '@mnaoumov/obsidian-lib/broken-link-candidates';
import { loadGitRenames } from '@mnaoumov/obsidian-lib/git-rename-history';
import {
  editReferencesInContent,
  generateMarkdownLink,
  LinkStyle
} from '@mnaoumov/obsidian-lib/link';
import { parseMetadata } from '@mnaoumov/obsidian-lib/metadata-cache';
import { parseLink } from '@mnaoumov/obsidian-lib/parse-link';
import {
  createFolderSafe,
  readSafe
} from '@mnaoumov/obsidian-lib/vault';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { encodeUrl } from '@mnaoumov/typescript-lib/url';
import { isReferenceCache } from '@obsidian-typings/obsidian-public-latest/implementations';
import {
  FileSystemAdapter,
  normalizePath,
  parseFrontMatterAliases,
  parseLinktext,
  Platform,
  resolveSubpath
} from 'obsidian';

import type {
  AutoRepairComponent,
  RepairFileEdit
} from './auto-repair-component.ts';
import type {
  LinkProblem,
  LinkRow
} from './link-model.ts';
import type { SyntaxIssue } from './syntax-checks.ts';

import { removeReference } from './remove-reference.ts';
import { findSyntaxIssues } from './syntax-checks.ts';

const BLOCK_PREFIX_LENGTH = 2;
const BLOCK_PREVIEW_LENGTH = 60;

/**
An explicit, user-selected repair.
*/
export interface ProblemFix {
  readonly label: string;
  readonly run: () => Promise<void>;
}

/**
Dependencies shared by quick fixes and their single-operation undo.
*/
export interface ProblemFixesConstructorParams {
  readonly app: App;
  readonly getProblems: () => readonly LinkProblem[];
  readonly notify: (message: string, undo: () => Promise<void>) => void;
  readonly repairs: AutoRepairComponent;
}

interface FixTarget {
  readonly path: string;
  readonly subpath: string;
}

/**
Offers only repairs whose source and destination can be validated again at click time.
*/
export class ProblemFixes {
  private readonly params: ProblemFixesConstructorParams;

  public constructor(params: ProblemFixesConstructorParams) {
    this.params = params;
  }

  public async getFixes(problem: LinkProblem): Promise<ProblemFix[]> {
    const { app } = this.params;
    const { row } = problem;
    if (problem.syntax) {
      return this.getSyntaxFixes(row.sourcePath, problem.syntax);
    }
    // An HTML candidate comes from a lexical index; deleting markup on its word could lose content.
    if (problem.html) {
      return [];
    }
    const parsed = parseLinktext(decodeLink(row.link));
    const fixes: ProblemFix[] = [];
    const target = row.targetPath && app.vault.getFileByPath(row.targetPath);
    if (target) {
      fixes.push(...await this.getFragmentFixes(row, target, parsed.subpath));
    } else {
      fixes.push(...await this.getFileFixes(problem, parsed.subpath));
    }
    fixes.push({ label: 'Remove link, keep text', run: () => this.rewrite([row]) });
    return fixes;
  }

  private async commit(edits: readonly RepairFileEdit[]): Promise<void> {
    await this.params.repairs.applyEdits(edits);
    this.params.notify(`Applied quick fix in ${String(edits.length)} note(s)`, () => this.params.repairs.undo(edits));
  }

  private async createHeading(file: TFile, subpath: string): Promise<void> {
    const before = ensureNonNullable(await readSafe(this.params.app, file));
    const cache = await parseMetadata(this.params.app, before);
    if (resolveSubpath(cache, subpath)) {
      throw new Error('The heading already exists.');
    }
    await this.commit([{ after: `${before}\n\n# ${subpath.slice(1)}\n`, before, path: file.path }]);
  }

  private async createNote(path: string): Promise<void> {
    const folder = path.slice(0, path.lastIndexOf('/'));
    if (path.includes('/')) {
      await createFolderSafe(this.params.app, folder);
    }
    // Never overwrite a file that appeared after the menu opened.
    const file = await this.params.app.vault.create(path, '');
    this.params.notify(`Created ${file.path}`, async () => {
      if (await readSafe(this.params.app, file) !== '') {
        throw new Error('Cannot undo: the new note has been edited.');
      }
      await this.params.app.fileManager.trashFile(file);
    });
  }

  private async getFileFixes(problem: LinkProblem, subpath: string): Promise<ProblemFix[]> {
    const { app } = this.params;
    const { row } = problem;
    const fixes: ProblemFix[] = [];
    const path = missingPath(row);
    if (path) {
      const aliasesByPath = new Map<string, readonly string[]>();
      const titlesByPath = new Map<string, string>();
      for (const note of app.vault.getMarkdownFiles()) {
        const frontmatter = app.metadataCache.getFileCache(note)?.frontmatter;
        aliasesByPath.set(note.path, parseFrontMatterAliases(frontmatter) ?? []);
        const title: unknown = frontmatter?.['title'];
        if (typeof title === 'string') {
          titlesByPath.set(note.path, title);
        }
      }
      const gitRenames = await this.getGitRenames();
      // A live rename is stronger evidence than historical name similarity.
      for (const change of problem.cause?.kind === 'batch' ? problem.cause.changes ?? [] : (problem.cause ? [problem.cause] : [])) {
        if (change.oldPath === path && change.kind === 'rename') {
          gitRenames.set(path, { commit: 'the change that broke this link', newPath: change.path });
        }
      }
      const candidates = ensureNonNullable(new BrokenLinkCandidateFinder({ aliasesByPath, filePaths: app.vault.getFiles().map((file) => file.path), folderNoteFileNames: ['!.md', 'index.md'], gitRenames, titlesByPath }).findAll([path]).get(path));
      for (const candidate of candidates) {
        fixes.push({ label: `Use ${candidate.path} — ${candidate.evidence.map((evidence) => evidence.description).join(' ')}`, run: () => this.retarget([row], candidate.path, subpath) });
        const related = this.params.getProblems().filter((other) => other.row.kind !== 'syntax' && missingPath(other.row) === path && parseLinktext(decodeLink(other.row.link)).subpath === subpath).map((other) => other.row);
        if (related.length > 1) {
          fixes.push({ label: `Update ${String(related.length)} links to ${candidate.path}${subpath}`, run: () => this.retarget(related, candidate.path, subpath) });
        }
      }
      if (path.endsWith('.md') && !subpath) {
        fixes.push({ label: `Create ${path}`, run: () => this.createNote(path) });
      }
    }
    return fixes;
  }

  private async getFragmentFixes(row: LinkRow, target: TFile, missingSubpath: string): Promise<ProblemFix[]> {
    const { app } = this.params;
    const fixes: ProblemFix[] = [];
    const cache = app.metadataCache.getFileCache(target);
    for (const subpath of [...(cache?.headings ?? []).map((heading) => `#${heading.heading}`), ...Object.keys(cache?.blocks ?? {}).map((id) => `#^${id}`)]) {
      fixes.push({ label: `Use ${target.path}${subpath}`, run: () => this.retarget([row], target.path, subpath) });
    }
    if (missingSubpath.startsWith('#^')) {
      const id = missingSubpath.slice(BLOCK_PREFIX_LENGTH);
      if (/^[\w-]+$/u.test(id)) {
        const content = await readSafe(app, target);
        for (const section of cache?.sections ?? []) {
          if (section.type !== 'paragraph' || !content) {
            continue;
          }
          const end = section.position.end.offset;
          const text = content.slice(section.position.start.offset, end);
          if (/\^[\w-]+\s*$/u.test(text)) {
            continue;
          }
          const after = `${content.slice(0, end)} ^${id}${content.slice(end)}`;
          fixes.push({ label: `Restore ^${id} on “${text.slice(0, BLOCK_PREVIEW_LENGTH)}”`, run: () => this.commit([{ after, before: content, path: target.path }]) });
        }
      }
    } else if (/^#[^#\r\n]+$/u.test(missingSubpath)) {
      fixes.push({ label: `Create heading ${missingSubpath}`, run: () => this.createHeading(target, missingSubpath) });
    }
    return fixes;
  }

  private async getGitRenames(): Promise<Map<string, import('@mnaoumov/obsidian-lib/broken-link-candidates').GitRename>> {
    const { adapter } = this.params.app.vault;
    if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) {
      return new Map();
    }
    const { createDesktopGitRunner } = await import('./desktop-git-runner.ts');
    return await loadGitRenames({ runGit: createDesktopGitRunner(adapter.getBasePath()) });
  }

  private getSyntaxFixes(path: string, issue: SyntaxIssue): ProblemFix[] {
    const { fix } = issue;
    if (!fix) {
      return [];
    }
    return [{
      label: fix.label,
      run: async (): Promise<void> => {
        const file = this.params.app.vault.getFileByPath(path);
        const before = file ? await readSafe(this.params.app, file) : null;
        // Re-check at click time: the fix applies only to the text it was computed from.
        const current = before === null ? undefined : findSyntaxIssues(before).find((candidate) => candidate.code === issue.code && candidate.fix?.offset === fix.offset && candidate.fix.insert === fix.insert);
        if (before === null || !current) {
          throw new Error('The note changed since the problem was found. Open quick fixes again.');
        }
        await this.commit([{ after: before.slice(0, fix.offset) + fix.insert + before.slice(fix.offset), before, path }]);
      }
    }];
  }

  private async retarget(rows: readonly LinkRow[], path: string, subpath: string): Promise<void> {
    const file = this.params.app.vault.getFileByPath(path);
    if (!file || (subpath && !resolveSubpath(this.params.app.metadataCache.getFileCache(file) ?? {}, subpath))) {
      throw new Error('The selected target no longer exists.');
    }
    await this.rewrite(rows, { path, subpath });
  }

  private async rewrite(rows: readonly LinkRow[], target?: FixTarget): Promise<void> {
    const { app } = this.params;
    const edits: RepairFileEdit[] = [];
    for (const path of new Set(rows.map((row) => row.sourcePath))) {
      const file = ensureNonNullable(app.vault.getFileByPath(path));
      const before = ensureNonNullable(await readSafe(app, file));
      const selected = rows.filter((row) => row.sourcePath === path);
      // Refuse a stale UI row rather than editing a neighboring link after the user types.
      const originalCache = await parseMetadata(app, before);
      const selectedDefinitions = (originalCache.referenceLinks ?? []).filter((reference) => selected.some((row) => row.kind === 'reference' && row.link === reference.link && row.position?.start.offset === reference.position.start.offset));
      // Body links and definitions are rewritten in one pass against the same metadata, so offsets stay consistent.
      let after = await editReferencesInContent({
        app,
        content: before,
        referenceConverter: (reference) => {
          if (selected.every((row) => !isMatchingReference(row, reference))) {
            return;
          }
          const parsed = parseLink(reference.original);
          return target ? generateMarkdownLink({ app, originalLink: reference.original, sourcePathOrFile: file, subpath: target.subpath, targetPathOrFile: target.path, ...(parsed?.alias !== undefined && { alias: parsed.alias }) }) : parsed?.alias ?? reference.link;
        },
        referenceDefinitionConverter: (definition) => {
          const isSelected = selectedDefinitions.some((selectedDefinition) => selectedDefinition.link === definition.link && selectedDefinition.position.start.offset === definition.position.start.offset);
          if (!target || !isSelected) {
            return;
          }
          const generated = generateMarkdownLink({
            alias: 'reference',
            app,
            linkStyle: LinkStyle.Markdown,
            originalLink: `[reference](<${definition.link}>)`,
            sourcePathOrFile: file,
            subpath: target.subpath,
            targetPathOrFile: target.path
          });
          return encodeUrl(ensureNonNullable(parseLink(generated)).url, true);
        }
      });
      if (!target) {
        for (const reference of selectedDefinitions) {
          after = removeReference(after, reference);
        }
      }
      if (after !== before) {
        edits.push({ after, before, path });
      }
    }
    if (edits.length === 0) {
      throw new Error('This problem changed. Refresh the Problems view and try again.');
    }
    await this.commit(edits);
  }
}

function decodeLink(link: string): string {
  try {
    return decodeURI(link);
  } catch {
    return link;
  }
}

function isMatchingReference(row: LinkRow, reference: Reference): boolean {
  return row.kind !== 'reference' && row.link === reference.link && (isReferenceCache(reference) ? row.position?.start.offset === reference.position.start.offset : 'key' in reference && row.key === reference.key);
}

function missingPath(row: LinkRow): null | string {
  const { path } = parseLinktext(decodeLink(row.link));
  if (!path || /[:*?"<>|\p{Cc}]/u.test(path)) {
    return null;
  }
  const base = path.startsWith('./') || path.startsWith('../') ? row.sourcePath.slice(0, row.sourcePath.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  for (const part of (base + path).split('/')) {
    if (part === '..') {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
    } else if (part && part !== '.') {
      parts.push(part);
    }
  }
  const result = normalizePath(parts.join('/'));
  return /\.[^/]+$/u.test(result) ? result : `${result}.md`;
}
