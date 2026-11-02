import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  CachedMetadata,
  PluginManifest,
  Reference
} from 'obsidian';

import { PluginNoticeComponent } from '@mnaoumov/obsidian-lib/components/plugin-notice-component';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
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

import { Plugin } from './plugin.ts';

describe('VaultProblems', () => {
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
