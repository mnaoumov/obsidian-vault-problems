import type {
  App,
  SettingDefinitionItem
} from 'obsidian';

import { ExternalAttachmentLinkMode } from '@mnaoumov/obsidian-lib/misplaced-attachment';
import {
  getCurrentPathCompatibilityPlatform,
  PATH_COMPATIBILITY_PLATFORM_LABELS,
  PATH_COMPATIBILITY_PLATFORMS
} from '@mnaoumov/obsidian-lib/path-compatibility';
import { PluginSettingTab } from 'obsidian';

import type { Plugin } from './plugin.ts';

/**
The key prefix of the one toggle per platform; the platform follows it.
*/
const PLATFORM_KEY_PREFIX = 'pathCompatibility:';

const EXTERNAL_ATTACHMENT_LINK_MODE_LABELS: Readonly<Record<ExternalAttachmentLinkMode, string>> = {
  [ExternalAttachmentLinkMode.Ignore]: 'Ignore',
  [ExternalAttachmentLinkMode.Report]: 'Report',
  [ExternalAttachmentLinkMode.ReportUnowned]: 'Report unowned'
};

/**
The plugin's settings, each persisted with the plugin's own data.
*/
export class RepairSettingTab extends PluginSettingTab {
  private readonly owner: Plugin;

  public constructor(app: App, plugin: Plugin) {
    super(app, plugin);
    this.owner = plugin;
  }

  public override getControlValue(key = 'isAutoRepairEnabled'): boolean | number | string {
    const platform = PATH_COMPATIBILITY_PLATFORMS.find((candidate) => key === `${PLATFORM_KEY_PREFIX}${candidate}`);
    if (platform) {
      return this.owner.pathCompatibilityPlatforms.includes(platform);
    }
    switch (key) {
      case 'externalAttachmentLinkMode': {
        return this.owner.externalAttachmentLinkMode;
      }
      case 'forbiddenCharacterReplacement': {
        return this.owner.forbiddenCharacterReplacement;
      }
      case 'ignoredPaths': {
        return this.owner.ignoredPaths.join('\n');
      }
      case 'maxVaultRootPathLength': {
        return this.owner.maxVaultRootPathLength;
      }
      default: {
        return this.owner.isAutoRepairEnabled;
      }
    }
  }

  public override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        control: { defaultValue: true, key: 'isAutoRepairEnabled', type: 'toggle' },
        desc: 'Follow unambiguous heading edits and cut-and-paste moves. Each repair offers undo. Turning this off keeps problems reported without changing notes.',
        name: 'Automatically repair links'
      },
      {
        control: { defaultValue: '', key: 'ignoredPaths', type: 'textarea' },
        desc: 'One vault-relative path, folder or glob per line. Use * for part of a name, ** for any folders, and ? for one character.',
        name: 'Ignore paths in Problems'
      },
      ...PATH_COMPATIBILITY_PLATFORMS.map((platform): SettingDefinitionItem => ({
        control: { defaultValue: platform === getCurrentPathCompatibilityPlatform(), key: `${PLATFORM_KEY_PREFIX}${platform}`, type: 'toggle' },
        desc: `Report every file and folder name that ${PATH_COMPATIBILITY_PLATFORM_LABELS[platform]} cannot store, for a vault synced there.`,
        name: `Path compatibility: ${PATH_COMPATIBILITY_PLATFORM_LABELS[platform]}`
      })),
      {
        control: { defaultValue: 0, key: 'maxVaultRootPathLength', min: 0, type: 'number' },
        desc: 'The length, in characters, of the deepest folder this vault is synced to. 0 uses this vault\'s own folder.',
        name: 'Longest vault folder path'
      },
      {
        control: { defaultValue: '-', key: 'forbiddenCharacterReplacement', type: 'text' },
        desc: 'What a path quick fix puts in place of each character a platform forbids. Leave empty to delete the character.',
        name: 'Forbidden character replacement'
      },
      {
        control: { defaultValue: ExternalAttachmentLinkMode.Report, key: 'externalAttachmentLinkMode', options: EXTERNAL_ATTACHMENT_LINK_MODE_LABELS, type: 'dropdown' },
        desc: 'A note linking an attachment outside its own attachment folder: report every such link, only links to an attachment no linking note owns, or none.',
        name: 'Misplaced attachments'
      }
    ];
  }

  public override async setControlValue(key: string, value: unknown): Promise<void> {
    const platform = PATH_COMPATIBILITY_PLATFORMS.find((candidate) => key === `${PLATFORM_KEY_PREFIX}${candidate}`);
    if (platform && typeof value === 'boolean') {
      await this.owner.setPathCompatibilityPlatform(platform, value);
      return;
    }
    if (key === 'ignoredPaths' && typeof value === 'string') {
      await this.owner.setIgnoredPaths(value);
      return;
    }
    if (key === 'forbiddenCharacterReplacement' && typeof value === 'string') {
      await this.owner.setForbiddenCharacterReplacement(value);
      return;
    }
    if (key === 'maxVaultRootPathLength' && typeof value === 'number') {
      await this.owner.setMaxVaultRootPathLength(value);
      return;
    }
    if (key === 'externalAttachmentLinkMode') {
      const mode = Object.values(ExternalAttachmentLinkMode).find((candidate) => candidate === value);
      if (!mode) {
        throw new TypeError('The misplaced attachments setting must be one of its listed modes.');
      }
      await this.owner.setExternalAttachmentLinkMode(mode);
      return;
    }
    if (typeof value !== 'boolean') {
      throw new TypeError('The repair setting must be a boolean.');
    }
    await this.owner.setAutoRepairEnabled(value);
  }
}
