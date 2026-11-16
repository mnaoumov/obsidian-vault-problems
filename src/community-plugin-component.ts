import type { App } from 'obsidian';

import { ComponentEx } from '@mnaoumov/obsidian-lib/components/component-ex';

import type { LinkEngine } from './link-engine.ts';

/**
The config file, inside the vault's config folder, that lists the enabled community plugins.
*/
const COMMUNITY_PLUGINS_CONFIG_FILE_NAME = 'community-plugins.json';

/**
Lifecycle dependencies for the community-plugin check.
*/
export interface CommunityPluginComponentConstructorParams {
  readonly app: App;
  readonly engine: LinkEngine;
}

/**
Feeds the engine an enabled community plugin id with no installed plugin. Obsidian skips such an id at startup without
a notice, so a plugin that changed its id or was deleted by hand stays listed and never loads.
*/
export class CommunityPluginComponent extends ComponentEx {
  private readonly app: App;
  private readonly engine: LinkEngine;

  public constructor(params: CommunityPluginComponentConstructorParams) {
    super();
    this.app = params.app;
    this.engine = params.engine;
  }

  public override onload(): void {
    this.app.workspace.onLayoutReady(() => {
      // The registry fires `changed` after each manifest load, enable, disable, install and uninstall.
      this.registerEvent(this.app.plugins.on('changed', () => {
        this.check();
      }));
      this.check();
    });
  }

  /**
  Compares the enabled ids with the installed manifests.
  */
  private check(): void {
    const { enabledPlugins, manifests } = this.app.plugins;
    const missingIds = [...enabledPlugins].filter((id) => !Object.hasOwn(manifests, id)).sort((left, right) => left.localeCompare(right));
    this.engine.setMissingCommunityPlugins(getCommunityPluginsConfigPath(this.app), missingIds);
  }
}

/**
Where Obsidian keeps the enabled community plugin ids.
*/
export function getCommunityPluginsConfigPath(app: App): string {
  return `${app.vault.configDir}/${COMMUNITY_PLUGINS_CONFIG_FILE_NAME}`;
}
