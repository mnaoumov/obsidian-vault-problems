import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  CachedMetadata,
  Reference,
  TFile
} from 'obsidian';

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

import { AutoRepairComponent } from './auto-repair-component.ts';
import { LinkEngine } from './link-engine.ts';
import { ProblemFixes } from './problem-fixes.ts';
import { SyntaxCheckComponent } from './syntax-check-component.ts';
import { findSyntaxIssues } from './syntax-checks.ts';

interface FixesFixture {
  readonly app: App;
  readonly fixes: ProblemFixes;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly problem: LinkProblem;
}

interface Fixture {
  readonly app: App;
  readonly engine: LinkEngine;
  readonly file: TFile;
}

const SWALLOWED = '---\ntitle: "Unclosed\ntags: [a]\n---\n';

async function fixture(): Promise<Fixture> {
  const mock = App.createConfigured__();
  const app = mock.asOriginalType__();
  const file = await app.vault.create('Note.md', SWALLOWED);
  vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue({} satisfies CachedMetadata);
  app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [] });
  const engine = new LinkEngine({ app, notify: vi.fn() });
  engine.initialize();
  return { app: mock, engine, file };
}

describe('LinkEngine syntax problems', () => {
  it('publishes syntax problems as rows of the syntax kind, once per distinct result', async () => {
    const { engine, file } = await fixture();
    const changed = vi.fn();
    engine.onChanged(changed);
    engine.setSyntaxIssues(file.path, findSyntaxIssues(SWALLOWED));
    engine.setSyntaxIssues(file.path, findSyntaxIssues(SWALLOWED));
    expect(changed).toHaveBeenCalledTimes(1);
    const [problem] = engine.getProblems(file.path);
    expect(problem?.row.kind).toBe('syntax');
    expect(problem?.row.position?.start.line).toBe(1);
    expect(engine.getAllProblems()).toHaveLength(1);
    engine.setSyntaxIssues(file.path, []);
    expect(engine.getProblems(file.path)).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('ignores a path with no file, and follows a rename and a delete', async () => {
    const { app, engine, file } = await fixture();
    engine.setSyntaxIssues('Missing.md', findSyntaxIssues(SWALLOWED));
    expect(engine.getAllProblems()).toEqual([]);
    engine.setSyntaxIssues(file.path, findSyntaxIssues(SWALLOWED));
    const original = app.asOriginalType__();
    await original.vault.rename(file, 'Moved.md');
    engine.update({ kind: 'rename', oldPath: 'Note.md', path: 'Moved.md' });
    expect(engine.getProblems('Note.md')).toEqual([]);
    expect(engine.getProblems('Moved.md')[0]?.row.sourcePath).toBe('Moved.md');
    const moved = ensureNonNullable(original.vault.getFileByPath('Moved.md'));
    await original.fileManager.trashFile(moved);
    engine.update({ kind: 'delete', path: 'Moved.md' });
    expect(engine.getAllProblems()).toEqual([]);
  });
});

describe('SyntaxCheckComponent', () => {
  it('scans every note at layout ready, then checks the text of each metadata change', async () => {
    const { app, engine, file } = await fixture();
    const original = app.asOriginalType__();
    let ready: (() => void) | undefined;
    vi.spyOn(original.workspace, 'onLayoutReady').mockImplementation((callback) => {
      ready = callback;
    });
    const component = new SyntaxCheckComponent({ app: original, engine });
    component.load();
    ensureNonNullable(ready)();
    await vi.waitFor(() => {
      expect(engine.getProblems(file.path)).toHaveLength(1);
    });
    original.metadataCache.trigger('changed', file, '---\ntitle: "Closed"\n---\n', {});
    expect(engine.getProblems(file.path)).toEqual([]);
    component.unload();
  });

  it('keeps a change published during the scan over the stale read, and stops when unloaded', async () => {
    const { app, engine, file } = await fixture();
    const original = app.asOriginalType__();
    const second = await original.vault.create('Second.md', SWALLOWED);
    const third = await original.vault.create('Third.md', SWALLOWED);
    let ready: (() => void) | undefined;
    vi.spyOn(original.workspace, 'onLayoutReady').mockImplementation((callback) => {
      ready = callback;
    });
    const reads: (() => void)[] = [];
    vi.spyOn(original.vault, 'cachedRead').mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        reads.push(resolve);
      });
      return SWALLOWED;
    });
    const component = new SyntaxCheckComponent({ app: original, engine });
    component.load();
    ensureNonNullable(ready)();
    await vi.waitFor(() => {
      expect(reads).toHaveLength(1);
    });
    // The first note changes while its read is in flight; the second changes before its turn.
    original.metadataCache.trigger('changed', file, 'clean', {});
    original.metadataCache.trigger('changed', second, 'clean', {});
    ensureNonNullable(reads[0])();
    await vi.waitFor(() => {
      expect(reads).toHaveLength(2);
    });
    component.unload();
    ensureNonNullable(reads[1])();
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
    expect(engine.getProblems(third.path)).toEqual([]);
    expect(engine.getProblems(file.path)).toEqual([]);
    expect(engine.getProblems(second.path)).toEqual([]);
    expect(reads).toHaveLength(2);
  });
});

describe('ProblemFixes syntax fix', () => {
  async function fixesFixture(): Promise<FixesFixture> {
    const { app, engine, file } = await fixture();
    const original = app.asOriginalType__();
    engine.setSyntaxIssues(file.path, findSyntaxIssues(SWALLOWED));
    const notify = vi.fn();
    const repairs = new AutoRepairComponent({ app: original, engine, isEnabled: (): boolean => false, notify, resourceLockComponent: new ResourceLockComponent(original, 'vault-problems') });
    const fixes = new ProblemFixes({ app: original, getProblems: (): readonly LinkProblem[] => engine.getAllProblems(), notify, repairs });
    return { app, fixes, notify, problem: ensureNonNullable(engine.getProblems(file.path)[0]) };
  }

  it('closes the quote with undo, and offers only that fix', async () => {
    const { app, fixes, notify, problem } = await fixesFixture();
    const original = app.asOriginalType__();
    const actions = await fixes.getFixes(problem);
    expect(actions.map((action) => action.label)).toEqual(['Close the quote at the end of line 2']);
    await ensureNonNullable(actions[0]).run();
    const file = ensureNonNullable(original.vault.getFileByPath('Note.md'));
    expect(await original.vault.read(file)).toBe('---\ntitle: "Unclosed"\ntags: [a]\n---\n');
    const undo = ensureNonNullable(notify.mock.calls[0])[1] as () => Promise<void>;
    await undo();
    expect(await original.vault.read(file)).toBe(SWALLOWED);
  });

  it('refuses a fix whose note changed since the problem was found', async () => {
    const { app, fixes, problem } = await fixesFixture();
    const original = app.asOriginalType__();
    const actions = await fixes.getFixes(problem);
    await original.vault.modify(ensureNonNullable(original.vault.getFileByPath('Note.md')), '---\ntitle: "Fixed by hand"\n---\n');
    await expect(ensureNonNullable(actions[0]).run()).rejects.toThrow('The note changed');
  });

  it('refuses a fix whose note was deleted', async () => {
    const { app, fixes, problem } = await fixesFixture();
    const original = app.asOriginalType__();
    const actions = await fixes.getFixes(problem);
    await original.fileManager.trashFile(ensureNonNullable(original.vault.getFileByPath('Note.md')));
    await expect(ensureNonNullable(actions[0]).run()).rejects.toThrow('The note changed');
  });

  it('offers nothing for a problem without a fix', async () => {
    const { engine, file } = await fixture();
    engine.setSyntaxIssues(file.path, findSyntaxIssues('a `b\n'));
    const original = engine.getProblems(file.path)[0];
    const fixes = new ProblemFixes({ app: castTo(null), getProblems: (): readonly LinkProblem[] => [], notify: vi.fn(), repairs: castTo(null) });
    expect(await fixes.getFixes(ensureNonNullable(original))).toEqual([]);
  });
});
