import { OpenBugReportCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-bug-report-command-handler';
import { OpenDemoVaultCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-demo-vault-command-handler';
import { PluginBase } from '@mnaoumov/obsidian-lib/plugin/plugin';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';

import { AutoRepairComponent } from './auto-repair-component.ts';
import { LinkEngineComponent } from './link-engine-component.ts';
import { LinkEngine } from './link-engine.ts';
import { showRepairNotice } from './repair-notice.ts';
import { RepairSettingTab } from './repair-setting-tab.ts';

export class Plugin extends PluginBase {
  /**
  Whether editor operations may repair links automatically.
  */
  public isAutoRepairEnabled = true;

  /**
  The shared diagnostics source used by views and editor extensions.
  */
  public linkEngine: LinkEngine | null = null;

  /**
  Saves the repair preference without discarding other plugin data.
  */
  public async setAutoRepairEnabled(isEnabled: boolean): Promise<void> {
    this.isAutoRepairEnabled = isEnabled;
    const data: unknown = await this.loadData();
    await this.saveData({ ...(typeof data === 'object' && data !== null && data), isAutoRepairEnabled: isEnabled });
  }

  protected override async onloadImpl(): Promise<void> {
    const data: unknown = await this.loadData();
    this.isAutoRepairEnabled = !(typeof data === 'object' && data !== null && 'isAutoRepairEnabled' in data && data.isAutoRepairEnabled === false);
    this.linkEngine = new LinkEngine({
      app: this.app,
      notify: (problems): void => {
        this.pluginNoticeComponent.showNotice(`${String(problems.length)} link(s) just broke: ${problems.map((problem) => problem.row.link).join(', ')}`);
      }
    });
    this.addChild(new LinkEngineComponent({ app: this.app, engine: this.linkEngine }));
    const repairs = this.addChild(
      new AutoRepairComponent({
        app: this.app,
        engine: this.linkEngine,
        isEnabled: (): boolean => this.isAutoRepairEnabled,
        notify: showRepairNotice.bind(undefined, this.pluginNoticeComponent),
        resourceLockComponent: this.resourceLockComponent
      })
    );
    // Obsidian's CJS declarations and CodeMirror's ESM declarations have distinct private type identities.
    this.registerEditorExtension(castTo(repairs.extension));
    this.addSettingTab(new RepairSettingTab(this.app, this));

    // `OpenDemoVaultCommandHandler` is what makes the README's first demo-vault route real: it downloads
    // The `<plugin-id>-demo-vault.zip` attached to the GitHub release and opens it as a vault in
    // A new window. It is not registered automatically -- a demo vault without this command can only be
    // Reached by downloading the asset by hand. It hides itself on mobile, so no platform guard is needed.
    await this.commandHandlerComponent.registerCommandHandlers(() => [
      // `OpenBugReportCommandHandler` opens the bug form in `.github/ISSUE_TEMPLATE/` with the plugin version, the
      // Obsidian version and the operating system already filled in, which is why it is registered only with the forms.
      new OpenBugReportCommandHandler({
        app: this.app,
        gitHubRepo: 'mnaoumov/obsidian-vault-problems',
        pluginId: this.manifest.id
      }),
      new OpenDemoVaultCommandHandler({
        app: this.app,
        pluginId: this.manifest.id,
        pluginNoticeComponent: this.pluginNoticeComponent,
        pluginVersion: this.manifest.version
      })
    ]);
  }
}
