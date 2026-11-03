import type {
  App as AppOriginal,
  CachedMetadata,
  Pos,
  TFile
} from 'obsidian';

import { parseLinks } from '@mnaoumov/obsidian-lib/parse-link';
import { ResourceLockComponent } from '@mnaoumov/obsidian-lib/resource-lock';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { Platform } from 'obsidian';
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

interface Fixture {
  readonly app: AppOriginal;
  readonly caches: Map<string, CachedMetadata>;
  readonly engine: LinkEngine;
  readonly notify: ReturnType<typeof vi.fn<(message: string, undo: () => Promise<void>) => void>>;
  readonly problem: LinkProblem;
  readonly repairs: AutoRepairComponent;
  readonly run: (prefix: string, item?: LinkProblem) => Promise<void>;
  readonly service: ProblemFixes;
  readonly source: TFile;
}

interface MockSubpath {
  readonly start: Pos['start'];
  readonly type: string;
}

vi.mock('obsidian', async (importOriginal) => ({
  ...await importOriginal<typeof import('obsidian')>(),
  resolveSubpath: (cache: CachedMetadata, subpath: string): MockSubpath | null => {
    const heading = cache.headings?.find((item) => `#${item.heading}` === subpath);
    return heading ? { start: heading.position.start, type: 'heading' } : null;
  }
}));

async function fixture(content = '[[Missing|Label]]\n'): Promise<Fixture> {
  const app = App.createConfigured__().asOriginalType__();
  app.vault.setConfig('newLinkFormat', 'absolute');
  const source = await app.vault.create('Source.md', content);
  const caches = new Map<string, CachedMetadata>([[source.path, metadata(content)]]);
  vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((file) => caches.get(file.path) ?? {});
  vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((path) => app.vault.getFileByPath(path.endsWith('.md') ? path : `${path}.md`));
  vi.spyOn(app.metadataCache, 'computeMetadataAsync').mockImplementation((buffer) => Promise.resolve(metadata(new TextDecoder().decode(buffer))));
  const engine = new LinkEngine({ app, notify: vi.fn() });
  engine.initialize();
  const notify = vi.fn<(message: string, undo: () => Promise<void>) => void>();
  const repairs = new AutoRepairComponent({ app, engine, isEnabled: (): boolean => false, notify, resourceLockComponent: new ResourceLockComponent(app, 'vault-problems') });
  const service = new ProblemFixes({ app, getProblems: (): readonly LinkProblem[] => engine.getAllProblems(), notify, repairs });
  const problem = ensureNonNullable(engine.getProblems(source.path)[0]);
  async function run(prefix: string, item: LinkProblem = problem): Promise<void> {
    const fixes = await service.getFixes(item);
    await ensureNonNullable(fixes.find((fix) => fix.label.startsWith(prefix)), `Missing action ${prefix}`).run();
  }
  return { app, caches, engine, notify, problem, repairs, run, service, source };
}

function metadata(content: string): CachedMetadata {
  const frontmatterEnd = content.startsWith('---\n') ? content.indexOf('\n---', 4) + 4 : 0;
  const property = /^related: "\[\[(?<link>[^\]]+)\]\]"$/mu.exec(content.slice(0, frontmatterEnd));
  const frontmatterLink = property?.groups?.['link'];
  return {
    ...(frontmatterLink && { frontmatter: { related: `[[${frontmatterLink}]]` }, frontmatterLinks: [{ key: 'related', link: frontmatterLink, original: `[[${frontmatterLink}]]` }] }),
    headings: [...content.matchAll(/^# (?<heading>.+)$/gmu)].map((match) => ({ heading: ensureNonNullable(match.groups)['heading'] ?? '', level: 1, position: position(match.index, match.index + match[0].length) })),
    links: parseLinks(content.slice(frontmatterEnd)).map((link) => ({ link: link.url, original: link.raw, position: position(frontmatterEnd + link.startOffset, frontmatterEnd + link.endOffset) })),
    referenceLinks: [...content.matchAll(/^\[(?<id>[^\]]+)\]: (?<link>\S+)(?: "[^"]+")?$/gmu)].map((match) => ({ id: ensureNonNullable(match.groups?.['id']), link: ensureNonNullable(match.groups?.['link']), position: position(match.index, match.index + match[0].length) })),
    sections: [{ position: position(0, content.trimEnd().length), type: 'paragraph' }]
  };
}

function position(start: number, end: number): Pos {
  return { end: { col: end, line: 0, offset: end }, start: { col: start, line: 0, offset: start } };
}

describe('Explicit quick fixes', () => {
  it('repairs body, frontmatter and reference definitions together without changing their use sites or titles', async () => {
    const content = '---\nrelated: "[[Missing]]"\n---\n\n[[Missing|Body]]\n\n[caption][ref]\n\n[ref]: Missing.md "Title"\n\n[other]: Unrelated.md';
    const { app, problem, run, source } = await fixture(content);
    await app.vault.create('New.md', '');
    await run('Update 3 links', { ...problem, cause: { kind: 'rename', oldPath: 'Missing.md', path: 'New.md' } });
    const after = await app.vault.read(source);
    expect(after).toContain('related: "[[New]]"');
    expect(after).toContain('[[New|Body]]');
    expect(after).toContain('[ref]: New.md "Title"');
    expect(after).toContain('[caption][ref]');
    expect(after).toContain('[other]: Unrelated.md');
  });

  it('removes a reference definition and its use sites as one fix with undo', async () => {
    const content = '[**caption**][ref]\n\n[ref]: Missing.md';
    const { app, run, source } = await fixture(content);
    await run('Remove link');
    expect(await app.vault.read(source)).toBe('**caption**\n\n');
  });

  it('rejects a target whose fragment disappeared, and a metadata snapshot without the selected row', async () => {
    const { app, caches, problem, service } = await fixture('[[Missing#Gone]]');
    const target = await app.vault.create('Missing.md', '# Existing');
    caches.set(target.path, metadata('# Existing'));
    const fixes = await service.getFixes({ ...problem, row: { ...problem.row, targetPath: target.path } });
    const action = ensureNonNullable(fixes.find((fix) => fix.label.startsWith('Use ')));
    caches.delete(target.path);
    vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue(null);
    await expect(action.run()).rejects.toThrow('target no longer exists');
    const candidate = await app.vault.create('New.md', '');
    const fileFixes = await service.getFixes({ ...problem, cause: { kind: 'rename', oldPath: 'Missing.md', path: candidate.path }, row: { ...problem.row, link: 'Missing' } });
    vi.spyOn(app.metadataCache, 'computeMetadataAsync').mockResolvedValue({});
    await expect(ensureNonNullable(fileFixes.find((fix) => fix.label.startsWith('Use '))).run()).rejects.toThrow('problem changed');
  });
  it('removes a wikilink keeping its caption, and undoes with the repair journal', async () => {
    const { app, notify, run, source } = await fixture();
    await run('Remove link');
    expect(await app.vault.read(source)).toBe('Label\n');
    await ensureNonNullable(notify.mock.calls[0])[1]();
    expect(await app.vault.read(source)).toBe('[[Missing|Label]]\n');
  });

  it('keeps the destination as text for a wikilink without a caption', async () => {
    const { app, run, source } = await fixture('[[Missing]]');
    await run('Remove link');
    expect(await app.vault.read(source)).toBe('Missing');
  });

  it('refuses a stale source row instead of editing another occurrence', async () => {
    const { app, run, source } = await fixture();
    await app.vault.modify(source, 'Prefix [[Missing|Label]]\n');
    await expect(run('Remove link')).rejects.toThrow('problem changed');
    expect(await app.vault.read(source)).toBe('Prefix [[Missing|Label]]\n');
  });

  it('creates a note and refuses undo after it was edited', async () => {
    const { app, notify, run } = await fixture();
    await run('Create Missing.md');
    const file = ensureNonNullable(app.vault.getFileByPath('Missing.md'));
    expect(await app.vault.read(file)).toBe('');
    const undo = ensureNonNullable(notify.mock.calls[0])[1];
    await app.vault.modify(file, 'User content');
    await expect(undo()).rejects.toThrow('new note has been edited');
    await app.vault.modify(file, '');
    await undo();
    expect(app.vault.getFileByPath(file.path)).toBeNull();
  });

  it('uses aliases and titles as candidate evidence without choosing one automatically', async () => {
    const { app, caches, problem, run, service, source } = await fixture();
    const alias = await app.vault.create('Renamed.md', '');
    const title = await app.vault.create('Alternative.md', '');
    caches.set(alias.path, { frontmatter: { aliases: ['Missing'] } });
    caches.set(title.path, { frontmatter: { title: 'Missing' } });
    const fixes = await service.getFixes(problem);
    expect(fixes.filter((fix) => fix.label.startsWith('Use '))).toHaveLength(2);
    expect(await app.vault.read(source)).toBe('[[Missing|Label]]\n');
    await run('Use Renamed.md');
    expect(await app.vault.read(source)).toBe('[[Renamed|Label]]\n');
  });

  it('uses the causal rename and rewrites a group as one undo operation', async () => {
    const { app, engine, notify, problem, run, source } = await fixture('[[Missing|A]] [[Missing|B]]');
    await app.vault.create('New.md', '');
    const causal: LinkProblem = { ...problem, cause: { kind: 'rename', oldPath: 'Missing.md', path: 'New.md' } };
    expect(engine.getAllProblems()).toHaveLength(2);
    await run('Update 2 links', causal);
    expect(await app.vault.read(source)).toBe('[[New|A]] [[New|B]]');
    await ensureNonNullable(notify.mock.calls[0])[1]();
    expect(await app.vault.read(source)).toBe('[[Missing|A]] [[Missing|B]]');
  });

  it('rejects a candidate deleted after the menu opened', async () => {
    const { app, problem, service } = await fixture();
    const file = await app.vault.create('Renamed.md', '');
    const actions = await service.getFixes({ ...problem, cause: { changes: [{ kind: 'rename', oldPath: 'Missing.md', path: file.path }], kind: 'batch', path: '' } });
    await app.fileManager.trashFile(file);
    await expect(ensureNonNullable(actions.find((fix) => fix.label.startsWith('Use '))).run()).rejects.toThrow('target no longer exists');
  });

  it('offers creation of a missing heading and a choice among existing endpoints', async () => {
    const { app, caches, problem, run, service } = await fixture('[[Missing#Gone]]');
    const target = await app.vault.create('Missing.md', '# Existing\n');
    caches.set(target.path, { ...metadata('# Existing\n'), blocks: { known: castTo({ id: 'known', position: position(0, 10) }) } });
    const fragment = { ...problem, row: { ...problem.row, targetPath: target.path } };
    const actions = await service.getFixes(fragment);
    expect(actions.map((fix) => fix.label)).toContain('Use Missing.md#Existing');
    await run('Create heading', fragment);
    expect(await app.vault.read(target)).toBe('# Existing\n\n\n# Gone\n');
    await expect(run('Create heading', fragment)).rejects.toThrow('heading already exists');
    await run('Use Missing.md#Existing', fragment);
    expect(await app.vault.read(ensureNonNullable(app.vault.getFileByPath('Source.md')))).toContain('#Existing');
  });

  it('creates nested notes and rejects non-note and invalid fragment creation', async () => {
    const { app, problem, service } = await fixture();
    const nested = { ...problem, row: { ...problem.row, link: 'folder/New.md' } };
    const actions = await service.getFixes(nested);
    await ensureNonNullable(actions.find((fix) => fix.label.startsWith('Create '))).run();
    expect(app.vault.getFileByPath('folder/New.md')).not.toBeNull();
    for (const link of ['image.png', 'Missing#Heading']) {
      const fixes = await service.getFixes({ ...problem, row: { ...problem.row, link } });
      expect(fixes.some((fix) => fix.label.startsWith('Create '))).toBe(false);
    }
    const target = ensureNonNullable(app.vault.getFileByPath('folder/New.md'));
    for (const link of ['folder/New#^bad id', 'folder/New#Nested#Heading']) {
      const fixes = await service.getFixes({ ...problem, row: { ...problem.row, link, targetPath: target.path } });
      expect(fixes).toHaveLength(1);
    }
  });

  it('does not restore block ids into empty content, code or blocks already bearing ids', async () => {
    const { app, caches, problem, service } = await fixture();
    const target = await app.vault.create('Target.md', 'Paragraph ^other');
    const fragment = { ...problem, row: { ...problem.row, link: 'Target#^old', targetPath: target.path } };
    caches.set(target.path, { sections: [{ position: position(0, 16), type: 'code' }, { position: position(0, 16), type: 'paragraph' }] });
    expect(await service.getFixes(fragment)).toHaveLength(1);
    await app.vault.modify(target, '');
    expect(await service.getFixes(fragment)).toHaveLength(1);
    caches.set(target.path, {});
    expect(await service.getFixes(fragment)).toHaveLength(1);
    vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue(null);
    expect(await service.getFixes(fragment)).toHaveLength(1);
  });

  it('does not read desktop git on mobile and ignores unrelated batch causes', async () => {
    const { problem, service } = await fixture();
    const desktopGit = await import('./desktop-git-runner.ts');
    const createRunner = vi.spyOn(desktopGit, 'createDesktopGitRunner');
    const descriptor = ensureNonNullable(Object.getOwnPropertyDescriptor(Platform, 'isDesktopApp'));
    Object.defineProperty(Platform, 'isDesktopApp', { configurable: true, value: false });
    try {
      const fixes = await service.getFixes({ ...problem, cause: { changes: [{ kind: 'changed', path: 'Other.md' }], kind: 'batch', path: '' } });
      expect(fixes.map((fix) => fix.label)).toEqual(['Create Missing.md', 'Remove link, keep text']);
      expect(await service.getFixes({ ...problem, cause: { kind: 'batch', path: '' } })).toHaveLength(2);
      expect(createRunner).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Platform, 'isDesktopApp', descriptor);
    }
  });

  it('restores an id only on the paragraph selected by the user and rejects concurrent edits', async () => {
    const { app, caches, problem, service } = await fixture('[[Missing#^old]]');
    const target = await app.vault.create('Missing.md', 'Paragraph');
    caches.set(target.path, metadata('Paragraph'));
    const fragment = { ...problem, row: { ...problem.row, targetPath: target.path } };
    const fixes = await service.getFixes(fragment);
    const fix = ensureNonNullable(fixes.find((action) => action.label.startsWith('Restore ^old')));
    await app.vault.modify(target, 'User edit');
    await expect(fix.run()).rejects.toThrow('changed after');
    await app.vault.modify(target, 'Paragraph');
    await fix.run();
    expect(await app.vault.read(target)).toBe('Paragraph ^old');
  });

  it.each(['../outside', '../../outside', 'bad:*name', 'bad\u{1}name', '#OnlyFragment', 'bad%ZZ', './nested', 'path/../Missing', '/folder/Missing'])('validates and resolves missing paths for %s', async (link) => {
    const { problem, service } = await fixture();
    const fixes = await service.getFixes({ ...problem, row: { ...problem.row, link } });
    expect(fixes.at(-1)?.label).toBe('Remove link, keep text');
    if (link.includes('outside') || link.startsWith('bad:') || link.includes('\u{1}') || link.startsWith('#')) {
      expect(fixes).toHaveLength(1);
    }
  });
});
