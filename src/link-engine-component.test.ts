import { noop } from '@mnaoumov/typescript-lib/function';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { LinkEngineComponent } from './link-engine-component.ts';
import { LinkEngine } from './link-engine.ts';

describe('LinkEngineComponent', () => {
  it('observes metadata changes, coalesces file operations until resolved and unregisters on unload', async () => {
    const app = App.createConfigured__().asOriginalType__();
    const file = await app.vault.create('Source.md', '');
    const folder = await app.vault.createFolder('Folder');
    const layouts: (() => void)[] = [];
    vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation((callback) => {
      layouts.push(callback);
    });
    const engine = new LinkEngine({ app, notify: noop });
    const initialize = vi.spyOn(engine, 'initialize').mockImplementation(noop);
    const update = vi.spyOn(engine, 'update').mockImplementation(noop);
    const updateMany = vi.spyOn(engine, 'updateMany').mockImplementation(noop);
    const component = new LinkEngineComponent({ app, engine });
    component.load();
    ensureNonNullable(layouts[0])();
    expect(initialize).toHaveBeenCalledOnce();
    app.metadataCache.trigger('changed', file, '', {});
    app.metadataCache.trigger('resolve', file);
    expect(update.mock.calls).toEqual([[{ kind: 'changed', path: file.path }], [{ kind: 'resolved', path: file.path }]]);
    app.vault.trigger('rename', folder, 'OldFolder');
    app.vault.trigger('delete', folder);
    app.vault.trigger('rename', file, 'OldSource.md');
    app.metadataCache.trigger('changed', file, '', {});
    app.metadataCache.trigger('resolve', file);
    app.vault.trigger('delete', file);
    expect(updateMany).not.toHaveBeenCalled(); // File operations wait for final link resolution.
    app.metadataCache.trigger('resolved');
    expect(updateMany).toHaveBeenCalledWith([
      { kind: 'rename', oldPath: 'OldSource.md', path: file.path },
      { kind: 'changed', path: file.path },
      { kind: 'resolved', path: file.path },
      { kind: 'delete', path: file.path }
    ]);
    component.unload();
    app.metadataCache.trigger('changed', file, '', {});
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('does not initialize a plugin that was unloaded before layout ready', () => {
    const app = App.createConfigured__().asOriginalType__();
    const layouts: (() => void)[] = [];
    vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation((callback) => {
      layouts.push(callback);
    });
    const engine = new LinkEngine({ app, notify: noop });
    const initialize = vi.spyOn(engine, 'initialize');
    const component = new LinkEngineComponent({ app, engine });
    component.load();
    component.unload();
    ensureNonNullable(layouts[0])();
    expect(initialize).not.toHaveBeenCalled();
  });
});
