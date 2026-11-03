import type {
  App,
  SettingDefinitionItem
} from 'obsidian';

import { PluginSettingTab } from 'obsidian';

import type { Plugin } from './plugin.ts';

/**
The repair switch is persisted with the plugin's own data.
*/
export class RepairSettingTab extends PluginSettingTab {
  private readonly owner: Plugin;

  public constructor(app: App, plugin: Plugin) {
    super(app, plugin);
    this.owner = plugin;
  }

  public override getControlValue(key = 'isAutoRepairEnabled'): boolean | string {
    return key === 'ignoredPaths' ? this.owner.ignoredPaths.join('\n') : this.owner.isAutoRepairEnabled;
  }

  public override getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      control: { defaultValue: true, key: 'isAutoRepairEnabled', type: 'toggle' },
      desc: 'Follow unambiguous heading edits and cut-and-paste moves. Each repair offers undo. Turning this off keeps problems reported without changing notes.',
      name: 'Automatically repair links'
    }, {
      control: { defaultValue: '', key: 'ignoredPaths', type: 'textarea' },
      desc: 'One vault-relative path, folder or glob per line. Use * for part of a name, ** for any folders, and ? for one character.',
      name: 'Ignore paths in Problems'
    }];
  }

  public override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === 'ignoredPaths' && typeof value === 'string') {
      await this.owner.setIgnoredPaths(value);
      return;
    }
    if (typeof value !== 'boolean') {
      throw new TypeError('The repair setting must be a boolean.');
    }
    await this.owner.setAutoRepairEnabled(value);
  }
}
