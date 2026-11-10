import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  App as AppOriginal,
  PluginManifest,
  Reference
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
  AdvancedRenameAndDeleteHandlerApi,
  BulkOperationListener
} from './advanced-rename-and-delete-handler/api.d.ts';

import { LinkEngine } from './link-engine.ts';
import {
  ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID,
  RenameHandlerBatchComponent
} from './rename-handler-batch-component.ts';

interface Provider {
  readonly listeners: Set<BulkOperationListener>;
  readonly owner: Component;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
}

interface Setup {
  readonly app: AppOriginal;
  readonly applied: string[][];
  readonly component: RenameHandlerBatchComponent;
  readonly engine: LinkEngine;
}

/**
 Stands in for the provider plugin, which only keys the published record.
 */
class ProviderPlugin extends Plugin {}

const owners: Component[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.unload();
  }
});

function emit(provider: Provider, notification: Parameters<BulkOperationListener>[0]): void {
  for (const listener of provider.listeners) {
    // The provider does not await an observer's promise either.
    listener(notification)?.catch(noop);
  }
}

function publish(app: AppOriginal): Provider {
  const listeners = new Set<BulkOperationListener>();
  const owner = new Component();
  owner.load();
  owners.push(owner);
  const unsubscribe = vi.fn();
  const api: AdvancedRenameAndDeleteHandlerApi = {
    getSettings: vi.fn(),
    isPathIgnored: vi.fn(),
    isTreatedAsAttachment: vi.fn(),
    migrateSettings: vi.fn(),
    moveMany: vi.fn(),
    runInBatch: vi.fn(),
    subscribeBulkOperations: (listener) => {
      listeners.add(listener);
      return (): void => {
        unsubscribe();
        listeners.delete(listener);
      };
    }
  };
  publishPluginApi({
    api,
    apiVersion: '1.4.0',
    component: owner,
    plugin: new ProviderPlugin(app, castTo<PluginManifest>({ id: ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID }))
  });
  return { listeners, owner, unsubscribe };
}

async function setup(): Promise<Setup> {
  const app = App.createConfigured__().asOriginalType__();
  app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [] });
  await app.vault.create('Source.md', '');
  const engine = new LinkEngine({ app, notify: noop });
  engine.initialize();
  const applied: string[][] = [];
  engine.onChanged((change) => {
    applied.push([...change.sourcePaths]);
  });
  const component = new RenameHandlerBatchComponent({ app, engine });
  owners.push(component);
  return { app, applied, component, engine };
}

describe('RenameHandlerBatchComponent', () => {
  it('defers engine comparisons from start to end, also for a failed operation', async () => {
    const { app, applied, component, engine } = await setup();
    const provider = publish(app);
    component.load();
    expect(provider.listeners.size).toBe(1);

    emit(provider, { operation: 'moveMany', phase: 'start' });
    engine.update({ kind: 'changed', path: 'Source.md' });
    engine.update({ kind: 'changed', path: 'Source.md' });
    expect(applied).toEqual([]);
    emit(provider, { isSuccessful: false, operation: 'moveMany', phase: 'end' });
    expect(applied).toEqual([['Source.md']]);

    // A repeated start opens one batch, and an unmatched end is ignored.
    emit(provider, { operation: 'runInBatch', phase: 'start' });
    emit(provider, { isReplay: true, operation: 'runInBatch', phase: 'start' });
    engine.update({ kind: 'changed', path: 'Source.md' });
    emit(provider, { isSuccessful: true, operation: 'runInBatch', phase: 'end' });
    emit(provider, { isSuccessful: true, operation: 'runInBatch', phase: 'end' });
    engine.update({ kind: 'changed', path: 'Source.md' });
    expect(applied).toHaveLength(3);
  });

  it('closes an open batch when the provider unloads, and reconnects to a new provider', async () => {
    const { app, applied, component, engine } = await setup();
    component.load();
    const first = publish(app);
    await vi.waitFor(() => {
      expect(first.listeners.size).toBe(1);
    });
    emit(first, { operation: 'moveMany', phase: 'start' });
    engine.update({ kind: 'changed', path: 'Source.md' });
    first.owner.unload();
    await vi.waitFor(() => {
      expect(applied).toEqual([['Source.md']]);
    });
    expect(first.unsubscribe).toHaveBeenCalledOnce();

    const second = publish(app);
    await vi.waitFor(() => {
      expect(second.listeners.size).toBe(1);
    });
    emit(second, { operation: 'runInBatch', phase: 'start' });
    engine.update({ kind: 'changed', path: 'Source.md' });
    component.unload();
    expect(applied).toHaveLength(2);
    expect(second.listeners.size).toBe(0);
    emit(second, { isSuccessful: true, operation: 'runInBatch', phase: 'end' });
    expect(ensureNonNullable(applied[1])).toEqual(['Source.md']);
  });

  it('stays idle while the provider is absent', async () => {
    const { applied, component, engine } = await setup();
    component.load();
    engine.update({ kind: 'changed', path: 'Source.md' });
    expect(applied).toHaveLength(1);
    component.unload();
  });
});
