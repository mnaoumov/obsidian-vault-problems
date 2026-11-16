import type { PluginManifest } from 'obsidian';

import { ExternalAttachmentLinkMode } from '@mnaoumov/obsidian-lib/misplaced-attachment';
import { PathCompatibilityPlatform } from '@mnaoumov/obsidian-lib/path-compatibility';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { Plugin } from './plugin.ts';
import { RepairSettingTab } from './repair-setting-tab.ts';

const manifest: PluginManifest = { author: 'test', description: 'test', id: 'vault-problems', minAppVersion: '1.14.5', name: 'Vault Problems', version: '0.0.0' };

describe('Repair preference', () => {
  it('publishes a searchable toggle and saves its value while preserving other data', async () => {
    const app = App.createConfigured__().asOriginalType__();
    const plugin = new Plugin(app, manifest);
    vi.spyOn(plugin, 'loadData').mockResolvedValue({ isAutoRepairEnabled: false, other: 'kept' });
    const save = vi.spyOn(plugin, 'saveData').mockResolvedValue();
    await plugin.onload();
    app.metadataCache.trigger('resolved');
    const tab = new RepairSettingTab(app, plugin);
    expect(tab.getControlValue()).toBe(false);
    expect(tab.getSettingDefinitions().slice(0, 2)).toMatchObject([{ control: { defaultValue: true, key: 'isAutoRepairEnabled', type: 'toggle' }, name: 'Automatically repair links' }, { control: { defaultValue: '', key: 'ignoredPaths', type: 'textarea' } }]);
    await tab.setControlValue('isAutoRepairEnabled', true);
    expect(tab.getControlValue()).toBe(true);
    expect(save).toHaveBeenCalledWith({ isAutoRepairEnabled: true, other: 'kept' });
    await tab.setControlValue('ignoredPaths', 'Folder/**\nArchive');
    expect(tab.getControlValue('ignoredPaths')).toBe('Folder/**\nArchive');
    expect(save).toHaveBeenCalledWith({ ignoredPaths: ['Folder/**', 'Archive'], isAutoRepairEnabled: false, other: 'kept' });
    await expect(tab.setControlValue('ignoredPaths', 42)).rejects.toThrow('must be a boolean');
    await expect(tab.setControlValue('isAutoRepairEnabled', 'invalid')).rejects.toThrow('must be a boolean');
    plugin.unload();
  });

  it('saves and validates the path and misplaced-attachment settings', async () => {
    const app = App.createConfigured__().asOriginalType__();
    const plugin = new Plugin(app, manifest);
    // Layout ready at once, so the path and attachment checks read the settings through the plugin.
    vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation((callback) => {
      callback();
    });
    vi.spyOn(plugin, 'loadData').mockResolvedValue({ externalAttachmentLinkMode: 'ReportUnowned', forbiddenCharacterReplacement: '_', maxVaultRootPathLength: 40, pathCompatibilityPlatforms: ['Linux', 'Unknown'] });
    const save = vi.spyOn(plugin, 'saveData').mockResolvedValue();
    await app.vault.create('Bad:name.md', '');
    await plugin.onload();
    const pathProblem = ensureNonNullable(plugin.getProblems().find((problem) => problem.row.kind === 'path'));
    // The quick fix reads the replacement from the plugin's settings.
    const pathFixes = await ensureNonNullable(plugin.problemFixes).getFixes(pathProblem);
    expect(pathFixes.map((fix) => fix.label)).toEqual(['Rename to Bad_name.md']);
    const tab = new RepairSettingTab(app, plugin);
    expect(tab.getControlValue('externalAttachmentLinkMode')).toBe(ExternalAttachmentLinkMode.ReportUnowned);
    expect(tab.getControlValue('forbiddenCharacterReplacement')).toBe('_');
    expect(tab.getControlValue('maxVaultRootPathLength')).toBe(40);
    expect(tab.getControlValue('pathCompatibility:Linux')).toBe(true);
    expect(tab.getControlValue('pathCompatibility:Windows')).toBe(false);
    expect(plugin.getPathRepairScope()).toEqual({ forbiddenCharacterReplacement: '_', maxVaultRootPathLength: 40, platforms: [PathCompatibilityPlatform.Linux] });
    await tab.setControlValue('pathCompatibility:Windows', true);
    expect(plugin.pathCompatibilityPlatforms).toContain(PathCompatibilityPlatform.Windows);
    await tab.setControlValue('forbiddenCharacterReplacement', '');
    await expect(tab.setControlValue('forbiddenCharacterReplacement', ':')).rejects.toThrow();
    await tab.setControlValue('maxVaultRootPathLength', 0);
    expect(plugin.getPathRepairScope().maxVaultRootPathLength).toBeGreaterThanOrEqual(0);
    await expect(tab.setControlValue('maxVaultRootPathLength', -1)).rejects.toThrow('whole number');
    await tab.setControlValue('externalAttachmentLinkMode', ExternalAttachmentLinkMode.Ignore);
    await expect(tab.setControlValue('externalAttachmentLinkMode', 'Other')).rejects.toThrow('listed modes');
    // The mocked loadData returns the original data each time, so every save carries it plus the one changed value.
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ forbiddenCharacterReplacement: '' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ maxVaultRootPathLength: 0 }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ externalAttachmentLinkMode: ExternalAttachmentLinkMode.Ignore, forbiddenCharacterReplacement: '_' }));
    plugin.unload();
  });

  it.each([null, 'invalid', {}, { isAutoRepairEnabled: true }, { externalAttachmentLinkMode: 'invalid', isAutoRepairEnabled: 'invalid' }])('defaults to enabled with %j data', async (data) => {
    const app = App.createConfigured__().asOriginalType__();
    const plugin = new Plugin(app, manifest);
    vi.spyOn(plugin, 'loadData').mockResolvedValue(data);
    const save = vi.spyOn(plugin, 'saveData').mockResolvedValue();
    await plugin.onload();
    expect(plugin.isAutoRepairEnabled).toBe(true);
    await plugin.setAutoRepairEnabled(false);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ isAutoRepairEnabled: false }));
    plugin.unload();
  });
});
