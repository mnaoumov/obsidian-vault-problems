import type { GitRename } from '@mnaoumov/obsidian-lib/broken-link-candidates';
import type {
  App,
  Reference,
  TFile
} from 'obsidian';

import {
  BrokenLinkCandidateFinder,
  BrokenLinkEvidenceKind
} from '@mnaoumov/obsidian-lib/broken-link-candidates';
import {
  isFile,
  isFolder
} from '@mnaoumov/obsidian-lib/file-system';
import { loadGitRenames } from '@mnaoumov/obsidian-lib/git-rename-history';
import {
  editReferencesInContent,
  generateMarkdownLink,
  LinkStyle
} from '@mnaoumov/obsidian-lib/link';
import { parseMetadata } from '@mnaoumov/obsidian-lib/metadata-cache';
import { getAttachmentPlacement } from '@mnaoumov/obsidian-lib/misplaced-attachment';
import { parseLink } from '@mnaoumov/obsidian-lib/parse-link';
import { repairName } from '@mnaoumov/obsidian-lib/path-compatibility';
import {
  createFolderSafe,
  readSafe
} from '@mnaoumov/obsidian-lib/vault';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { encodeUrl } from '@mnaoumov/typescript-lib/url';
import { isReferenceCache } from '@obsidian-typings/obsidian-public-latest/implementations';
import {
  FileSystemAdapter,
  parseLinktext,
  Platform,
  resolveSubpath
} from 'obsidian';

import type {
  AutoRepairComponent,
  RepairFileEdit
} from './auto-repair-component.ts';
import type {
  LinkChange,
  LinkProblem,
  LinkRow,
  MisplacedAttachment
} from './link-model.ts';
import type { PathCompatibilityScope } from './path-compatibility-component.ts';
import type {
  SyntaxFix,
  SyntaxIssue
} from './syntax-checks.ts';

import {
  findUnambiguousFragment,
  rankFragmentCandidates
} from './fragment-candidates.ts';
import {
  decodeLink,
  getMissingPath,
  LINK_ROW_KINDS,
  MissingTargetClassifier
} from './missing-targets.ts';
import { removeReference } from './remove-reference.ts';
import { findSyntaxIssues } from './syntax-checks.ts';

const BLOCK_PREFIX_LENGTH = 2;
const BLOCK_PREVIEW_LENGTH = 60;

/**
The rules a repaired name is held to, and what replaces each forbidden character.
*/
export interface PathRepairScope extends PathCompatibilityScope {
  /**
  What each forbidden character is replaced with; empty deletes it.
  */
  readonly forbiddenCharacterReplacement: string;
}

/**
One problem's repair in a batch, as the preview names it.
*/
export interface PlannedFix {
  readonly label: string;
  readonly problem: LinkProblem;
}

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
  /**
  Read when the fixes are offered, so a repaired name follows the current settings.
  */
  readonly getPathRepairScope: () => PathRepairScope;
  readonly getProblems: () => readonly LinkProblem[];
  readonly notify: (message: string, undo: () => Promise<void>) => void;
  readonly repairs: AutoRepairComponent;
}

/**
The repairs of every problem that has exactly one, ready to write as one Undo step.
*/
export interface UnambiguousFixPlan {
  /**
  One compare-and-swap edit per note.
  */
  readonly edits: readonly RepairFileEdit[];
  /**
  The fixes those edits carry, in note order.
  */
  readonly fixes: readonly PlannedFix[];
}

type FixIntent = RetargetIntent | SyntaxIntent;

interface FixTarget {
  readonly path: string;
  readonly subpath: string;
}

interface RetargetIntent {
  readonly kind: 'retarget';
  readonly label: string;
  readonly problem: LinkProblem;
  readonly target: FixTarget;
}

interface RowSelection {
  readonly row: LinkRow;
  /**
  Where the link should point; none removes the link and keeps its text.
  */
  readonly target?: FixTarget;
}

interface SyntaxIntent {
  readonly fix: SyntaxFix;
  readonly issue: SyntaxIssue;
  readonly kind: 'syntax';
  readonly label: string;
  readonly problem: LinkProblem;
}

/**
Offers only repairs whose source and destination can be validated again at click time.
*/
export class ProblemFixes {
  private readonly params: ProblemFixesConstructorParams;

  public constructor(params: ProblemFixesConstructorParams) {
    this.params = params;
  }

  /**
  Writes a plan made by {@link planUnambiguousFixes} as one repair journal entry, with one notice and one Undo.

  Each note is written only if it still holds the content the plan was made from, so nothing typed since is lost.

  @param plan - The plan.
  */
  public async applyPlan(plan: UnambiguousFixPlan): Promise<void> {
    if (plan.edits.length === 0) {
      return;
    }
    await this.params.repairs.applyEdits(plan.edits);
    this.params.notify(`Applied ${String(plan.fixes.length)} quick fix(es) in ${String(plan.edits.length)} note(s)`, () => this.params.repairs.undo(plan.edits));
  }

  public async getFixes(problem: LinkProblem): Promise<ProblemFix[]> {
    const { app } = this.params;
    const { row } = problem;
    if (problem.syntax) {
      return this.getSyntaxFixes(row.sourcePath, problem.syntax);
    }
    if (problem.pathViolation) {
      return this.getPathFixes(row.sourcePath);
    }
    if (problem.misplacedAttachment) {
      return this.getMisplacedAttachmentFixes(row.sourcePath, problem.misplacedAttachment);
    }
    if (problem.missingCommunityPluginId !== undefined) {
      return this.getCommunityPluginFixes(problem.missingCommunityPluginId);
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

  /**
  Plans the one repair of every given problem that has exactly one, without writing anything.

  A problem qualifies when its repair is a content edit with no choice to make: a link to a missing file with exactly
  one candidate whose evidence is stronger than a near-miss name, a link to a missing heading or block with exactly one
  close match of its kind in the target note ({@link findUnambiguousFragment}), or a syntax issue that carries its fix.
  File renames, attachment moves and plugin list changes are never batched, and neither is anything with several
  candidates; those stay in the Problems view for an explicit choice.

  @param problems - The problems to consider, such as those the Problems view shows.
  @returns One edit per note, and the fixes they carry.
  */
  public async planUnambiguousFixes(problems: readonly LinkProblem[]): Promise<UnambiguousFixPlan> {
    const { app } = this.params;
    const intents: FixIntent[] = [];
    const fileProblems: LinkProblem[] = [];
    for (const problem of problems) {
      if (problem.syntax) {
        if (problem.syntax.fix) {
          intents.push({ fix: problem.syntax.fix, issue: problem.syntax, kind: 'syntax', label: problem.syntax.fix.label, problem });
        }
        continue;
      }
      if (!LINK_ROW_KINDS.has(problem.row.kind) || problem.html || problem.misplacedAttachment || problem.pathViolation) {
        continue;
      }
      const { row } = problem;
      const { subpath } = parseLinktext(decodeLink(row.link));
      const target = row.targetPath && app.vault.getFileByPath(row.targetPath);
      if (target) {
        const cache = app.metadataCache.getFileCache(target) ?? {};
        // The candidate is one of the note's own headings or blocks, so it resolves.
        const fragment = findUnambiguousFragment(subpath, (cache.headings ?? []).map((heading) => heading.heading), Object.keys(cache.blocks ?? {}));
        if (fragment) {
          intents.push({ kind: 'retarget', label: `Use ${target.path}${fragment}`, problem, target: { path: target.path, subpath: fragment } });
        }
      } else if (getMissingPath(row)) {
        fileProblems.push(problem);
      }
    }
    intents.push(...await this.planMissingFileFixes(fileProblems));
    return this.buildPlan(intents);
  }

  private async buildPlan(intents: readonly FixIntent[]): Promise<UnambiguousFixPlan> {
    const { app } = this.params;
    const edits: RepairFileEdit[] = [];
    const fixes: PlannedFix[] = [];
    for (const path of new Set(intents.map((intent) => intent.problem.row.sourcePath))) {
      const file = app.vault.getFileByPath(path);
      // A note deleted since its problem was found has nothing left to fix.
      if (!file) {
        continue;
      }
      const before = ensureNonNullable(await readSafe(app, file));
      // In document order, so the preview reads down the note.
      const fileIntents = intents.filter((intent) => intent.problem.row.sourcePath === path)
        .sort((a, b) => getRowOffset(a.problem.row) - getRowOffset(b.problem.row));
      const applied = new Set<FixIntent>();
      const selections = new Map<RowSelection, FixIntent>();
      for (const intent of fileIntents) {
        if (intent.kind === 'retarget') {
          selections.set({ row: intent.problem.row, target: intent.target }, intent);
        }
      }
      let after = selections.size > 0
        ? await this.rewriteContent(file, before, [...selections.keys()], (selection) => {
          applied.add(ensureNonNullable(selections.get(selection)));
        })
        : before;
      after = applySyntaxFixes(after, fileIntents.filter((intent): intent is SyntaxIntent => intent.kind === 'syntax'), applied);
      if (after === before) {
        continue;
      }
      edits.push({ after, before, path });
      for (const intent of fileIntents) {
        if (applied.has(intent)) {
          fixes.push({ label: intent.label, problem: intent.problem });
        }
      }
    }
    return { edits, fixes };
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

  /**
  Removes the id through Obsidian's own registry, which rewrites `community-plugins.json`; the file is never edited by
  hand while Obsidian holds the list in memory.
  */
  private getCommunityPluginFixes(id: string): ProblemFix[] {
    const { plugins } = this.params.app;
    if (!isMissingCommunityPlugin(this.params.app, id)) {
      return [];
    }
    return [{
      label: `Remove ${id} from the enabled community plugins`,
      run: async (): Promise<void> => {
        // Re-check at click time: the plugin may have been installed, or the id removed, since the menu opened.
        if (!isMissingCommunityPlugin(this.params.app, id)) {
          throw new Error('The enabled community plugins changed since the problem was found. Open quick fixes again.');
        }
        await plugins.disablePluginAndSave(id);
        // `disablePluginAndSave` saves on a debounce; write the list now, so the fix is on disk when it reports done.
        await plugins.saveConfig();
        this.params.notify(`Removed ${id} from the enabled community plugins`, async () => {
          if (plugins.enabledPlugins.has(id) || Object.hasOwn(plugins.manifests, id)) {
            throw new Error(`Cannot undo: ${id} has been enabled or installed since.`);
          }
          plugins.enabledPlugins.add(id);
          await plugins.saveConfig();
          plugins.trigger('changed');
        });
      }
    }];
  }

  private async getFileFixes(problem: LinkProblem, subpath: string): Promise<ProblemFix[]> {
    const { app } = this.params;
    const { row } = problem;
    const fixes: ProblemFix[] = [];
    const path = getMissingPath(row);
    if (path) {
      const gitRenames = await this.getGitRenames();
      // A live rename is stronger evidence than historical name similarity.
      for (const change of problem.cause?.kind === 'batch' ? problem.cause.changes ?? [] : (problem.cause ? [problem.cause] : [])) {
        if (change.oldPath === path && change.kind === 'rename') {
          gitRenames.set(path, { commit: 'the change that broke this link', newPath: change.path });
        }
      }
      const candidates = ensureNonNullable(new BrokenLinkCandidateFinder(new MissingTargetClassifier(app).collectSnapshot(gitRenames)).findAll([path]).get(path));
      for (const candidate of candidates) {
        fixes.push({ label: `Use ${candidate.path} — ${candidate.evidence.map((evidence) => evidence.description).join(' ')}`, run: () => this.retarget([row], candidate.path, subpath) });
        const related = this.params.getProblems().filter((other) => LINK_ROW_KINDS.has(other.row.kind) && getMissingPath(other.row) === path && parseLinktext(decodeLink(other.row.link)).subpath === subpath).map((other) => other.row);
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
    for (const subpath of rankFragmentCandidates(missingSubpath, (cache?.headings ?? []).map((heading) => heading.heading), Object.keys(cache?.blocks ?? {}))) {
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

  private async getGitRenames(): Promise<Map<string, GitRename>> {
    const { adapter } = this.params.app.vault;
    if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) {
      return new Map();
    }
    const { createDesktopGitRunner } = await import('./desktop-git-runner.ts');
    return await loadGitRenames({ runGit: createDesktopGitRunner(adapter.getBasePath()) });
  }

  /**
  The move is recomputed when offered, so a note's attachment folder changed since the check is honoured.
  */
  private async getMisplacedAttachmentFixes(notePath: string, misplacedAttachment: MisplacedAttachment): Promise<ProblemFix[]> {
    const attachmentFile = this.params.app.vault.getFileByPath(misplacedAttachment.attachmentPath);
    if (!attachmentFile) {
      return [];
    }
    const placement = await getAttachmentPlacement({ app: this.params.app, attachmentFile, notePath });
    if (placement.isInProperFolder) {
      return [];
    }
    const folder = placement.properAttachmentFolderPath;
    const newPath = folder === '/' ? attachmentFile.name : `${folder}/${attachmentFile.name}`;
    return [{ label: `Move ${attachmentFile.name} to ${folder}`, run: () => this.move(attachmentFile.path, newPath) }];
  }

  private getPathFixes(path: string): ProblemFix[] {
    const file = this.params.app.vault.getAbstractFileByPath(path);
    if (!file) {
      return [];
    }
    const scope = this.params.getPathRepairScope();
    const parentPath = getParentPath(path);
    const newName = repairName({
      basename: isFile(file) ? file.basename : file.name,
      extension: isFile(file) ? file.extension : '',
      forbiddenCharacterReplacement: scope.forbiddenCharacterReplacement,
      isFolder: isFolder(file),
      maxVaultRootPathLength: scope.maxVaultRootPathLength,
      parentPath,
      platforms: scope.platforms
    });
    // No name survives the repair, or the platforms that object have been turned off since the check.
    return newName === null || newName === file.name ? [] : [{ label: `Rename to ${newName}`, run: () => this.move(path, parentPath ? `${parentPath}/${newName}` : newName) }];
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

  /**
  Renames through the file manager, so Obsidian updates every link to the file, and offers to rename it back.
  */
  private async move(oldPath: string, newPath: string): Promise<void> {
    const { app } = this.params;
    const file = app.vault.getAbstractFileByPath(oldPath);
    if (!file) {
      throw new Error('The file changed since the problem was found. Open quick fixes again.');
    }
    if (app.vault.getAbstractFileByPath(newPath)) {
      throw new Error(`Cannot move to ${newPath}: it already exists.`);
    }
    const parentPath = getParentPath(newPath);
    if (parentPath) {
      await createFolderSafe(app, parentPath);
    }
    await app.fileManager.renameFile(file, newPath);
    this.params.notify(`Moved ${oldPath} to ${newPath}`, async () => {
      const moved = app.vault.getAbstractFileByPath(newPath);
      if (!moved || app.vault.getAbstractFileByPath(oldPath)) {
        throw new Error('Cannot undo: the file has moved again, or its old path is taken.');
      }
      await app.fileManager.renameFile(moved, oldPath);
    });
  }

  /**
  The links to missing files that have exactly one candidate, found in one pass over the vault.
  */
  private async planMissingFileFixes(problems: readonly LinkProblem[]): Promise<FixIntent[]> {
    if (problems.length === 0) {
      return [];
    }
    const { app } = this.params;
    const gitRenames = await this.getGitRenames();
    addCausalRenames(gitRenames, problems);
    const paths = [...new Set(problems.map((problem) => ensureNonNullable(getMissingPath(problem.row))))];
    const candidatesByPath = new BrokenLinkCandidateFinder(new MissingTargetClassifier(app).collectSnapshot(gitRenames)).findAll(paths);
    const intents: FixIntent[] = [];
    for (const problem of problems) {
      const candidates = ensureNonNullable(candidatesByPath.get(ensureNonNullable(getMissingPath(problem.row))));
      const [candidate] = candidates;
      if (candidates.length !== 1 || !candidate || candidate.evidence.every((evidence) => evidence.kind === BrokenLinkEvidenceKind.NearMiss)) {
        continue;
      }
      const { subpath } = parseLinktext(decodeLink(problem.row.link));
      const file = ensureNonNullable(app.vault.getFileByPath(candidate.path));
      // A fragment the candidate does not hold would trade one broken link for another.
      if (subpath && !resolveSubpath(app.metadataCache.getFileCache(file) ?? {}, subpath)) {
        continue;
      }
      intents.push({ kind: 'retarget', label: `Use ${candidate.path}${subpath} — ${candidate.evidence.map((evidence) => evidence.description).join(' ')}`, problem, target: { path: candidate.path, subpath } });
    }
    return intents;
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
      const selections = rows.filter((row) => row.sourcePath === path).map((row): RowSelection => ({ row, ...(target && { target }) }));
      const after = await this.rewriteContent(file, before, selections);
      if (after !== before) {
        edits.push({ after, before, path });
      }
    }
    if (edits.length === 0) {
      throw new Error('This problem changed. Refresh the Problems view and try again.');
    }
    await this.commit(edits);
  }

  /**
  Rewrites the selected links of one note, each to its own target, or removes those with no target, keeping the text.

  @param file - The note.
  @param before - Its current content.
  @param selections - Its rows to rewrite.
  @param onMatched - Told about each selection whose link was found in the content.
  @returns The rewritten content.
  */
  private async rewriteContent(file: TFile, before: string, selections: readonly RowSelection[], onMatched?: (selection: RowSelection) => void): Promise<string> {
    const { app } = this.params;
    // Refuse a stale UI row rather than editing a neighboring link after the user types.
    const originalCache = await parseMetadata(app, before);
    const definitionSelections = new Map<number, RowSelection>();
    for (const definition of originalCache.referenceLinks ?? []) {
      const selection = selections.find(({ row }) => row.kind === 'reference' && row.link === definition.link && row.position?.start.offset === definition.position.start.offset);
      if (selection) {
        definitionSelections.set(definition.position.start.offset, selection);
      }
    }
    // Body links and definitions are rewritten in one pass against the same metadata, so offsets stay consistent.
    let after = await editReferencesInContent({
      app,
      content: before,
      referenceConverter: (reference) => {
        const selection = selections.find(({ row }) => isMatchingReference(row, reference));
        if (!selection) {
          return;
        }
        onMatched?.(selection);
        const { target } = selection;
        const parsed = parseLink(reference.original);
        return target ? generateMarkdownLink({ app, originalLink: reference.original, sourcePathOrFile: file, subpath: target.subpath, targetPathOrFile: target.path, ...(parsed?.alias !== undefined && { alias: parsed.alias }) }) : parsed?.alias ?? reference.link;
      },
      referenceDefinitionConverter: (definition) => {
        const selection = definitionSelections.get(definition.position.start.offset);
        if (selection?.row.link !== definition.link || !selection.target) {
          return;
        }
        onMatched?.(selection);
        const generated = generateMarkdownLink({
          alias: 'reference',
          app,
          linkStyle: LinkStyle.Markdown,
          originalLink: `[reference](<${definition.link}>)`,
          sourcePathOrFile: file,
          subpath: selection.target.subpath,
          targetPathOrFile: selection.target.path
        });
        return encodeUrl(ensureNonNullable(parseLink(generated)).url, true);
      }
    });
    const removed = (originalCache.referenceLinks ?? []).filter((definition) => {
      const selection = definitionSelections.get(definition.position.start.offset);
      return selection?.row.link === definition.link && !selection.target;
    });
    for (const reference of removed) {
      onMatched?.(ensureNonNullable(definitionSelections.get(reference.position.start.offset)));
      after = removeReference(after, reference);
    }
    return after;
  }
}

/**
Adds the renames that broke the given links to the git renames, as the strongest evidence; two different renames of
one path cancel out, leaving neither.
*/
function addCausalRenames(gitRenames: Map<string, GitRename>, problems: readonly LinkProblem[]): void {
  const causalRenames = new Map<string, null | string>();
  for (const problem of problems) {
    for (const change of getCauseChanges(problem)) {
      if (!(change.kind === 'rename' && change.oldPath)) {
        continue;
      }

      const known = causalRenames.get(change.oldPath);
      causalRenames.set(change.oldPath, known === undefined || known === change.path ? change.path : null);
    }
  }
  for (const [oldPath, newPath] of causalRenames) {
    if (newPath === null) {
      gitRenames.delete(oldPath);
    } else {
      gitRenames.set(oldPath, { commit: 'the change that broke this link', newPath });
    }
  }
}

/**
Applies the planned syntax fixes to text that other fixes may already have edited.

Each fix is found again in the current text, by its check, its insertion and its line, so offsets shifted by a link
rewrite or an earlier insertion never misplace it; a fix no longer found is skipped.
*/
function applySyntaxFixes(content: string, intents: readonly SyntaxIntent[], applied: Set<FixIntent>): string {
  let result = content;
  for (const intent of intents) {
    const fix = findSyntaxIssues(result).find((issue) => issue.code === intent.issue.code && issue.fix?.insert === intent.fix.insert && issue.position.start.line === intent.issue.position.start.line)?.fix;
    if (!fix) {
      continue;
    }
    result = result.slice(0, fix.offset) + fix.insert + result.slice(fix.offset);
    applied.add(intent);
  }
  return result;
}

function getCauseChanges(problem: LinkProblem): readonly LinkChange[] {
  if (!problem.cause) {
    return [];
  }
  return problem.cause.kind === 'batch' ? problem.cause.changes ?? [] : [problem.cause];
}

function getParentPath(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/**
Where a row starts in its note; a frontmatter link has no range and counts as the start.
*/
function getRowOffset(row: LinkRow): number {
  return row.position?.start.offset ?? 0;
}

function isMatchingReference(row: LinkRow, reference: Reference): boolean {
  return row.kind !== 'reference' && row.link === reference.link && (isReferenceCache(reference) ? row.position?.start.offset === reference.position.start.offset : 'key' in reference && row.key === reference.key);
}

function isMissingCommunityPlugin(app: App, id: string): boolean {
  return app.plugins.enabledPlugins.has(id) && !Object.hasOwn(app.plugins.manifests, id);
}
