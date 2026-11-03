import type { PluginManifest } from 'obsidian';

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
    expect(tab.getSettingDefinitions()).toMatchObject([{ control: { defaultValue: true, key: 'isAutoRepairEnabled', type: 'toggle' }, name: 'Automatically repair links' }, { control: { defaultValue: '', key: 'ignoredPaths', type: 'textarea' } }]);
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

  it.each([null, 'invalid', {}, { isAutoRepairEnabled: true }, { isAutoRepairEnabled: 'invalid' }])('defaults to enabled with %j data', async (data) => {
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
