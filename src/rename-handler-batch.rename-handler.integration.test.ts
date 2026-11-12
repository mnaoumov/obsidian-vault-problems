import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { AdvancedRenameAndDeleteHandlerApi } from './advanced-rename-and-delete-handler/api.d.ts';
import type { Plugin } from './plugin.ts';

interface ObsidianLibStateLike {
  readonly pluginApiRegistry?: PluginApiRegistryWrapperLike;
}

interface PluginApiRecordLike {
  readonly api: AdvancedRenameAndDeleteHandlerApi;
  readonly apiVersion: string;
  readonly isRevoked: boolean;
}

interface PluginApiRegistryLike {
  readonly records: Readonly<Record<string, readonly PluginApiRecordLike[]>>;
}

interface PluginApiRegistryWrapperLike {
  readonly value: PluginApiRegistryLike;
}

interface RegistryHolder {
  readonly __obsidianLib?: ObsidianLibStateLike;
}

// The released provider runs beside this plugin; the suite reaches its published API through the documented
// Registry wire protocol, as a plugin without `@mnaoumov/obsidian-lib` would.
describe('Rename handler bulk operations', () => {
  it('holds the snapshot across moveMany and compares once at its end', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const engine = plugin.linkEngine;
        if (!engine) {
          throw new Error('The link engine did not load.');
        }
        const timeoutInMilliseconds = 8000;
        function getApi(): AdvancedRenameAndDeleteHandlerApi | undefined {
          return (globalThis as RegistryHolder).__obsidianLib?.pluginApiRegistry?.value.records['advanced-rename-and-delete-handler']
            ?.find((record) => !record.isRevoked && record.apiVersion === '1.4.0')?.api;
        }
        await waitUntil({ message: 'the provider publishes contract 1.4.0', predicate: () => Boolean(getApi()), timeoutInMilliseconds });
        const api = getApi();
        if (!api) {
          throw new Error('The provider API is unavailable.');
        }
        const root = 'rename-handler-move-many';
        await app.vault.createFolder(root);
        const changes: string[][] = [];
        const ref = engine.onChanged((change) => {
          changes.push([...change.sourcePaths]);
        });
        const deferredDuringMove: boolean[] = [];
        const renameRef = app.vault.on('rename', () => {
          // An update made mid-operation must wait for the provider's end notification.
          const before = changes.length;
          engine.update({ kind: 'changed', path: `${root}/Source.md` });
          deferredDuringMove.push(changes.length === before);
        });
        try {
          await app.vault.create(`${root}/A.md`, '# Heading\n');
          await app.vault.create(`${root}/B.md`, '');
          const source = await app.vault.create(`${root}/Source.md`, `[[${root}/A#Heading]] [[${root}/B]]\n`);
          await waitUntil({ message: 'both links resolve before the move', predicate: () => engine.getRows(source.path).filter((row) => row.target).length === 2, timeoutInMilliseconds });
          changes.length = 0;
          await api.moveMany({
            moves: [
              { newPath: `${root}/Moved/A.md`, oldPath: `${root}/A.md` },
              { newPath: `${root}/Moved/B.md`, oldPath: `${root}/B.md` }
            ]
          });
          const changesAtEnd = changes.length;
          await waitUntil({ message: 'the rewritten links resolve to the moved notes', predicate: () => engine.getRows(source.path).filter((row) => row.target?.path.includes('/Moved/')).length === 2, timeoutInMilliseconds });
          return {
            changesAtEnd,
            deferredDuringMove,
            problems: engine.getProblems(source.path).length,
            targets: engine.getRows(source.path).map((row) => row.target?.path ?? null)
          };
        } finally {
          engine.offref(ref);
          app.vault.offref(renameRef);
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result.deferredDuringMove).toEqual([true, true]);
    expect(result.changesAtEnd).toBeGreaterThan(0);
    expect(result.problems).toBe(0);
    expect(result.targets).toEqual(['rename-handler-move-many/Moved/A.md', 'rename-handler-move-many/Moved/B.md']);
  });

  it('closes the batch when runInBatch fails part-way', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const engine = plugin.linkEngine;
        if (!engine) {
          throw new Error('The link engine did not load.');
        }
        const timeoutInMilliseconds = 8000;
        function getApi(): AdvancedRenameAndDeleteHandlerApi | undefined {
          return (globalThis as RegistryHolder).__obsidianLib?.pluginApiRegistry?.value.records['advanced-rename-and-delete-handler']
            ?.find((record) => !record.isRevoked && record.apiVersion === '1.4.0')?.api;
        }
        await waitUntil({ message: 'the provider publishes contract 1.4.0', predicate: () => Boolean(getApi()), timeoutInMilliseconds });
        const api = getApi();
        if (!api) {
          throw new Error('The provider API is unavailable.');
        }
        const root = 'rename-handler-run-in-batch';
        await app.vault.createFolder(root);
        const changes: string[][] = [];
        const ref = engine.onChanged((change) => {
          changes.push([...change.sourcePaths]);
        });
        let isDeferredInside = false;
        let errorMessage = '';
        try {
          const target = await app.vault.create(`${root}/Target.md`, '');
          const source = await app.vault.create(`${root}/Source.md`, `[[${root}/Target]]\n`);
          await waitUntil({ message: 'the link resolves before the batch', predicate: () => engine.getRows(source.path)[0]?.target !== null && engine.getRows(source.path).length === 1, timeoutInMilliseconds });
          try {
            await api.runInBatch(async () => {
              await app.fileManager.renameFile(target, `${root}/Renamed.md`);
              const before = changes.length;
              engine.update({ kind: 'changed', path: source.path });
              isDeferredInside = changes.length === before;
              throw new Error('Planned failure');
            });
          } catch (error) {
            errorMessage = String(error);
          }
          const changesAfterFailure = changes.length;
          // After the failed batch, the engine compares immediately again.
          const before = changes.length;
          engine.update({ kind: 'changed', path: source.path });
          return { changesAfterFailure, errorMessage, isDeferredInside, isImmediateAfter: changes.length === before + 1 };
        } finally {
          engine.offref(ref);
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result.errorMessage).toContain('Planned failure');
    expect(result.isDeferredInside).toBe(true);
    expect(result.changesAfterFailure).toBeGreaterThan(0);
    expect(result.isImmediateAfter).toBe(true);
  });
});
