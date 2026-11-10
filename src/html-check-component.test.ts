import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  App as AppOriginal,
  CachedMetadata,
  PluginManifest,
  Reference,
  TFile
} from 'obsidian';

import { publishPluginApi } from '@mnaoumov/obsidian-lib/plugin/plugin-api';
import { noop } from '@mnaoumov/typescript-lib/function';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import {
  Component,
  Plugin
} from 'obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type {
  AdvancedMetadataCacheHtmlApi,
  HtmlDiagnostic
} from './advanced-metadata-cache.ts';
import type { LinkProblem } from './link-model.ts';

import { ADVANCED_METADATA_CACHE_PLUGIN_ID } from './advanced-metadata-cache.ts';
import { HtmlCheckComponent } from './html-check-component.ts';
import { LinkEngine } from './link-engine.ts';
import { ProblemFixes } from './problem-fixes.ts';

type Answer = HtmlDiagnostic[] | null;

interface EngineFixture {
  readonly app: AppOriginal;
  readonly engine: LinkEngine;
  readonly file: TFile;
}

interface Provider {
  readonly api: AdvancedMetadataCacheHtmlApi;
  readonly owner: Component;
  readonly query: ReturnType<typeof vi.fn<(path: string) => Promise<Answer>>>;
}

interface Setup {
  readonly app: AppOriginal;
  readonly component: HtmlCheckComponent;
  readonly engine: LinkEngine;
  readonly file: TFile;
  readonly onStatusChanged: ReturnType<typeof vi.fn>;
  readonly ready: () => void;
}

/**
 Stands in for the provider plugin, which only keys the published record.
 */
class ProviderPlugin extends Plugin {}

const owners: Component[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const owner of owners.splice(0)) {
    owner.unload();
  }
});

function diagnostic(kind: HtmlDiagnostic['kind'], offset: number, html = '<foo>'): HtmlDiagnostic {
  return {
    kind,
    range: {
      html,
      isClosing: false,
      kind: 'tag',
      namespace: 'html',
      position: {
        end: { col: offset + html.length, line: 0, offset: offset + html.length },
        start: { col: offset, line: 0, offset }
      },
      tagName: 'foo'
    }
  };
}

async function engineFixture(): Promise<EngineFixture> {
  const app = App.createConfigured__().asOriginalType__();
  const file = await app.vault.create('Note.md', '<foo>');
  vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue({} satisfies CachedMetadata);
  app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [] });
  const engine = new LinkEngine({ app, notify: noop });
  engine.initialize();
  return { app, engine, file };
}

function publish(app: AppOriginal, answer: (path: string) => Promise<Answer>): Provider {
  const owner = new Component();
  owner.load();
  owners.push(owner);
  const query = vi.fn(answer);
  const api: AdvancedMetadataCacheHtmlApi = { getHtmlDiagnosticsSafe: query };
  publishPluginApi({
    api,
    apiVersion: '1.15.0',
    component: owner,
    plugin: new ProviderPlugin(app, castTo<PluginManifest>({ id: ADVANCED_METADATA_CACHE_PLUGIN_ID }))
  });
  return { api, owner, query };
}

async function setup(): Promise<Setup> {
  const { app, engine, file } = await engineFixture();
  let ready: (() => void) | undefined;
  vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation((callback) => {
    ready = callback;
  });
  const onStatusChanged = vi.fn();
  const component = new HtmlCheckComponent({ app, engine, onStatusChanged });
  owners.push(component);
  return {
    app,
    component,
    engine,
    file,
    onStatusChanged,
    ready: (): void => {
      ensureNonNullable(ready)();
    }
  };
}

describe('LinkEngine HTML problems', () => {
  it('publishes HTML problems as warnings-to-review rows in source order, once per distinct result', async () => {
    const { engine, file } = await engineFixture();
    const changed = vi.fn();
    engine.onChanged(changed);
    const long = `<foo title="${'x'.repeat(100)}">`;
    const diagnostics = [diagnostic('unknown', 10), diagnostic('sanitized', 10), diagnostic('sanitized', 0, long)];
    engine.setHtmlDiagnostics(file.path, diagnostics);
    engine.setHtmlDiagnostics(file.path, [...diagnostics]);
    expect(changed).toHaveBeenCalledTimes(1);
    const problems = engine.getProblems(file.path);
    expect(problems.map((problem) => problem.row.id)).toEqual(['html:sanitized:0', 'html:sanitized:10', 'html:unknown:10']);
    expect(problems.map((problem) => problem.row.kind)).toEqual(['html', 'html', 'html']);
    expect(problems[0]?.message).toBe(`Obsidian's sanitizer changes or removes ${long.slice(0, 80)}… when it renders this note`);
    expect(problems[2]?.message).toBe('Unknown HTML tag <foo>: Obsidian renders it as an element no browser knows');
    expect(problems[2]?.row.link).toBe('<foo>');
    expect(engine.getAllProblems()).toHaveLength(3);
    engine.setHtmlDiagnostics(file.path, []);
    expect(engine.getProblems(file.path)).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('ignores a path with no file, follows a rename and a delete, and clears every note at once', async () => {
    const { app, engine, file } = await engineFixture();
    const changed = vi.fn();
    engine.onChanged(changed);
    engine.clearHtmlDiagnostics();
    expect(changed).not.toHaveBeenCalled();
    engine.setHtmlDiagnostics('Missing.md', [diagnostic('unknown', 0)]);
    expect(engine.getAllProblems()).toEqual([]);
    engine.setHtmlDiagnostics(file.path, [diagnostic('unknown', 0)]);
    await app.vault.rename(file, 'Moved.md');
    engine.update({ kind: 'rename', oldPath: 'Note.md', path: 'Moved.md' });
    expect(engine.getProblems('Note.md')).toEqual([]);
    expect(engine.getProblems('Moved.md')[0]?.row.sourcePath).toBe('Moved.md');
    engine.clearHtmlDiagnostics();
    expect(engine.getAllProblems()).toEqual([]);
    expect(changed).toHaveBeenLastCalledWith({ newProblems: [], sourcePaths: ['Moved.md'] });

    const moved = ensureNonNullable(app.vault.getFileByPath('Moved.md'));
    engine.setHtmlDiagnostics(moved.path, [diagnostic('unknown', 0)]);
    await app.fileManager.trashFile(moved);
    engine.update({ kind: 'delete', path: 'Moved.md' });
    expect(engine.getAllProblems()).toEqual([]);
  });
});

describe('ProblemFixes HTML problems', () => {
  it('offers no fix, because a lexical candidate never justifies deleting markup', async () => {
    const { app, engine, file } = await engineFixture();
    engine.setHtmlDiagnostics(file.path, [diagnostic('sanitized', 0)]);
    const fixes = new ProblemFixes({ app, getProblems: (): readonly LinkProblem[] => engine.getAllProblems(), notify: vi.fn(), repairs: castTo({}) });
    expect(await fixes.getFixes(ensureNonNullable(engine.getProblems(file.path)[0]))).toEqual([]);
  });
});

describe('HtmlCheckComponent', () => {
  it('says HTML is not checked while the provider is absent, and ignores edits then', async () => {
    const { app, component, file, onStatusChanged } = await setup();
    component.load();
    expect(component.statusMessage).toContain('needs the Advanced Metadata Cache plugin');
    expect(onStatusChanged).toHaveBeenCalledOnce();
    app.metadataCache.trigger('changed', file, '<foo>', {});
    await app.fileManager.trashFile(file);
    expect(onStatusChanged).toHaveBeenCalledOnce();
  });

  it('scans every note at layout ready, then re-queries each edit, and clears when the provider goes away', async () => {
    const { app, component, engine, file, onStatusChanged, ready } = await setup();
    let answer: Answer = [diagnostic('unknown', 0)];
    const provider = publish(app, () => Promise.resolve(answer));
    component.load();
    expect(component.statusMessage).toBe('Checking HTML in the vault…');
    ready();
    await vi.waitFor(() => {
      expect(component.statusMessage).toBeNull();
    });
    expect(engine.getProblems(file.path)).toHaveLength(1);

    answer = [];
    app.metadataCache.trigger('changed', file, '', {});
    await vi.waitFor(() => {
      expect(engine.getProblems(file.path)).toEqual([]);
    });

    const calls = onStatusChanged.mock.calls.length;
    provider.owner.unload();
    await vi.waitFor(() => {
      expect(onStatusChanged.mock.calls.length).toBeGreaterThan(calls);
    });
    expect(component.statusMessage).toContain('needs the Advanced Metadata Cache plugin');
  });

  it('drops HTML problems published by a provider that goes away', async () => {
    const { app, component, engine, file, ready } = await setup();
    const provider = publish(app, () => Promise.resolve([diagnostic('unknown', 0)]));
    component.load();
    ready();
    await vi.waitFor(() => {
      expect(engine.getProblems(file.path)).toHaveLength(1);
    });
    provider.owner.unload();
    await vi.waitFor(() => {
      expect(engine.getProblems(file.path)).toEqual([]);
    });
  });

  it('counts notes the provider cannot answer for, following renames and deletes', async () => {
    const { app, component, file, onStatusChanged, ready } = await setup();
    const other = await app.vault.create('Other.md', '');
    publish(app, () => Promise.resolve(null));
    component.load();
    ready();
    await vi.waitFor(() => {
      expect(component.statusMessage).toBe(
        'HTML is not checked in 2 note(s): turn on the HTML module in Advanced Metadata Cache, or wait for it to index them.'
      );
    });
    // A rename of a note that was never counted leaves the count alone.
    await app.vault.rename(await app.vault.create('Uncounted.md', ''), 'Uncounted again.md');
    await app.vault.rename(other, 'Renamed.md');
    const renamed = ensureNonNullable(app.vault.getFileByPath('Renamed.md'));
    const calls = onStatusChanged.mock.calls.length;
    await app.fileManager.trashFile(file);
    expect(onStatusChanged).toHaveBeenCalledTimes(calls + 1);
    await app.vault.rename(renamed, 'Again.md');
    await app.fileManager.trashFile(ensureNonNullable(app.vault.getFileByPath('Again.md')));
    expect(component.statusMessage).toBeNull();
    expect(onStatusChanged).toHaveBeenCalledTimes(calls + 2);
    // A note never counted changes nothing when it goes.
    await app.fileManager.trashFile(await app.vault.create('Plain.md', ''));
    expect(onStatusChanged).toHaveBeenCalledTimes(calls + 2);
  });

  it('retries an edit while the provider still answers null, and gives up after the last retry', async () => {
    const { app, component, engine, file, onStatusChanged, ready } = await setup();
    const answers: Answer[] = [[], null, null, [diagnostic('sanitized', 0)]];
    const provider = publish(app, () => Promise.resolve(answers.shift() ?? null));
    component.load();
    ready();
    await vi.waitFor(() => {
      expect(component.statusMessage).toBeNull();
    });
    vi.useFakeTimers();
    app.metadataCache.trigger('changed', file, '<script>', {});
    await vi.advanceTimersByTimeAsync(250 + 500);
    expect(provider.query).toHaveBeenCalledTimes(4);
    expect(engine.getProblems(file.path)).toHaveLength(1);

    const calls = onStatusChanged.mock.calls.length;
    app.metadataCache.trigger('changed', file, '<script>', {});
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000 + 4000);
    expect(provider.query).toHaveBeenCalledTimes(10);
    expect(component.statusMessage).toContain('HTML is not checked in 1 note(s)');
    expect(onStatusChanged).toHaveBeenCalledTimes(calls + 1);
    // The diagnostics already shown stay until the provider answers again.
    expect(engine.getProblems(file.path)).toHaveLength(1);
  });

  it('stops a retry when unloaded mid-wait or mid-query', async () => {
    const { app, component, file, ready } = await setup();
    let release: ((answer: Answer) => void) | undefined;
    const answers: (() => Promise<Answer>)[] = [
      (): Promise<Answer> => Promise.resolve([]),
      (): Promise<Answer> => Promise.resolve(null),
      (): Promise<Answer> =>
        new Promise((resolve) => {
          release = resolve;
        })
    ];
    const provider = publish(app, () => ensureNonNullable(answers.shift())());
    component.load();
    ready();
    await vi.waitFor(() => {
      expect(component.statusMessage).toBeNull();
    });
    vi.useFakeTimers();
    app.metadataCache.trigger('changed', file, '', {});
    await vi.advanceTimersByTimeAsync(0);
    app.metadataCache.trigger('changed', file, '', {});
    await vi.advanceTimersByTimeAsync(0);
    component.unload();
    await vi.advanceTimersByTimeAsync(10_000);
    ensureNonNullable(release)([diagnostic('unknown', 0)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.query).toHaveBeenCalledTimes(3);
    expect(component.statusMessage).toBeNull();
  });

  it('keeps a change published during the scan over the stale answer, skips deleted notes, and stops when unloaded', async () => {
    const { app, component, engine, file, ready } = await setup();
    const second = await app.vault.create('Second.md', '');
    const third = await app.vault.create('Third.md', '');
    const fourth = await app.vault.create('Fourth.md', '');
    const pending: ((answer: Answer) => void)[] = [];
    const provider = publish(app, (path) => {
      if (path === second.path || path === third.path) {
        return Promise.resolve([]);
      }
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    });
    component.load();
    ready();
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    // The first note changes while its query is in flight; the second changes before its turn.
    app.metadataCache.trigger('changed', file, '', {});
    app.metadataCache.trigger('changed', second, '', {});
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2);
    });
    // The change's own query answers first; the scan's stale answer must not replace it.
    ensureNonNullable(pending[1])([]);
    ensureNonNullable(pending[0])([diagnostic('unknown', 0)]);
    await vi.waitFor(() => {
      expect(pending).toHaveLength(3);
    });
    expect(engine.getProblems(file.path)).toEqual([]);
    expect(provider.query.mock.calls.filter(([path]) => path === second.path)).toHaveLength(1);
    // Third answered at once; fourth is deleted while its query is in flight.
    await app.fileManager.trashFile(fourth);
    ensureNonNullable(pending[2])([diagnostic('unknown', 0)]);
    await vi.waitFor(() => {
      expect(component.statusMessage).toBeNull();
    });
    expect(engine.getAllProblems()).toEqual([]);

    provider.owner.unload();
    const fifth = await app.vault.create('Fifth.md', '');
    const blocked = publish(app, () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }));
    await vi.waitFor(() => {
      expect(component.statusMessage).toBe('Checking HTML in the vault…');
    });
    ready();
    await vi.waitFor(() => {
      expect(blocked.query).toHaveBeenCalledOnce();
    });
    component.unload();
    ensureNonNullable(pending.at(-1))([diagnostic('unknown', 0)]);
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
    expect(blocked.query).toHaveBeenCalledOnce();
    expect(engine.getProblems(fifth.path)).toEqual([]);
  });
});
