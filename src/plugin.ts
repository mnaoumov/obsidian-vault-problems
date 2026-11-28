import type { StateField } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MarkdownFileInfo } from 'obsidian';

import { OpenBugReportCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-bug-report-command-handler';
import { OpenDemoVaultCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-demo-vault-command-handler';
import { ExternalAttachmentLinkMode } from '@mnaoumov/obsidian-lib/misplaced-attachment';
import {
  getCurrentPathCompatibilityPlatform,
  getForbiddenCharacterReplacementValidationMessage,
  PATH_COMPATIBILITY_PLATFORMS,
  PathCompatibilityPlatform
} from '@mnaoumov/obsidian-lib/path-compatibility';
import { PluginBase } from '@mnaoumov/obsidian-lib/plugin/plugin';
import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { getDataAdapterEx } from '@obsidian-typings/obsidian-public-latest/implementations';
import {
  editorInfoField,
  Menu
} from 'obsidian';

import type { RangedLinkProblem } from './editor-problems.ts';
import type { LinkProblem } from './link-model.ts';
import type { PathRepairScope } from './problem-fixes.ts';

import { AutoRepairComponent } from './auto-repair-component.ts';
import { CommunityPluginComponent } from './community-plugin-component.ts';
import { EditorProblems } from './editor-problems.ts';
import { HtmlCheckComponent } from './html-check-component.ts';
import { LinkEngineComponent } from './link-engine-component.ts';
import { LinkEngine } from './link-engine.ts';
import { MisplacedAttachmentComponent } from './misplaced-attachment-component.ts';
import { PathCompatibilityComponent } from './path-compatibility-component.ts';
import { ProblemFixes } from './problem-fixes.ts';
import {
  PROBLEMS_VIEW_TYPE,
  ProblemsView
} from './problems-view.ts';
import { RenameHandlerBatchComponent } from './rename-handler-batch-component.ts';
import { showRepairNotice } from './repair-notice.ts';
import { RepairSettingTab } from './repair-setting-tab.ts';
import { SyntaxCheckComponent } from './syntax-check-component.ts';

export class Plugin extends PluginBase {
  /**
  Which references to an attachment outside the referencing note's attachment folder are reported.

  @default {@link ExternalAttachmentLinkMode.Report}
  */
  public externalAttachmentLinkMode = ExternalAttachmentLinkMode.Report;
  /**
  What a path repair replaces each forbidden character with; empty deletes it.

  @default '-'
  */
  public forbiddenCharacterReplacement = '-';
  /**
  The HTML checks, whose status the Problems view shows while HTML is not fully checked.
  */
  public htmlCheckComponent: HtmlCheckComponent | null = null;
  public ignoredPaths: string[] = [];
  /**
  Whether editor operations may repair links automatically.
  */
  public isAutoRepairEnabled = true;
  /**
  The shared diagnostics source used by views and editor extensions.
  */
  public linkEngine: LinkEngine | null = null;
  /**
  The length of the longest vault root path the vault is expected to live under; `0` means the running vault's own root.

  @default `0`
  */
  public maxVaultRootPathLength = 0;
  /**
  The platforms whose naming rules every file and folder name is held to. Only the running platform starts on: every
  other one is the user saying where else the vault is synced.
  */
  public pathCompatibilityPlatforms: PathCompatibilityPlatform[] = getDefaultPlatforms();

  public problemFixes: null | ProblemFixes = null;
  private misplacedAttachmentComponent: MisplacedAttachmentComponent | null = null;
  private pathCompatibilityComponent: null | PathCompatibilityComponent = null;

  /**
  The path rules as they apply now, with `0` resolved to the running vault's root.
  */
  public getPathRepairScope(): PathRepairScope {
    return {
      forbiddenCharacterReplacement: this.forbiddenCharacterReplacement,
      maxVaultRootPathLength: this.maxVaultRootPathLength === 0 ? getDataAdapterEx(this.app).basePath.length : this.maxVaultRootPathLength,
      platforms: this.pathCompatibilityPlatforms
    };
  }

  public getProblems(): readonly import('./link-model.ts').LinkProblem[] {
    return this.linkEngine?.getAllProblems() ?? [];
  }

  /**
  Saves the repair preference without discarding other plugin data.
  */
  public async setAutoRepairEnabled(isEnabled: boolean): Promise<void> {
    this.isAutoRepairEnabled = isEnabled;
    const data: unknown = await this.loadData();
    await this.saveData({ ...(typeof data === 'object' && data !== null && data), isAutoRepairEnabled: isEnabled });
  }

  /**
  Saves the external attachment link mode and judges every note again under it.
  */
  public async setExternalAttachmentLinkMode(mode: ExternalAttachmentLinkMode): Promise<void> {
    this.externalAttachmentLinkMode = mode;
    await this.saveSetting({ externalAttachmentLinkMode: mode });
    this.misplacedAttachmentComponent?.refresh();
  }

  /**
  Saves the forbidden-character replacement after checking that no platform refuses it.
  */
  public async setForbiddenCharacterReplacement(value: string): Promise<void> {
    const message = getForbiddenCharacterReplacementValidationMessage(value);
    if (message) {
      throw new Error(message);
    }
    this.forbiddenCharacterReplacement = value;
    await this.saveSetting({ forbiddenCharacterReplacement: value });
  }

  public async setIgnoredPaths(value: string): Promise<void> {
    this.ignoredPaths = value.split('\n').map((path) => path.trim()).filter(Boolean);
    const data: unknown = await this.loadData();
    await this.saveData({ ...(typeof data === 'object' && data !== null && data), ignoredPaths: this.ignoredPaths });
    this.renderProblemsViews();
  }

  /**
  Saves the vault root length and checks every name again against it.
  */
  public async setMaxVaultRootPathLength(value: number): Promise<void> {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('The vault root length must be a whole number of characters, 0 for this vault\'s own root.');
    }
    this.maxVaultRootPathLength = value;
    await this.saveSetting({ maxVaultRootPathLength: value });
    this.pathCompatibilityComponent?.refresh();
  }

  /**
  Turns one platform's naming rules on or off and checks every name again.
  */
  public async setPathCompatibilityPlatform(platform: PathCompatibilityPlatform, isEnabled: boolean): Promise<void> {
    this.pathCompatibilityPlatforms = PATH_COMPATIBILITY_PLATFORMS.filter((candidate) => candidate === platform ? isEnabled : this.pathCompatibilityPlatforms.includes(candidate));
    await this.saveSetting({ pathCompatibilityPlatforms: this.pathCompatibilityPlatforms });
    this.pathCompatibilityComponent?.refresh();
  }

  public showMessage(message: string): void {
    this.pluginNoticeComponent.showNotice(message);
  }

  public showProblemError(error: unknown): void {
    this.pluginNoticeComponent.showNotice(String(error));
  }

  protected override async onloadImpl(): Promise<void> {
    const data: unknown = await this.loadData();
    this.isAutoRepairEnabled = !(typeof data === 'object' && data !== null && 'isAutoRepairEnabled' in data && data.isAutoRepairEnabled === false);
    this.ignoredPaths = typeof data === 'object' && data !== null && 'ignoredPaths' in data && Array.isArray(data.ignoredPaths) ? data.ignoredPaths.filter((path): path is string => typeof path === 'string') : [];
    this.loadPathAndAttachmentSettings(data);
    this.linkEngine = new LinkEngine({
      app: this.app,
      notify: (problems): void => {
        this.pluginNoticeComponent.showNotice(`${String(problems.length)} link(s) just broke: ${problems.map((problem) => problem.row.link).join(', ')}`);
      }
    });
    this.addChild(new LinkEngineComponent({ app: this.app, engine: this.linkEngine }));
    this.addChild(new RenameHandlerBatchComponent({ app: this.app, engine: this.linkEngine }));
    this.addChild(new SyntaxCheckComponent({ app: this.app, engine: this.linkEngine }));
    this.pathCompatibilityComponent = this.addChild(
      new PathCompatibilityComponent({ app: this.app, engine: this.linkEngine, getScope: (): PathRepairScope => this.getPathRepairScope() })
    );
    this.addChild(new CommunityPluginComponent({ app: this.app, engine: this.linkEngine }));
    this.misplacedAttachmentComponent = this.addChild(
      new MisplacedAttachmentComponent({ app: this.app, engine: this.linkEngine, getMode: (): ExternalAttachmentLinkMode => this.externalAttachmentLinkMode })
    );
    this.htmlCheckComponent = this.addChild(
      new HtmlCheckComponent({
        app: this.app,
        engine: this.linkEngine,
        onStatusChanged: (): void => {
          this.renderProblemsViews();
        }
      })
    );
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
    this.problemFixes = new ProblemFixes({ app: this.app, getPathRepairScope: (): PathRepairScope => this.getPathRepairScope(), getProblems: (): readonly import('./link-model.ts').LinkProblem[] => this.getProblems(), notify: showRepairNotice.bind(undefined, this.pluginNoticeComponent), repairs });
    const engine = this.linkEngine;
    const diagnostics = new EditorProblems({
      getPath: (state): null | string => state.field(castTo<StateField<MarkdownFileInfo>>(editorInfoField), false)?.file?.path ?? null,
      getProblems: (path): readonly LinkProblem[] => engine.getProblems(path),
      showFixes: (problem, view): void => {
        this.showEditorFixes(problem, view);
      },
      subscribe: (refresh): () => void => {
        const ref = engine.onChanged((change) => {
          for (const path of change.sourcePaths) {
            refresh(path);
          }
        });
        return (): void => {
          engine.offref(ref);
        };
      }
    });
    this.registerEditorExtension(castTo(diagnostics.extension));
    this.addCommand({
      editorCheckCallback: (checking, editor) => {
        const problem = diagnostics.getProblemAtCursor(editor.cm);
        if (!problem) {
          return false;
        }
        if (!checking) {
          this.showEditorFixes(problem, editor.cm);
        }
        return true;
      },
      id: 'quick-fixes-at-cursor',
      name: 'Quick fixes at cursor'
    });
    this.registerView(PROBLEMS_VIEW_TYPE, (leaf) => new ProblemsView(leaf, this));
    this.addCommand({
      callback: () => {
        invokeAsyncSafely(() => this.openProblems());
      },
      id: 'open-problems',
      name: 'Open problems'
    });
    this.addRibbonIcon('list-checks', 'Open problems', () => {
      invokeAsyncSafely(() => this.openProblems());
    });
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

  /**
  Reads each value only when it has the right shape, so a hand-edited or older data.json falls back to the default.
  */
  private loadPathAndAttachmentSettings(data: unknown): void {
    if (typeof data !== 'object' || data === null) {
      return;
    }
    if ('externalAttachmentLinkMode' in data) {
      const mode = Object.values(ExternalAttachmentLinkMode).find((value) => value === data.externalAttachmentLinkMode);
      this.externalAttachmentLinkMode = mode ?? this.externalAttachmentLinkMode;
    }
    if ('forbiddenCharacterReplacement' in data && typeof data.forbiddenCharacterReplacement === 'string' && !getForbiddenCharacterReplacementValidationMessage(data.forbiddenCharacterReplacement)) {
      this.forbiddenCharacterReplacement = data.forbiddenCharacterReplacement;
    }
    if ('maxVaultRootPathLength' in data && Number.isSafeInteger(data.maxVaultRootPathLength) && Number(data.maxVaultRootPathLength) >= 0) {
      this.maxVaultRootPathLength = Number(data.maxVaultRootPathLength);
    }
    if (!('pathCompatibilityPlatforms' in data) || !Array.isArray(data.pathCompatibilityPlatforms)) {
      return;
    }
    const saved: unknown[] = data.pathCompatibilityPlatforms;
    this.pathCompatibilityPlatforms = PATH_COMPATIBILITY_PLATFORMS.filter((platform) => saved.includes(platform));
  }

  private async openProblems(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(PROBLEMS_VIEW_TYPE)[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      return;
    }

    await leaf.setViewState({ active: true, type: PROBLEMS_VIEW_TYPE });
    await this.app.workspace.revealLeaf(leaf);
  }

  private renderProblemsViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PROBLEMS_VIEW_TYPE)) {
      if (leaf.view instanceof ProblemsView) {
        leaf.view.render();
      }
    }
  }

  private async saveSetting(values: object): Promise<void> {
    const data: unknown = await this.loadData();
    await this.saveData({ ...(typeof data === 'object' && data !== null && data), ...values });
  }

  private showEditorFixes(problem: RangedLinkProblem, view: EditorView): void {
    const snapshot = view.state.doc;
    const path = getPath();
    function getPath(): null | string {
      return view.state.field(castTo<StateField<MarkdownFileInfo>>(editorInfoField), false)?.file?.path ?? null;
    }
    invokeAsyncSafely(async () => {
      try {
        const fixes = await this.problemFixes?.getFixes(problem) ?? [];
        const position = problem.row.position;
        if (!view.dom.isConnected || view.state.doc !== snapshot || getPath() !== path) {
          return;
        }
        if (fixes.length === 0) {
          this.pluginNoticeComponent.showNotice('No quick fix for this problem: review it by hand.');
          return;
        }
        const coords = view.coordsAtPos(Math.min(position.start.offset, view.state.doc.length));
        if (!coords) {
          return;
        }
        const menu = new Menu();
        for (const action of fixes) {
          menu.addItem((item) =>
            item.setTitle(action.label).onClick(() => {
              invokeAsyncSafely(async () => {
                try {
                  if (view.state.doc !== snapshot || getPath() !== path) {
                    return;
                  }
                  await action.run();
                } catch (error) {
                  this.showProblemError(error);
                }
              });
            })
          );
        }
        menu.showAtPosition({ x: coords.left, y: coords.bottom });
      } catch (error) {
        this.showProblemError(error);
      }
    });
  }
}

function getDefaultPlatforms(): PathCompatibilityPlatform[] {
  // A platform with no profile starts with every check off.
  return [getCurrentPathCompatibilityPlatform()].filter((platform): platform is PathCompatibilityPlatform => platform !== null);
}
