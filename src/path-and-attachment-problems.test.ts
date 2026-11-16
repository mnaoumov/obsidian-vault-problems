import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  App as AppOriginal,
  CachedMetadata,
  Pos,
  Reference
} from 'obsidian';

import { ExternalAttachmentLinkMode } from '@mnaoumov/obsidian-lib/misplaced-attachment';
import {
  PathCompatibilityPlatform,
  PathCompatibilityViolationType
} from '@mnaoumov/obsidian-lib/path-compatibility';
import { ResourceLockComponent } from '@mnaoumov/obsidian-lib/resource-lock';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { LinkProblem } from './link-model.ts';
import type { PathRepairScope } from './problem-fixes.ts';

import { AutoRepairComponent } from './auto-repair-component.ts';
import { LinkEngine } from './link-engine.ts';
import { MisplacedAttachmentComponent } from './misplaced-attachment-component.ts';
import { PathCompatibilityComponent } from './path-compatibility-component.ts';
import {
  isWarningProblem,
  PROBLEM_KIND_LABELS
} from './problem-filter.ts';
import { ProblemFixes } from './problem-fixes.ts';

interface Fixture {
  readonly app: AppOriginal;
  readonly caches: Map<string, CachedMetadata>;
  readonly engine: LinkEngine;
  readonly fixes: ProblemFixes;
  readonly getScope: () => PathRepairScope;
  readonly notify: ReturnType<typeof vi.fn<(message: string, undo: () => Promise<void>) => void>>;
  readonly ready: () => void;
  readonly setScope: (scope: PathRepairScope) => void;
}

const WINDOWS: PathRepairScope = { forbiddenCharacterReplacement: '-', maxVaultRootPathLength: 10, platforms: [PathCompatibilityPlatform.Windows] };

async function fixture(files: Readonly<Record<string, string>> = {}): Promise<Fixture> {
  const app = App.createConfigured__().asOriginalType__();
  const caches = new Map<string, CachedMetadata>();
  for (const [path, content] of Object.entries(files)) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && !app.vault.getFolderByPath(parent)) {
      await app.vault.createFolder(parent);
    }
    await app.vault.create(path, content);
    if (path.endsWith('.md')) {
      caches.set(path, metadata(content));
    }
  }
  vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((file) => caches.get(file.path) ?? {});
  vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((path) => app.vault.getFileByPath(path) ?? app.vault.getFileByPath(`${path}.md`));
  app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [] });
  let ready: (() => void) | undefined;
  vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation((callback) => {
    ready = callback;
  });
  const engine = new LinkEngine({ app, notify: vi.fn() });
  engine.initialize();
  const notify = vi.fn<(message: string, undo: () => Promise<void>) => void>();
  let scope = WINDOWS;
  function getScope(): PathRepairScope {
    return scope;
  }
  function setScope(value: PathRepairScope): void {
    scope = value;
  }
  const repairs = new AutoRepairComponent({ app, engine, isEnabled: (): boolean => false, notify, resourceLockComponent: new ResourceLockComponent(app, 'vault-problems') });
  const fixes = new ProblemFixes({ app, getPathRepairScope: getScope, getProblems: (): readonly LinkProblem[] => engine.getAllProblems(), notify, repairs });
  return {
    app,
    caches,
    engine,
    fixes,
    getScope,
    notify,
    ready: (): void => {
      ensureNonNullable(ready)();
    },
    setScope
  };
}

function kindProblems(engine: LinkEngine, kind: LinkProblem['row']['kind']): LinkProblem[] {
  return engine.getAllProblems().filter((problem) => problem.row.kind === kind);
}

function metadata(content: string): CachedMetadata {
  return {
    embeds: [...content.matchAll(/!\[\[(?<link>[^\]]+)\]\]/gu)].map((match) => ({ link: ensureNonNullable(match.groups?.['link']), original: match[0], position: position(match.index, match.index + match[0].length) }))
  };
}

function position(start: number, end: number): Pos {
  return { end: { col: end, line: 0, offset: end }, start: { col: start, line: 0, offset: start } };
}

describe('Path problem labels', () => {
  it('names both new kinds and treats a misplaced attachment as a warning', () => {
    expect(PROBLEM_KIND_LABELS.path).toBe('Path compatibility');
    expect(PROBLEM_KIND_LABELS['misplaced-attachment']).toBe('Misplaced attachments');
    expect(isWarningProblem(castTo<LinkProblem>({ misplacedAttachment: { attachmentPath: 'a.png', properAttachmentFolderPath: '/' } }))).toBe(true);
    expect(isWarningProblem(castTo<LinkProblem>({}))).toBe(false);
  });
});

describe('LinkEngine path problems', () => {
  it.each([
    [{ characters: [':'], platform: PathCompatibilityPlatform.Windows, type: PathCompatibilityViolationType.ForbiddenCharacter }, 'Windows cannot store a name holding ":"'],
    [{ measurement: { isInBytes: true, length: 300, limit: 255, vaultRootLength: null }, platform: PathCompatibilityPlatform.Linux, type: PathCompatibilityViolationType.NameTooLong }, 'cannot store a name this long: 300 of at most 255 bytes'],
    [{ characters: ['#'], platform: null, type: PathCompatibilityViolationType.ObsidianForbiddenCharacter }, 'Obsidian links do not work with a name holding "#"'],
    [{ measurement: { isInBytes: false, length: 270, limit: 260, vaultRootLength: 10 }, platform: PathCompatibilityPlatform.Windows, type: PathCompatibilityViolationType.PathTooLong }, 'counting the vault root: 270 of at most 260 characters'],
    [{ platform: PathCompatibilityPlatform.Windows, type: PathCompatibilityViolationType.ReservedName }, 'reserves this name for a device'],
    [{ platform: PathCompatibilityPlatform.Windows, type: PathCompatibilityViolationType.TrailingCharacter }, 'ending in a dot or a space'],
    [{ platform: null, type: PathCompatibilityViolationType.UnicodeNotNormalized }, 'Unicode NFC']
  ])('describes %j', async (violation, message) => {
    const { engine } = await fixture({ 'Note.md': '' });
    engine.setPathViolations('Note.md', [violation]);
    const [problem] = engine.getProblems('Note.md');
    expect(problem?.row.kind).toBe('path');
    expect(problem?.message).toContain(message);
  });

  it('clears a path and everything under it, or every path', async () => {
    const { engine } = await fixture({ 'A/B.md': '', 'C.md': '' });
    const violation = { platform: PathCompatibilityPlatform.Windows, type: PathCompatibilityViolationType.ReservedName };
    engine.setPathViolations('A', [violation]);
    engine.setPathViolations('A/B.md', [violation]);
    engine.setPathViolations('C.md', [violation]);
    engine.clearPathViolations('A');
    expect(kindProblems(engine, 'path').map((problem) => problem.row.sourcePath)).toEqual(['C.md']);
    engine.clearPathViolations('Missing');
    engine.clearPathViolations(null);
    expect(kindProblems(engine, 'path')).toEqual([]);
  });
});

describe('PathCompatibilityComponent', () => {
  it('checks every name at layout ready, then each create, rename and delete, and again on refresh', async () => {
    const { app, engine, getScope, ready, setScope } = await fixture({ 'Bad:name.md': '', 'Folder./Inner.md': '', 'Good.md': '' });
    const component = new PathCompatibilityComponent({ app, engine, getScope });
    component.refresh();
    component.load();
    expect(kindProblems(engine, 'path')).toEqual([]);
    ready();
    expect(new Set(kindProblems(engine, 'path').map((problem) => problem.row.sourcePath))).toEqual(new Set(['Bad:name.md', 'Folder.']));
    const created = await app.vault.create('New?.md', '');
    expect(engine.getProblems(created.path)).toHaveLength(1);
    await app.vault.rename(ensureNonNullable(app.vault.getFolderByPath('Folder.')), 'Folder');
    expect(engine.getProblems('Folder.')).toEqual([]);
    expect(engine.getProblems('Folder')).toEqual([]);
    await app.vault.delete(created);
    expect(engine.getProblems('New?.md')).toEqual([]);
    setScope({ ...WINDOWS, platforms: [] });
    component.refresh();
    expect(kindProblems(engine, 'path')).toEqual([]);
    component.unload();
  });
});

describe('ProblemFixes path fix', () => {
  it('renames to the repaired name inside the same folder, and undoes the rename', async () => {
    const { app, engine, fixes, notify } = await fixture({ 'Sub/Bad:name.md': '' });
    engine.setPathViolations('Sub/Bad:name.md', [{ characters: [':'], platform: PathCompatibilityPlatform.Windows, type: PathCompatibilityViolationType.ForbiddenCharacter }]);
    const [fix] = await fixes.getFixes(ensureNonNullable(engine.getProblems('Sub/Bad:name.md')[0]));
    expect(fix?.label).toBe('Rename to Bad-name.md');
    await ensureNonNullable(fix).run();
    expect(app.vault.getFileByPath('Sub/Bad-name.md')).not.toBeNull();
    const undo = ensureNonNullable(notify.mock.calls[0])[1];
    await undo();
    expect(app.vault.getFileByPath('Sub/Bad:name.md')).not.toBeNull();
    await expect(undo()).rejects.toThrow('Cannot undo');
  });

  it('offers nothing for a gone path or a name the current platforms accept, and refuses a taken target', async () => {
    const { app, engine, fixes, setScope } = await fixture({ 'Bad-name.md': '', 'Bad:name.md': '' });
    engine.setPathViolations('Bad:name.md', [{ characters: [':'], platform: PathCompatibilityPlatform.Windows, type: PathCompatibilityViolationType.ForbiddenCharacter }]);
    const problem = ensureNonNullable(engine.getProblems('Bad:name.md')[0]);
    const [fix] = await fixes.getFixes(problem);
    await expect(ensureNonNullable(fix).run()).rejects.toThrow('already exists');
    setScope({ ...WINDOWS, platforms: [] });
    expect(await fixes.getFixes(problem)).toEqual([]);
    await app.vault.delete(ensureNonNullable(app.vault.getFileByPath('Bad:name.md')));
    expect(await fixes.getFixes(problem)).toEqual([]);
  });
});

describe('MisplacedAttachmentComponent', () => {
  it('reports an embed of an attachment outside the note\'s attachment folder, and moves it there', async () => {
    const { app, engine, fixes, notify, ready } = await fixture({ 'Elsewhere/image.png': '', 'Note.md': '![[Elsewhere/image.png]]' });
    const mode = { value: ExternalAttachmentLinkMode.Report };
    const component = new MisplacedAttachmentComponent({ app, engine, getMode: (): ExternalAttachmentLinkMode => mode.value });
    component.load();
    component.refresh();
    ready();
    await vi.waitFor(() => {
      expect(kindProblems(engine, 'misplaced-attachment')).toHaveLength(1);
    });
    const problem = ensureNonNullable(kindProblems(engine, 'misplaced-attachment')[0]);
    expect(problem.row.sourcePath).toBe('Note.md');
    expect(problem.misplacedAttachment).toEqual({ attachmentPath: 'Elsewhere/image.png', properAttachmentFolderPath: '/' });
    const [fix] = await fixes.getFixes(problem);
    expect(fix?.label).toBe('Move image.png to /');
    await ensureNonNullable(fix).run();
    expect(app.vault.getFileByPath('image.png')).not.toBeNull();
    expect(await fixes.getFixes(problem)).toEqual([]);
    await ensureNonNullable(notify.mock.calls[0])[1]();
    expect(app.vault.getFileByPath('Elsewhere/image.png')).not.toBeNull();
    mode.value = ExternalAttachmentLinkMode.Ignore;
    component.refresh();
    expect(kindProblems(engine, 'misplaced-attachment')).toEqual([]);
    component.unload();
  });

  it('re-judges a note when its rows change, and leaves an attachment in its proper folder alone', async () => {
    const { app, caches, engine, ready } = await fixture({ 'Elsewhere/image.png': '', 'Note.md': '', 'photo.png': '' });
    const component = new MisplacedAttachmentComponent({ app, engine, getMode: (): ExternalAttachmentLinkMode => ExternalAttachmentLinkMode.Report });
    component.load();
    ready();
    const note = ensureNonNullable(app.vault.getFileByPath('Note.md'));
    caches.set(note.path, metadata('![[photo.png]] ![[Elsewhere/image.png]]'));
    engine.update({ kind: 'changed', path: note.path });
    await vi.waitFor(() => {
      expect(kindProblems(engine, 'misplaced-attachment').map((problem) => problem.misplacedAttachment?.attachmentPath)).toEqual(['Elsewhere/image.png']);
    });
    caches.set(note.path, metadata(''));
    engine.update({ kind: 'changed', path: note.path });
    await vi.waitFor(() => {
      expect(kindProblems(engine, 'misplaced-attachment')).toEqual([]);
    });
    component.unload();
  });
});
