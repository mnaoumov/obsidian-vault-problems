import type { StateField } from '@codemirror/state';
import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  App as AppOriginal,
  CachedMetadata,
  MarkdownFileInfo,
  Pos,
  Reference
} from 'obsidian';

import {
  EditorState,
  Transaction
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ResourceLockComponent } from '@mnaoumov/obsidian-lib/resource-lock';
import {
  errorToString,
  registerAsyncErrorEventHandler,
  startAsyncErrorIgnoreContext
} from '@mnaoumov/typescript-lib/error';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import {
  editorInfoField,
  resolveSubpath
} from 'obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { AutoRepairComponent } from './auto-repair-component.ts';
import { LinkEngine } from './link-engine.ts';

vi.mock('obsidian', async (importOriginal) => ({
  ...await importOriginal<typeof import('obsidian')>(),
  resolveSubpath: vi.fn()
}));

function heading(name: string): CachedMetadata {
  return { headings: [{ heading: name, level: 1, position: position(name.length + '# '.length) }] };
}

function position(end: number, start = 0): Pos {
  return { end: { col: end, line: 0, offset: end }, start: { col: start, line: 0, offset: start } };
}

beforeEach(() => {
  vi.mocked(resolveSubpath).mockImplementation((cache, subpath) => {
    const current = cache.headings?.find((item) => `#${item.heading}`.toLowerCase() === subpath.toLowerCase());
    if (current) {
      return { current, end: null, next: current, start: current.position.start, type: 'heading' };
    }
    const block = cache.blocks?.[subpath.slice('#^'.length)];
    return block ? { block, end: null, start: block.position.start, type: 'block' } : null;
  });
});

interface Fixture {
  readonly app: AppOriginal;
  readonly caches: Map<string, CachedMetadata>;
  readonly component: AutoRepairComponent;
  readonly engine: LinkEngine;
  readonly isEnabledMock: ReturnType<typeof vi.fn<() => boolean>>;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly parsed: Map<string, CachedMetadata>;
  readonly resourceLockComponent: ResourceLockComponent;
  readonly source: import('obsidian').TFile;
  readonly target: import('obsidian').TFile;
}

async function fixture(isEnabled = true): Promise<Fixture> {
  const app = App.createConfigured__().asOriginalType__();
  app.vault.setConfig('newLinkFormat', 'absolute');
  const target = await app.vault.create('Target.md', '# Original\n');
  const source = await app.vault.create('Source.md', '[[Target#Original|Label]]\n');
  const reference = { link: 'Target#Original', original: '[[Target#Original|Label]]', position: position('[[Target#Original|Label]]'.length) };
  const sourceCache: CachedMetadata = { links: [reference] };
  const caches = new Map<string, CachedMetadata>([[source.path, sourceCache], [target.path, heading('Original')]]);
  const parsed = new Map<string, CachedMetadata>([['[[Target#Original|Label]]\n', sourceCache], ['# Original\n', heading('Original')]]);
  vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((file) => caches.get(file.path) ?? null);
  vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation((path) => app.vault.getFileByPath(path.endsWith('.md') ? path : `${path}.md`));
  vi.spyOn(app.metadataCache, 'computeMetadataAsync').mockImplementation((buffer) => Promise.resolve(parsed.get(new TextDecoder().decode(buffer)) ?? {}));
  app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [] });
  const engine = new LinkEngine({ app, notify: vi.fn() });
  engine.initialize();
  const notify = vi.fn();
  const isEnabledMock = vi.fn<() => boolean>().mockReturnValue(isEnabled);
  const resourceLockComponent = new ResourceLockComponent(app, 'vault-problems');
  const component = new AutoRepairComponent({ app, engine, isEnabled: isEnabledMock, notify, resourceLockComponent });
  component.register(() => {
    resourceLockComponent.unload();
  });
  component.load();
  return { app, caches, component, engine, isEnabledMock, notify, parsed, resourceLockComponent, source, target };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

describe('Automatic repairs', () => {
  it('holds every journal file locked during writes and releases all locks afterward', async () => {
    const { app, component, resourceLockComponent, source, target } = await fixture();
    const process = app.vault.process.bind(app.vault);
    const write = vi.spyOn(app.vault, 'process').mockImplementation((file, callback, options) => {
      expect(resourceLockComponent.isLockedForPath(source)).toBe(true);
      expect(resourceLockComponent.isLockedForPath(target)).toBe(true);
      return process(file, callback, options);
    });
    await component.undo([
      { after: '# Original\n', before: '# Before\n', path: target.path },
      { after: '[[Target#Original|Label]]\n', before: 'Before link', path: source.path }
    ]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(await app.vault.read(source)).toBe('Before link');
    expect(resourceLockComponent.isLockedForPath(source)).toBe(false);
    expect(resourceLockComponent.isLockedForPath(target)).toBe(false);
    component.unload();
  });
  it('invalidates cut evidence when its original editor document is replaced programmatically', async () => {
    const { app, caches, component, notify, source, target } = await fixture();
    const state = EditorState.create({ doc: '# Original\n' });
    const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: state.doc.length } });
    component.observe(target.path, cut);
    component.observe(target.path, cut.state.update({ changes: { from: 0, insert: '# Restored\n' } }));
    await app.vault.modify(target, '# Restored\n');
    caches.set(target.path, heading('Restored'));
    const destination = await app.vault.create('Destination.md', '# Original\n');
    caches.set(destination.path, heading('Original'));
    component.observe(destination.path, EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: '# Original\n' } }));
    app.metadataCache.trigger('resolved');
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(await app.vault.read(source)).toContain('Target#Original');
    component.unload();
  });
  it('preserves a cut across the programmatic document load when opening the destination note', async () => {
    const { app, caches, component, notify, parsed, source, target } = await fixture();
    const prefix = '# Destination\n';
    const destination = await app.vault.create('Destination.md', prefix);
    const original = '# Original\nBody\n';
    parsed.set(original, heading('Original'));
    await app.vault.modify(target, original);
    const state = EditorState.create({ doc: original });
    const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: '# Original\n'.length } });
    component.observe(target.path, cut);
    component.observe(target.path, cut.state.update({ changes: { from: 0, insert: cut.newDoc.toString(), to: cut.newDoc.length } }));
    await app.vault.modify(target, 'Body\n');
    caches.set(target.path, {});
    const load = EditorState.create({ doc: '' }).update({ changes: { from: 0, insert: prefix } });
    component.observe(destination.path, load);
    const paste = load.state.update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: prefix.length, insert: '# Original\n' } });
    component.observe(destination.path, paste);
    await app.vault.modify(destination, paste.newDoc.toString());
    caches.set(destination.path, {
      headings: [
        { heading: 'Destination', level: 1, position: position(prefix.trimEnd().length) },
        { heading: 'Original', level: 1, position: position(prefix.length + '# Original'.length, prefix.length) }
      ]
    });
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledOnce();
    });
    expect(await app.vault.read(source)).toBe('[[Destination#Original|Label]]\n');
    component.unload();
  });

  it.each(['Revised', 'Restored'])('validates a programmatic editor replacement containing %s against pending heading evidence', async (replacement) => {
    const { app, caches, component, notify, source, target } = await fixture();
    const edit = EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } });
    component.observe(target.path, edit);
    component.observe('Other.md', EditorState.create({ doc: '' }).update({ changes: { from: 0, insert: '# Other\n' } }));
    component.observe(target.path, edit.state.update({ changes: { from: 0, insert: `# ${replacement}\n`, to: edit.newDoc.length } }));
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    if (replacement === 'Revised') {
      await vi.waitFor(() => {
        expect(notify).toHaveBeenCalledOnce();
      });
      expect(await app.vault.read(source)).toContain('#Revised');
    } else {
      await settle();
      expect(notify).not.toHaveBeenCalled();
      expect(await app.vault.read(source)).toContain('#Original');
    }
    component.unload();
  });
  it('skips a backlink source whose file endpoint has disappeared', async () => {
    const { app, caches, component, notify, source, target } = await fixture();
    const getFile = app.vault.getFileByPath.bind(app.vault);
    vi.spyOn(app.vault, 'getFileByPath').mockImplementation((path) => path === source.path ? null : getFile(path));
    const process = vi.spyOn(app.vault, 'process');
    component.observe(target.path, EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } }));
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    await settle();
    expect(process).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    component.unload();
  });

  it('quietly abandons an automatic repair if a source changed after its content was parsed', async () => {
    const { app, caches, component, notify, parsed, source, target } = await fixture();
    let shouldEdit = true;
    vi.mocked(app.metadataCache.computeMetadataAsync).mockImplementation(async (buffer) => {
      if (shouldEdit) {
        shouldEdit = false;
        await app.vault.modify(source, 'Later edit');
      }
      return parsed.get(new TextDecoder().decode(buffer)) ?? {};
    });
    component.observe(target.path, EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } }));
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    await settle();
    expect(await app.vault.read(source)).toBe('Later edit');
    expect(notify).not.toHaveBeenCalled();
    component.unload();
  });
  it('captures case variants of one heading while excluding file, block, missing and other-note links', async () => {
    const { app, caches, component, engine, notify, parsed, source, target } = await fixture();
    const other = await app.vault.create('Other.md', '# Original\n');
    const targetText = '# Original\n\nA block. ^alpha\n';
    await app.vault.modify(target, targetText);
    const blocks = { alpha: castTo<import('obsidian').BlockCache>({ id: 'alpha', position: position(0) }) };
    caches.set(target.path, { ...heading('Original'), blocks });
    caches.set(other.path, heading('Original'));
    const links = ['Target#Original|Label', 'Target#original', 'Target', 'Missing', 'Other#Original', 'Target#^alpha'];
    const text = links.map((link) => `[[${link}]]\n`).join('');
    let offset = 0;
    const cache: CachedMetadata = {
      links: links.map((link) => {
        const original = `[[${link}]]`;
        const result = { link: link.split('|', 1)[0] ?? '', original, position: position(offset + original.length, offset) };
        offset += original.length + 1;
        return result;
      })
    };
    await app.vault.modify(source, text);
    caches.set(source.path, cache);
    parsed.set(text, cache);
    engine.updateMany([{ kind: 'changed', path: source.path }, { kind: 'changed', path: target.path }, { kind: 'changed', path: other.path }]);
    expect(engine.getRows(source.path)[0]).toMatchObject({ link: 'Target#Original', target: { kind: 'heading', subpath: '#Original' } });
    component.observe(target.path, EditorState.create({ doc: targetText }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } }));
    await app.vault.modify(target, targetText.replace('Original', 'Revised'));
    caches.set(target.path, { ...heading('Revised'), blocks });
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledOnce();
    });
    const result = await app.vault.read(source);
    expect(notify.mock.calls[0]?.[0]).toContain('Target.md#Original');
    expect(result).toBe(text.replace('Target#Original|Label', 'Target#Revised|Label').replace('Target#original', 'Target#Revised'));
    component.unload();
  });

  it.each(['deleted', 'unparsed', 'changed'])('keeps links reported when the old heading cache is %s before the editor callback', async (scenario) => {
    const { app, caches, component, notify, source, target } = await fixture();
    if (scenario === 'deleted') {
      await app.fileManager.trashFile(target);
    } else if (scenario === 'unparsed') {
      caches.delete(target.path);
    } else {
      caches.set(target.path, {});
    }
    component.observe(target.path, EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } }));
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(await app.vault.read(source)).toContain('#Original');
    component.unload();
  });
  it('retains the backlink snapshot while a heading is temporarily empty during retyping', async () => {
    const { app, caches, component, notify, source, target } = await fixture();
    const deletion = EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('delete.backward'), changes: { from: 2, to: 10 } });
    component.observe(target.path, deletion);
    await app.vault.modify(target, '# \n');
    caches.set(target.path, {});
    app.metadataCache.trigger('resolved');
    await settle();
    expect(notify).not.toHaveBeenCalled();
    component.observe(target.path, deletion.state.update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised' } }));
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledOnce();
    });
    expect(await app.vault.read(source)).toContain('#Revised');
    component.unload();
  });
  it('routes changes from the editor extension only when a note file is present', async () => {
    const { component, target } = await fixture();
    const observe = vi.spyOn(component, 'observe');
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: '# Original\n', extensions: [component.extension, castTo<StateField<MarkdownFileInfo>>(editorInfoField).init(() => castTo({ file: target }))] }) });
    view.dispatch({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } });
    expect(observe).toHaveBeenCalledWith(target.path, expect.anything());
    view.dispatch({ selection: { anchor: 0 } });
    view.destroy();
    observe.mockClear();
    const other = new EditorView({ doc: 'Body', extensions: [component.extension], parent: document.body });
    other.dispatch({ changes: { from: 0, insert: 'More' } });
    expect(observe).not.toHaveBeenCalled();
    other.destroy();
    component.unload();
  });
  it('repairs a backlink after an editor heading edit and restores it in one Undo', async () => {
    const { app, caches, component, notify, source, target } = await fixture();
    const state = EditorState.create({ doc: '# Original\n' });
    component.observe(target.path, state.update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Replacement', to: 10 } }));
    await app.vault.modify(target, '# Replacement\n');
    caches.set(target.path, heading('Replacement'));
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledOnce();
    });
    expect(await app.vault.read(source)).toBe('[[Target#Replacement|Label]]\n');
    const undo = castTo<() => Promise<void>>(notify.mock.calls[0]?.[1]);
    await undo();
    expect(await app.vault.read(source)).toBe('[[Target#Original|Label]]\n');
    component.unload();
  });

  it('does not write when disabled or when a second replacement heading is a candidate', async () => {
    const disabled = await fixture(false);
    const transaction = EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Replacement', to: 10 } });
    disabled.component.observe(disabled.target.path, transaction);
    disabled.component.unload();
    const { app, caches, component, notify, source, target } = await fixture();
    component.observe(target.path, transaction);
    await app.vault.modify(target, '# Replacement\n');
    const cache = heading('Replacement');
    caches.set(target.path, { headings: [...cache.headings ?? [], ...cache.headings ?? []] });
    app.metadataCache.trigger('resolved');
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    expect(notify).not.toHaveBeenCalled();
    expect(await app.vault.read(source)).toContain('#Original');
    component.unload();
  });

  it('refuses Undo before changing any file if a later edit would be overwritten', async () => {
    const { app, component, source, target } = await fixture();
    await app.vault.modify(source, 'Later user edit');
    await expect(component.undo([
      { after: '# Original\n', before: '# Old\n', path: target.path },
      { after: 'Repaired link', before: 'Old link', path: source.path }
    ])).rejects.toThrow('changed after');
    expect(await app.vault.read(target)).toBe('# Original\n');
    expect(await app.vault.read(source)).toBe('Later user edit');
    component.unload();
  });

  it('rolls back earlier files when a later file write fails', async () => {
    const { app, component, source, target } = await fixture();
    const process = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, callback, options) => {
      if (file === source) {
        throw new Error('write failed');
      }
      return process(file, callback, options);
    });
    await expect(component.undo([
      { after: '# Original\n', before: '# Before\n', path: target.path },
      { after: '[[Target#Original|Label]]\n', before: 'Before', path: source.path }
    ])).rejects.toThrow('write failed');
    expect(await app.vault.read(target)).toBe('# Original\n');
    component.unload();
  });

  it('follows a heading cut into another note only after the matching paste', async () => {
    const { app, caches, component, notify, source, target } = await fixture();
    const destination = await app.vault.create('Destination.md', '');
    caches.set(destination.path, {});
    const state = EditorState.create({ doc: '# Original\n' });
    const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: state.doc.length } });
    component.observe(target.path, cut);
    await app.vault.modify(target, '');
    caches.set(target.path, {});
    expect(await app.vault.read(source)).toContain('Target#Original');
    const paste = EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: '# Original\n' } });
    component.observe(destination.path, paste);
    await app.vault.modify(destination, '# Original\n');
    caches.set(destination.path, heading('Original'));
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledOnce();
    });
    expect(await app.vault.read(source)).toBe('[[Destination#Original|Label]]\n');
    component.unload();
  });

  it('coalesces consecutive heading keystrokes without losing the original backlink snapshot', async () => {
    const { app, caches, component, notify, source, target } = await fixture();
    const first = EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'R', to: 10 } });
    component.observe(target.path, first);
    component.observe(target.path, first.state.update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 3, insert: 'Revised'.slice(1) } }));
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledOnce();
    });
    expect(await app.vault.read(source)).toContain('#Revised');
    component.unload();
  });

  it('moves block targets, refuses duplicate ids and preserves an id that remains in its original note', async () => {
    for (const scenario of ['unique', 'duplicate', 'remaining']) {
      const { app, caches, component, engine, notify, parsed, source, target } = await fixture();
      const text = 'A block. ^alpha\n';
      const blockCache: CachedMetadata = { blocks: { alpha: castTo({ id: 'alpha', position: position(text.trimEnd().length) }) } };
      await app.vault.modify(target, text);
      caches.set(target.path, blockCache);
      const sourceText = '[[Target#^alpha]]\n';
      await app.vault.modify(source, sourceText);
      const sourceCache: CachedMetadata = { links: [{ link: 'Target#^alpha', original: '[[Target#^alpha]]', position: position('[[Target#^alpha]]'.length) }] };
      caches.set(source.path, sourceCache);
      parsed.set(sourceText, sourceCache);
      parsed.set(text, blockCache);
      engine.updateMany([{ kind: 'changed', path: target.path }, { kind: 'changed', path: source.path }]);
      const destination = await app.vault.create('Destination.md', '');
      const state = EditorState.create({ doc: text });
      component.observe(target.path, state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: state.doc.length } }));
      await app.vault.modify(target, '');
      caches.set(target.path, scenario === 'remaining' ? blockCache : {});
      const pasted = scenario === 'duplicate' ? `${text}${text}` : text;
      component.observe(destination.path, EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: pasted } }));
      await app.vault.modify(destination, pasted);
      caches.set(destination.path, blockCache);
      app.metadataCache.trigger('resolved');
      await settle();
      if (scenario === 'unique') {
        await vi.waitFor(() => {
          expect(notify).toHaveBeenCalledOnce();
        });
        expect(await app.vault.read(source)).toBe('[[Destination#^alpha]]\n');
      } else {
        expect(notify).not.toHaveBeenCalled();
        expect(await app.vault.read(source)).toBe(sourceText);
      }
      component.unload();
    }
  });

  it.each(['rename', 'delete', 'disable', 'unload', 'body edit', 'missing metadata', 'missing target', 'missing source', 'unmatched paste', 'same note paste'])('invalidates pending evidence on %s', async (scenario) => {
    const { app, caches, component, isEnabledMock, notify, source, target } = await fixture();
    const state = EditorState.create({ doc: '# Original\n' });
    const edit = state.update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } });
    component.observe(target.path, edit);
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    switch (scenario) {
      case 'body edit': {
        component.observe(target.path, edit.state.update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: edit.state.doc.length, insert: 'Body' } }));
        break;
      }
      case 'delete': {
        app.vault.trigger('delete', target);
        break;
      }
      case 'disable': {
        isEnabledMock.mockReturnValue(false);
        break;
      }
      case 'missing metadata': {
        caches.delete(target.path);
        break;
      }
      case 'missing source': {
        await app.fileManager.trashFile(source);
        break;
      }
      case 'missing target': {
        await app.fileManager.trashFile(target);
        break;
      }
      case 'rename': {
        app.vault.trigger('rename', target, target.path);
        break;
      }
      case 'same note paste':
      case 'unmatched paste': {
        const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: state.doc.length } });
        component.observe(target.path, cut);
        const text = scenario === 'unmatched paste' ? 'Different' : '# Original\n';
        component.observe(target.path, cut.state.update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: text } }));
        break;
      }
      case 'unload': {
        component.unload();
        break;
      }
      default: {
        throw new Error(`Unknown scenario: ${scenario}`);
      }
    }
    app.metadataCache.trigger('changed', target, '# Revised\n', heading('Revised'));
    await settle();
    expect(notify).not.toHaveBeenCalled();
    component.unload();
  });

  it('aborts a cut parse when the plugin is unloaded and handles endpoint-free cuts', async () => {
    const { app, component, notify, parsed, target } = await fixture();
    const state = EditorState.create({ doc: 'Plain body\n' });
    const cut = state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: state.doc.length } });
    component.observe(target.path, cut);
    component.observe('Destination.md', EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: 'Plain body\n' } }));
    await settle();
    expect(notify).not.toHaveBeenCalled();
    parsed.set('Plain body\n', heading('Outside selection'));
    component.observe(target.path, cut);
    component.observe('Destination.md', EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: 'Plain body\n' } }));
    component.unload();
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(app.vault.getFileByPath(target.path)).toBe(target);
  });

  it('refuses a concurrent edit during Undo and rolls back files already restored', async () => {
    const { app, component, source, target } = await fixture();
    const process = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, callback, options) => {
      if (file === source) {
        await app.vault.modify(source, 'Concurrent edit');
      }
      component.observe(target.path, EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Self-write' } }));
      return process(file, callback, options);
    });
    await expect(component.undo([
      { after: '# Original\n', before: '# Before\n', path: target.path },
      { after: '[[Target#Original|Label]]\n', before: 'Before', path: source.path }
    ])).rejects.toThrow('concurrently');
    expect(await app.vault.read(target)).toBe('# Original\n');
    expect(await app.vault.read(source)).toBe('Concurrent edit');
    component.unload();
  });

  it('leaves unrelated, local and malformed links untouched while repairing a captured backlink', async () => {
    const { app, caches, component, notify, parsed, source, target } = await fixture();
    const original = '[[Target#Original|Label]]\n';
    const text = `${original}[[Missing]]\n[[#Original]]\n[[Target#%ZZ]]\n${'[[Target#Original]]'.replace('O', '%4F')}\n`;
    const references = [
      { link: 'Target#Original', original: '[[Target#Original|Label]]' },
      { link: 'Missing', original: '[[Missing]]' },
      { link: '#Original', original: '[[#Original]]' },
      { link: 'Target#%ZZ', original: '[[Target#%ZZ]]' },
      { link: 'Target#Original'.replace('O', '%4F'), original: '[[Target#Original]]'.replace('O', '%4F') }
    ];
    let offset = 0;
    parsed.set(text, {
      links: references.map((reference) => {
        const result = { ...reference, position: position(offset + reference.original.length, offset) };
        offset += reference.original.length + 1;
        return result;
      })
    });
    component.observe(target.path, EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('delete.backward'), changes: { from: 2, insert: 'Revised', to: 10 } }));
    await app.vault.modify(source, text);
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledOnce();
    });
    expect(await app.vault.read(source)).toBe(text.replace('Target#Original|Label', 'Target#Revised|Label'));
    component.unload();
  });

  it.each(['target changed', 'target removed', 'restored', 'disabled', 'source vanished'])('rechecks %s while parsing the backlink content', async (scenario) => {
    const { app, caches, component, isEnabledMock, notify, parsed, source, target } = await fixture();
    let shouldChange = true;
    vi.mocked(app.metadataCache.computeMetadataAsync).mockImplementation(async (buffer) => {
      if (shouldChange) {
        shouldChange = false;
        switch (scenario) {
          case 'disabled': {
            isEnabledMock.mockReturnValue(false);
            break;
          }
          case 'restored': {
            caches.set(target.path, heading('Original'));
            break;
          }
          case 'source vanished': {
            await app.fileManager.trashFile(source);
            break;
          }
          case 'target changed': {
            await app.vault.modify(target, '# Changed again\n');
            break;
          }
          case 'target removed': {
            await app.fileManager.trashFile(target);
            break;
          }
          default: {
            throw new Error(`Unknown scenario: ${scenario}`);
          }
        }
      }
      return parsed.get(new TextDecoder().decode(buffer)) ?? {};
    });
    component.observe(target.path, EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } }));
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    await settle();
    expect(notify).not.toHaveBeenCalled();
    component.unload();
  });

  it('repairs reference definitions while preserving the id, title and display uses, with one Undo', async () => {
    const { app, caches, component, engine, notify, parsed, source, target } = await fixture();
    const first = '[alpha]: Target#Original "Kept title"\n';
    const second = '[missing]: Missing#Absent\n';
    const text = `${first}${second}\n[Kept text][alpha]\n`;
    const cache: CachedMetadata = {
      referenceLinks: [
        { id: 'alpha', link: 'Target#Original', position: position(first.trimEnd().length) },
        { id: 'missing', link: 'Missing#Absent', position: position(first.length + second.trimEnd().length, first.length) }
      ]
    };
    parsed.set(text, cache);
    caches.set(source.path, cache);
    await app.vault.modify(source, text);
    engine.update({ kind: 'changed', path: source.path });
    component.observe(target.path, EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } }));
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledOnce();
    });
    const result = await app.vault.read(source);
    expect(result).toContain('[alpha]: Target.md#Revised "Kept title"');
    expect(result).toContain(second);
    expect(result).toContain('[Kept text][alpha]');
    const undo = castTo<() => Promise<void>>(notify.mock.calls[0]?.[1]);
    await undo();
    expect(await app.vault.read(source)).toBe(text);
    component.unload();
  });

  it('ignores programmatic heading edits and clipboard cuts that do not contain an entire target', async () => {
    const { component, notify, target } = await fixture();
    const state = EditorState.create({ doc: '# Original\n' });
    component.observe(target.path, state.update({ changes: { from: 2, insert: 'Revised', to: 10 } }));
    component.observe(target.path, state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: 1 } }));
    component.observe('Destination.md', EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: '#' } }));
    await settle();
    expect(notify).not.toHaveBeenCalled();
    component.unload();
  });

  it('propagates an I/O error from Undo instead of misreporting it as a missing file', async () => {
    const { app, component, source } = await fixture();
    vi.spyOn(app.vault, 'read').mockRejectedValue(new Error('Read denied'));
    await expect(component.undo([{ after: 'After', before: 'Before', path: source.path }])).rejects.toThrow('Read denied');
    expect(app.vault.getFileByPath(source.path)).toBe(source);
    component.unload();
  });

  it('surfaces a genuine write failure during automatic repair', async () => {
    using _ignoreExpectedError = startAsyncErrorIgnoreContext();
    const errors: unknown[] = [];
    using _handler = registerAsyncErrorEventHandler((error) => {
      errors.push(error);
    });
    const { app, caches, component, notify, source, target } = await fixture();
    vi.spyOn(app.vault, 'process').mockRejectedValue(new Error('Write denied'));
    component.observe(target.path, EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } }));
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errorToString(errors[0])).toContain('Write denied');
    expect(await app.vault.read(source)).toContain('#Original');
    expect(notify).not.toHaveBeenCalled();
    component.unload();
  });

  it('abandons a source that disappears while its backlink text is being read', async () => {
    const { app, caches, component, notify, source, target } = await fixture();
    const read = app.vault.read.bind(app.vault);
    vi.spyOn(app.vault, 'read').mockImplementation(async (file) => {
      if (file === source) {
        await app.fileManager.trashFile(source);
      }
      return read(file);
    });
    component.observe(target.path, EditorState.create({ doc: '# Original\n' }).update({ annotations: Transaction.userEvent.of('input.type'), changes: { from: 2, insert: 'Revised', to: 10 } }));
    await app.vault.modify(target, '# Revised\n');
    caches.set(target.path, heading('Revised'));
    app.metadataCache.trigger('resolved');
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(app.vault.getFileByPath(source.path)).toBeNull();
    component.unload();
  });

  it.each(['deleted', 'edited'])('preserves a file %s concurrently during a failed rollback', async (scenario) => {
    const { app, component, source, target } = await fixture();
    const process = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, callback, options) => {
      if (file === source) {
        if (scenario === 'deleted') {
          await app.fileManager.trashFile(target);
        } else {
          await app.vault.modify(target, 'Later edit');
        }
        throw new Error('Write denied');
      }
      return process(file, callback, options);
    });
    await expect(component.undo([
      { after: '# Original\n', before: '# Before\n', path: target.path },
      { after: '[[Target#Original|Label]]\n', before: 'Before', path: source.path }
    ])).rejects.toThrow('Write denied');
    if (scenario === 'deleted') {
      expect(app.vault.getFileByPath(target.path)).toBeNull();
    } else {
      expect(await app.vault.read(target)).toBe('Later edit');
    }
    component.unload();
  });

  it('repairs backlinks whose source moved along with their target', async () => {
    const { app, caches, component, engine, notify, parsed, target } = await fixture();
    const firstLine = '# Original\n';
    const selfLink = '[[Target#Original|Self]]';
    const text = `${firstLine}${selfLink}\n`;
    const cache: CachedMetadata = { ...heading('Original'), links: [{ link: 'Target#Original', original: selfLink, position: position(firstLine.length + selfLink.length, firstLine.length) }] };
    await app.vault.modify(target, text);
    caches.set(target.path, cache);
    parsed.set(text, cache);
    engine.update({ kind: 'changed', path: target.path });
    const destination = await app.vault.create('Destination.md', '');
    const state = EditorState.create({ doc: text });
    component.observe(target.path, state.update({ annotations: Transaction.userEvent.of('delete.cut'), changes: { from: 0, to: state.doc.length } }));
    await app.vault.modify(target, '');
    caches.set(target.path, {});
    component.observe(destination.path, EditorState.create({ doc: '' }).update({ annotations: Transaction.userEvent.of('input.paste'), changes: { from: 0, insert: text } }));
    await app.vault.modify(destination, text);
    caches.set(destination.path, cache);
    app.metadataCache.trigger('resolved');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledOnce();
    });
    const result = await app.vault.read(destination);
    expect(result).not.toContain('Target#Original');
    expect(result).toContain('#Original|Self');
    component.unload();
  });
});
