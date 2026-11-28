import type {
  BrokenLinkCandidateFinderConstructorParams,
  GitRename
} from '@mnaoumov/obsidian-lib/broken-link-candidates';
import type {
  App,
  FrontMatterCache
} from 'obsidian';

import { BrokenLinkCandidateFinder } from '@mnaoumov/obsidian-lib/broken-link-candidates';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import {
  normalizePath,
  parseFrontMatterAliases,
  parseLinktext
} from 'obsidian';

import type {
  LinkProblem,
  LinkRow
} from './link-model.ts';

/**
The file names a folder note is stored under, which say nothing about which note it is.
*/
export const FOLDER_NOTE_FILE_NAMES: readonly string[] = ['!.md', 'index.md'];

/**
The row kinds that are references, as opposed to findings about text, names or placement.
*/
export const LINK_ROW_KINDS: ReadonlySet<LinkRow['kind']> = new Set<LinkRow['kind']>(['embed', 'frontmatter', 'link', 'reference']);

/**
What a link to a file that does not exist most likely is.

A near miss has a candidate file the link probably meant: a typo, a rename, a moved note. A planned note has none,
so it is most likely a note not written yet, which a vault of intentional unresolved links holds by the hundred.
*/
export type MissingTargetClass = 'near-miss' | 'planned';

/**
The labels the Problems view shows for each class.
*/
export const MISSING_TARGET_CLASS_LABELS: Readonly<Record<MissingTargetClass, string>> = {
  'near-miss': 'Near miss',
  'planned': 'Planned note'
};

/**
Classifies the missing-file links of a problem list, keeping each answer until the vault changes in a way that can
change it: a file created, deleted or renamed, or a note's aliases or title edited.

Git renames are deliberately left out: they load only when the user asks for fixes, and a link with git evidence
still has a near-miss candidate when its new name is close, so the split stays useful without them.
*/
export class MissingTargetClassifier {
  private readonly classes = new Map<string, MissingTargetClass>();
  /**
  Each note's aliases and title as last indexed, so an edit elsewhere in a note keeps the cache.
  */
  private readonly nameSignatures = new Map<string, string>();

  public constructor(private readonly app: App) {}

  /**
  Returns the class of every problem that is a link to a missing file; other problems are absent.
  */
  public classify(problems: readonly LinkProblem[]): Map<LinkProblem, MissingTargetClass> {
    const pathsByProblem = new Map<LinkProblem, string>();
    for (const problem of problems) {
      const path = getMissingFilePath(problem);
      if (path !== null) {
        pathsByProblem.set(problem, path);
      }
    }
    const unknownPaths = new Set([...pathsByProblem.values()].filter((path) => !this.classes.has(path)));
    if (unknownPaths.size > 0) {
      for (const [path, candidates] of new BrokenLinkCandidateFinder(this.collectSnapshot(new Map())).findAll(unknownPaths)) {
        this.classes.set(path, candidates.length > 0 ? 'near-miss' : 'planned');
      }
    }
    const result = new Map<LinkProblem, MissingTargetClass>();
    for (const [problem, path] of pathsByProblem) {
      result.set(problem, ensureNonNullable(this.classes.get(path)));
    }
    return result;
  }

  /**
  Builds the finder's vault snapshot, and records each note's aliases and title for {@link onMetadataChanged}.
  */
  public collectSnapshot(gitRenames: ReadonlyMap<string, GitRename>): BrokenLinkCandidateFinderConstructorParams {
    const aliasesByPath = new Map<string, readonly string[]>();
    const titlesByPath = new Map<string, string>();
    this.nameSignatures.clear();
    for (const note of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter;
      const aliases = parseFrontMatterAliases(frontmatter) ?? [];
      const title = getTitle(frontmatter);
      aliasesByPath.set(note.path, aliases);
      if (title !== null) {
        titlesByPath.set(note.path, title);
      }
      const signature = getNameSignature(aliases, title);
      if (signature) {
        this.nameSignatures.set(note.path, signature);
      }
    }
    return { aliasesByPath, filePaths: this.app.vault.getFiles().map((file) => file.path), folderNoteFileNames: FOLDER_NOTE_FILE_NAMES, gitRenames, titlesByPath };
  }

  /**
  Forgets every answer, after a file is created, deleted or renamed.
  */
  public invalidate(): void {
    this.classes.clear();
  }

  /**
  Forgets every answer when a note's aliases or title changed, and keeps them after any other edit.
  */
  public onMetadataChanged(path: string, frontmatter: FrontMatterCache | undefined): void {
    const signature = getNameSignature(parseFrontMatterAliases(frontmatter) ?? [], getTitle(frontmatter));
    if (signature === (this.nameSignatures.get(path) ?? '')) {
      return;
    }
    this.nameSignatures.set(path, signature);
    this.invalidate();
  }
}

/**
Decodes a link's percent-encoding, keeping the text as it is when it is not valid encoding.
*/
export function decodeLink(link: string): string {
  try {
    return decodeURI(link);
  } catch {
    return link;
  }
}

/**
The vault path a problem's link leads to when it is a link to a file that does not exist; `null` for every other
problem, including a link whose file exists and only its heading or block is missing.
*/
export function getMissingFilePath(problem: LinkProblem): null | string {
  const { row } = problem;
  const isMissingFile = LINK_ROW_KINDS.has(row.kind) && row.targetPath === null && !problem.misplacedAttachment;
  return isMissingFile ? getMissingPath(row) : null;
}

/**
The vault path a link's text names, resolved against its source note when it is relative, with `.md` added when it
has no extension; `null` when the text names no valid vault path.
*/
export function getMissingPath(row: LinkRow): null | string {
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

function getNameSignature(aliases: readonly string[], title: null | string): string {
  return aliases.length === 0 && title === null ? '' : JSON.stringify([aliases, title]);
}

function getTitle(frontmatter: FrontMatterCache | undefined): null | string {
  const title: unknown = frontmatter?.['title'];
  return typeof title === 'string' ? title : null;
}
