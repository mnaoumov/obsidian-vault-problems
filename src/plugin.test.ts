import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  CachedMetadata,
  PluginManifest,
  Reference
} from 'obsidian';

import { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { Plugin as ObsidianPlugin } from 'obsidian';
import {
  App,
  Plugin as PluginHost
} from 'obsidian-test-mocks/obsidian';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { LinkProblem } from './link-model.ts';

import { Plugin } from './plugin.ts';

describe('VaultProblems', () => {
  it('loads ignore settings, opens a registered sidebar from command and ribbon, and tolerates no available leaf', async () => {
    const app = App.createConfigured__().asOriginalType__();
    const manifest: PluginManifest = { author: 'test', description: 'test', id: 'vault-problems', minAppVersion: '1.14.5', name: 'Vault Problems', version: '0.0.0' };
    const plugin = new Plugin(app, manifest);
    expect(plugin.getProblems()).toEqual([]);
    vi.spyOn(plugin, 'loadData').mockResolvedValue({ ignoredPaths: ['Folder/**', 42] });
    const ribbon = vi.spyOn(plugin, 'addRibbonIcon');
    await plugin.onload();
    expect(plugin.ignoredPaths).toEqual(['Folder/**']);
    expect(plugin.getProblems()).toEqual([]);
    const command = ensureNonNullable(PluginHost.fromOriginalType2__(plugin).commands__.get('open-problems'));
    command.callback?.();
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    expect(app.workspace.getLeavesOfType('vault-problems')).toHaveLength(1);
    ensureNonNullable(ribbon.mock.calls[0])[2](new MouseEvent('click'));
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    expect(app.workspace.getLeavesOfType('vault-problems')).toHaveLength(1);
    vi.spyOn(app.workspace, 'getLeavesOfType').mockReturnValue([]);
    vi.spyOn(app.workspace, 'getRightLeaf').mockReturnValue(null);
    command.callback?.();
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    await app.vault.create('New.md', '');
    const problem: LinkProblem = { cause: { kind: 'rename', oldPath: 'Old.md', path: 'New.md' }, message: 'Missing', row: { id: 'old', key: null, kind: 'link', link: 'Old', position: null, sourcePath: 'Source.md', target: null, targetPath: null }, status: 'new' };
    const fixes = await plugin.problemFixes?.getFixes(problem);
    expect(fixes?.some((fix) => fix.label.startsWith('Use New.md'))).toBe(true);
    plugin.unload();
  });
  it('extends the Obsidian Plugin class', () => {
    expect(Plugin.prototype).toBeInstanceOf(ObsidianPlugin);
  });

  // The plugin's own `onload` runs here, so this proves the command is registered, not only imported.
  it('registers the Report a bug command', async () => {
    const manifest: PluginManifest = {
      author: 'test',
      description: 'test',
      id: 'test-plugin',
      minAppVersion: '0.0.0',
      name: 'Test Plugin',
      version: '0.0.0'
    };
    const plugin = new Plugin(App.createConfigured__().asOriginalType__(), manifest);
    await plugin.onload();
    expect(PluginHost.fromOriginalType2__(plugin).commands__.has('report-bug')).toBe(true);
    expect(PluginHost.fromOriginalType2__(plugin).commands__.has('sample')).toBe(false);
    expect(PluginHost.fromOriginalType2__(plugin).commands__.has('sample-editor')).toBe(false);
    plugin.unload();
  });

  it('shows a plugin-owned notice naming newly broken links', async () => {
    const app = App.createConfigured__().asOriginalType__();
    const source = await app.vault.create('Source.md', '');
    const target = await app.vault.create('Target.md', '');
    const cache: CachedMetadata = { frontmatterLinks: [{ key: 'related', link: 'Target', original: '[[Target]]' }] };
    vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((file) => file === source ? cache : {});
    vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockImplementation(() => app.vault.getFileByPath(target.path));
    app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [] });
    const manifest: PluginManifest = {
      author: 'test',
      description: 'test',
      id: 'test-plugin',
      minAppVersion: '0.0.0',
      name: 'Test Plugin',
      version: '0.0.0'
    };
    const plugin = new Plugin(app, manifest);
    await plugin.onload();
    const notice = vi.spyOn(PluginNoticeComponent.prototype, 'showNotice');
    plugin.linkEngine?.initialize();
    await app.fileManager.trashFile(target);
    plugin.linkEngine?.update({ kind: 'delete', path: target.path });
    expect(notice).toHaveBeenCalledWith('1 link(s) just broke: Target');
    plugin.unload();
  });
});
