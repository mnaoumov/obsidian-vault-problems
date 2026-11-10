import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  App as AppOriginal,
  CachedMetadata,
  Pos,
  Reference,
  TFile
} from 'obsidian';

import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { resolveSubpath } from 'obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { LinkEngine } from './link-engine.ts';

vi.mock('obsidian', async (importOriginal) => ({
  ...await importOriginal<typeof import('obsidian')>(),
  resolveSubpath: vi.fn()
}));

const position: Pos = {
  end: { col: 12, line: 0, offset: 12 },
  start: { col: 0, line: 0, offset: 0 }
};

beforeEach(() => {
  // The package's resolveSubpath mock is a stub. Real resolution is asserted by the integration suite.
  vi.mocked(resolveSubpath).mockImplementation((cache, subpath) => {
    const block = cache.blocks?.[subpath.slice(2)];
    if (block) {
      return { block, end: null, start: block.position.start, type: 'block' };
    }
    const heading = cache.headings?.find((item) => `#${item.heading}` === subpath);
    return heading ? { current: heading, end: null, next: heading, start: position.start, type: 'heading' } : null;
  });
});

interface Fixture {
  readonly app: AppOriginal;
  readonly caches: Map<string, CachedMetadata>;
  readonly engine: LinkEngine;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly source: TFile;
  readonly target: TFile;
}

async function fixture(): Promise<Fixture> {
  const app = App.createConfigured__().asOriginalType__();
  const source = await app.vault.create('Source.md', '');
  const target = await app.vault.create('Target.md', '');
  const caches = new Map<string, CachedMetadata>([
    [source.path, { links: [{ link: 'Target', original: '[[Target]]', position }] }],
    [target.path, {}]
  ]);
  vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((file) => caches.get(file.path) ?? null);
  vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((path) => app.vault.getFileByPath(`${path}.md`));
  app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [] });
  const notify = vi.fn();
  return { app, caches, engine: new LinkEngine({ app, notify }), notify, source, target };
}

describe('LinkEngine', () => {
  it('reports existing unresolved links silently, then attributes a newly broken heading to its edit', async () => {
    const app = App.createConfigured__().asOriginalType__();
    const source = await app.vault.create('Source.md', '');
    const target = await app.vault.create('Target.md', '');
    const caches = new Map<string, CachedMetadata>([
      [source.path, {
        links: [
          { link: 'Target#Heading', original: '[[Target#Heading]]', position },
          { link: 'Missing', original: '[[Missing]]', position }
        ]
      }],
      [target.path, { headings: [{ heading: 'Heading', level: 1, position }] }]
    ]);
    vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((file) => caches.get(file.path) ?? null);
    vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((path) => path === 'Target' ? target : null);
    app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [] });
    const notify = vi.fn();
    const engine = new LinkEngine({ app, notify });
    engine.initialize();
    expect(engine.getProblems(source.path).map((problem) => problem.status)).toEqual(['standing']);
    expect(notify).not.toHaveBeenCalled(); // Existing damage does not interrupt vault startup.
    const listener = vi.fn();
    engine.on('changed', listener);
    caches.set(target.path, {});
    engine.update({ kind: 'changed', path: target.path });
    expect(engine.getProblems(source.path).map((problem) => problem.status)).toEqual(['new', 'standing']);
    expect(engine.getProblems(source.path)[0]?.cause).toMatchObject({ kind: 'changed', path: target.path });
    expect(notify).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    engine.update({ kind: 'resolved', path: source.path });
    expect(engine.getProblems(source.path)[0]?.status).toBe('new');
    expect(notify).toHaveBeenCalledOnce();
    caches.set(target.path, { headings: [{ heading: 'Heading', level: 1, position }] });
    engine.update({ kind: 'changed', path: target.path });
    expect(engine.getProblems(source.path)).toHaveLength(1);
  });

  it('reads embeds, frontmatter, local blocks and reference links while excluding external protocols', async () => {
    const { caches, engine, source, target } = await fixture();
    caches.set(source.path, {
      blocks: { local: castTo({ id: 'local', position }) },
      embeds: [{ link: 'Target', original: '![[Target]]', position }],
      frontmatterLinks: [{ key: 'related.0', link: 'Missing', original: '[[Missing]]' }],
      links: [
        { link: '#^local', original: '[[#^local]]', position },
        { link: 'https://example.com', original: '', position },
        { link: '//example.com', original: '', position },
        { link: 'Target#Absent', original: '', position },
        { link: 'Target#Absent', original: '', position },
        { link: 'Broken%XX', original: '', position }
      ],
      referenceLinks: [{ id: 'ref', link: 'Target', position }]
    });
    engine.initialize();
    expect(engine.getRows(source.path)).toHaveLength(7);
    expect(engine.getRows(source.path)[0]?.target).toMatchObject({ kind: 'block', path: source.path });
    expect(new Set(engine.getRows(source.path).map((row) => row.id)).size).toBe(7);
    expect(engine.getProblems(source.path)).toHaveLength(4);
    expect(engine.getRows(source.path).find((row) => row.kind === 'frontmatter')).toMatchObject({ key: 'related.0', position: null });
    expect(engine.getRows(source.path).find((row) => row.kind === 'reference')?.target?.path).toBe(target.path);
  });

  it('does not scan unrelated notes and retries missing names when the target appears', async () => {
    const { app, caches, engine, source, target } = await fixture();
    const unrelated = await app.vault.create('Unrelated.md', '');
    caches.set(unrelated.path, {});
    caches.set(source.path, { links: [{ link: 'Missing', original: '', position }] });
    engine.initialize();
    const getFileCache = vi.mocked(app.metadataCache.getFileCache);
    getFileCache.mockClear();
    const missing = await app.vault.create('Missing.md', '');
    caches.set(missing.path, {});
    engine.update({ kind: 'resolved', path: missing.path });
    expect(engine.getProblems(source.path)).toEqual([]);
    expect(getFileCache.mock.calls.map(([file]) => file.path)).not.toContain(unrelated.path);
    const scans = vi.spyOn(app.vault, 'getMarkdownFiles');
    engine.initialize();
    expect(scans).not.toHaveBeenCalled(); // Repeated layout callbacks must not scan the vault again.
    caches.delete(target.path);
    engine.update({ kind: 'changed', path: target.path });
    expect(engine.getProblems('Unknown.md')).toEqual([]);
  });

  it('uses the old target index after deletion, removes deleted sources and can repair a recreated target', async () => {
    const { app, caches, engine, notify, source, target } = await fixture();
    engine.initialize();
    await app.fileManager.trashFile(target);
    engine.update({ kind: 'delete', path: target.path });
    expect(engine.getProblems(source.path)[0]).toMatchObject({ cause: { kind: 'delete' }, status: 'new' });
    expect(notify).toHaveBeenCalledOnce();
    await app.vault.create('Target.md', '');
    engine.update({ kind: 'resolved', path: 'Target.md' });
    expect(engine.getProblems(source.path)).toEqual([]);
    await app.fileManager.trashFile(source);
    caches.delete(source.path);
    engine.update({ kind: 'delete', path: source.path });
    expect(engine.getRows(source.path)).toEqual([]);
    expect(engine.getProblems(source.path)).toEqual([]);
  });

  it('ignores a stale resolver result that still names a deleted file', async () => {
    const { app, engine, source, target } = await fixture();
    vi.mocked(app.metadataCache.getFirstLinkpathDest).mockReturnValue(target);
    engine.initialize();
    await app.fileManager.trashFile(target);
    engine.update({ kind: 'delete', path: target.path });
    expect(engine.getProblems(source.path)[0]?.status).toBe('new');
  });

  it('keeps standing problems and source identities across a rename', async () => {
    const { app, caches, engine, source } = await fixture();
    caches.set(source.path, { links: [{ link: 'Missing', original: '', position }] });
    engine.initialize();
    const oldPath = source.path;
    const cache = caches.get(oldPath);
    await app.vault.rename(source, 'Renamed.md');
    if (cache) {
      caches.set(source.path, cache);
    }
    engine.update({ kind: 'rename', oldPath, path: source.path });
    expect(engine.getProblems(source.path)[0]).toMatchObject({ row: { sourcePath: 'Renamed.md' }, status: 'standing' });
    expect(engine.getRows(oldPath)).toEqual([]);
  });

  it('reports a target rename with links left unchanged and accepts the core backlink index', async () => {
    const { app, caches, engine, source, target } = await fixture();
    engine.initialize();
    const oldPath = target.path;
    await app.vault.rename(target, 'Renamed.md');
    caches.set(target.path, {});
    app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [source.path] });
    engine.update({ kind: 'rename', oldPath, path: target.path });
    expect(engine.getProblems(source.path)[0]).toMatchObject({ cause: { oldPath }, status: 'new' });
  });

  it('publishes one final batch diff and suppresses transient damage repaired inside the batch', async () => {
    const { caches, engine, notify, source, target } = await fixture();
    engine.update({ kind: 'changed', path: source.path });
    expect(engine.getRows(source.path)).toEqual([]); // Startup owns the initial snapshot.
    engine.initialize();
    const listener = vi.fn();
    const ref = engine.onChanged(listener);
    await engine.runInBatch(async () => {
      await engine.runInBatch(async () => {
        caches.set(source.path, { links: [{ link: 'Missing', original: '', position }] });
        engine.update({ kind: 'changed', path: source.path });
        await noopAsync();
      });
      expect(listener).not.toHaveBeenCalled(); // Intermediate snapshots are not observable.
      caches.set(source.path, { links: [{ link: 'Target', original: '', position }] });
      engine.update({ kind: 'resolved', path: source.path });
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled(); // The only broken state was repaired before the batch ended.
    // An externally ended batch can be ended again without closing an outer one.
    const endOuter = engine.beginBatch();
    const endInner = engine.beginBatch();
    endInner();
    endInner();
    engine.update({ kind: 'changed', path: source.path });
    expect(listener).toHaveBeenCalledOnce();
    endOuter();
    expect(listener).toHaveBeenCalledTimes(2);
    engine.offref(ref);
    await engine.runInBatch(async () => {
      await engine.runInBatch(async () => {
        await noopAsync();
      });
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(engine.getRows(source.path)[0]?.target?.path).toBe(target.path);
  });

  it('flushes damage after a failed batch and attributes all final breaks to that batch', async () => {
    const { app, engine, notify, source, target } = await fixture();
    engine.initialize();
    await expect(engine.runInBatch(async () => {
      await app.fileManager.trashFile(target);
      engine.update({ kind: 'delete', path: target.path });
      engine.update({ kind: 'resolved', path: source.path });
      throw new Error('Operation failed');
    })).rejects.toThrow('Operation failed');
    expect(engine.getProblems(source.path)[0]).toMatchObject({ cause: { kind: 'batch' }, status: 'new' });
    expect(notify).toHaveBeenCalledOnce();
  });

  it('preserves known rows while metadata is temporarily unavailable', async () => {
    const { caches, engine, notify, source, target } = await fixture();
    engine.initialize();
    caches.delete(source.path);
    engine.update({ kind: 'changed', path: source.path });
    expect(engine.getRows(source.path)[0]?.target?.path).toBe(target.path);
    expect(notify).not.toHaveBeenCalled(); // Missing metadata is not evidence that a link broke.
    caches.set(source.path, { links: [{ link: 'Target#Heading', original: '', position }] });
    caches.delete(target.path);
    engine.update({ kind: 'changed', path: source.path });
    expect(engine.getProblems(source.path)).toHaveLength(1);
  });

  it('attributes an edited destination to the source edit while treating inserted missing links as standing', async () => {
    const { caches, engine, notify, source } = await fixture();
    engine.initialize();
    caches.set(source.path, { links: [{ link: 'Missing', original: '', position }] });
    engine.update({ kind: 'changed', path: source.path });
    expect(engine.getProblems(source.path)[0]).toMatchObject({ cause: { path: source.path }, status: 'new' });
    expect(notify).toHaveBeenCalledOnce();
    caches.set(source.path, { links: [{ link: 'Target', original: '', position }] });
    engine.update({ kind: 'changed', path: source.path });
    caches.set(source.path, {
      links: [
        { link: 'Missing', original: '', position },
        { link: 'Target', original: '', position: { end: { col: 12, line: 1, offset: 25 }, start: { col: 0, line: 1, offset: 13 } } }
      ]
    });
    engine.update({ kind: 'changed', path: source.path });
    expect(engine.getProblems(source.path)[0]?.status).toBe('standing');
    expect(notify).toHaveBeenCalledOnce(); // Inserting an unresolved link did not break the existing one.
  });

  it('keeps other sources indexed when one source removes its link', async () => {
    const { app, caches, engine, source, target } = await fixture();
    const second = await app.vault.create('Second.md', '');
    caches.set(second.path, { links: [{ link: 'Target', original: '', position }] });
    engine.initialize();
    caches.set(source.path, {});
    engine.update({ kind: 'changed', path: source.path });
    await app.fileManager.trashFile(target);
    engine.update({ kind: 'delete', path: target.path });
    expect(engine.getProblems(source.path)).toEqual([]);
    expect(engine.getProblems(second.path)[0]?.status).toBe('new');
  });
});
