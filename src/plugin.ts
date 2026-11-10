import type { StateField } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MarkdownFileInfo } from 'obsidian';

import { OpenBugReportCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-bug-report-command-handler';
import { OpenDemoVaultCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-demo-vault-command-handler';
import { PluginBase } from '@mnaoumov/obsidian-lib/plugin/plugin';
import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import {
  editorInfoField,
  Menu
} from 'obsidian';

import type { RangedLinkProblem } from './editor-problems.ts';
import type { LinkProblem } from './link-model.ts';

import { AutoRepairComponent } from './auto-repair-component.ts';
import { EditorProblems } from './editor-problems.ts';
import { LinkEngineComponent } from './link-engine-component.ts';
import { LinkEngine } from './link-engine.ts';
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
  public ignoredPaths: string[] = [];
  /**
  Whether editor operations may repair links automatically.
  */
  public isAutoRepairEnabled = true;
  /**
  The shared diagnostics source used by views and editor extensions.
  */
  public linkEngine: LinkEngine | null = null;

  public problemFixes: null | ProblemFixes = null;

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

  public async setIgnoredPaths(value: string): Promise<void> {
    this.ignoredPaths = value.split('\n').map((path) => path.trim()).filter(Boolean);
    const data: unknown = await this.loadData();
    await this.saveData({ ...(typeof data === 'object' && data !== null && data), ignoredPaths: this.ignoredPaths });
    for (const leaf of this.app.workspace.getLeavesOfType(PROBLEMS_VIEW_TYPE)) {
      if (leaf.view instanceof ProblemsView) {
        leaf.view.render();
      }
    }
  }

  public showProblemError(error: unknown): void {
    this.pluginNoticeComponent.showNotice(String(error));
  }

  protected override async onloadImpl(): Promise<void> {
    const data: unknown = await this.loadData();
    this.isAutoRepairEnabled = !(typeof data === 'object' && data !== null && 'isAutoRepairEnabled' in data && data.isAutoRepairEnabled === false);
    this.ignoredPaths = typeof data === 'object' && data !== null && 'ignoredPaths' in data && Array.isArray(data.ignoredPaths) ? data.ignoredPaths.filter((path): path is string => typeof path === 'string') : [];
    this.linkEngine = new LinkEngine({
      app: this.app,
      notify: (problems): void => {
        this.pluginNoticeComponent.showNotice(`${String(problems.length)} link(s) just broke: ${problems.map((problem) => problem.row.link).join(', ')}`);
      }
    });
    this.addChild(new LinkEngineComponent({ app: this.app, engine: this.linkEngine }));
    this.addChild(new RenameHandlerBatchComponent({ app: this.app, engine: this.linkEngine }));
    this.addChild(new SyntaxCheckComponent({ app: this.app, engine: this.linkEngine }));
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
    this.problemFixes = new ProblemFixes({ app: this.app, getProblems: (): readonly import('./link-model.ts').LinkProblem[] => this.getProblems(), notify: showRepairNotice.bind(undefined, this.pluginNoticeComponent), repairs });
    const engine = this.linkEngine;
    const diagnostics = new EditorProblems({
      getPath: (state): string | undefined => state.field(castTo<StateField<MarkdownFileInfo>>(editorInfoField), false)?.file?.path,
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

  private async openProblems(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(PROBLEMS_VIEW_TYPE)[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      return;
    }

    await leaf.setViewState({ active: true, type: PROBLEMS_VIEW_TYPE });
    await this.app.workspace.revealLeaf(leaf);
  }

  private showEditorFixes(problem: RangedLinkProblem, view: EditorView): void {
    const snapshot = view.state.doc;
    const path = getPath();
    function getPath(): string | undefined {
      return view.state.field(castTo<StateField<MarkdownFileInfo>>(editorInfoField), false)?.file?.path;
    }
    invokeAsyncSafely(async () => {
      try {
        const fixes = await this.problemFixes?.getFixes(problem) ?? [];
        const position = problem.row.position;
        if (!view.dom.isConnected || view.state.doc !== snapshot || getPath() !== path) {
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
