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

  public override getControlValue(): boolean {
    return this.owner.isAutoRepairEnabled;
  }

  public override getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      control: { defaultValue: true, key: 'isAutoRepairEnabled', type: 'toggle' },
      desc: 'Follow unambiguous heading edits and cut-and-paste moves. Each repair offers undo. Turning this off keeps problems reported without changing notes.',
      name: 'Automatically repair links'
    }];
  }

  public override async setControlValue(_key: string, value: unknown): Promise<void> {
    if (typeof value !== 'boolean') {
      throw new TypeError('The repair setting must be a boolean.');
    }
    await this.owner.setAutoRepairEnabled(value);
  }
}
