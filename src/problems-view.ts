import type { WorkspaceLeaf } from 'obsidian';

import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { noopAsync } from '@mnaoumov/typescript-lib/function';
import {
  Component,
  ItemView,
  MarkdownView,
  Menu
} from 'obsidian';

import type { LinkProblem } from './link-model.ts';
import type { Plugin } from './plugin.ts';

import { groupProblems } from './problem-filter.ts';

/**
The workspace persists this view type across reloads.
*/
export const PROBLEMS_VIEW_TYPE = 'vault-problems';

/**
A live, keyboard-accessible projection of the shared diagnostics snapshot.
*/
export class ProblemsView extends ItemView {
  private folder = '';
  private kind = '';
  private listEl: HTMLElement | null = null;
  private readonly rows = this.addChild(new Component());

  public constructor(leaf: WorkspaceLeaf, private readonly owner: Plugin) {
    super(leaf);
  }

  public override getDisplayText(): string {
    return 'Problems';
  }

  public override getIcon(): string {
    return 'list-checks';
  }

  public override getViewType(): string {
    return PROBLEMS_VIEW_TYPE;
  }

  public override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('vault-problems-view');
    const controls = this.contentEl.createDiv({ cls: 'vault-problems-filters' });
    const kind = controls.createEl('select', { attr: { 'aria-label': 'Problem kind' } });
    for (const value of ['', 'link', 'embed', 'frontmatter', 'reference', 'syntax']) {
      kind.createEl('option', { text: value || 'All kinds', value });
    }
    kind.value = this.kind;
    this.registerDomEvent(kind, 'change', () => {
      this.kind = kind.value;
      this.render();
    });
    const folder = controls.createEl('input', { attr: { 'aria-label': 'Folder', 'placeholder': 'Folder (including subfolders)', 'type': 'text' } });
    folder.value = this.folder;
    this.registerDomEvent(folder, 'input', () => {
      this.folder = folder.value;
      this.render();
    });
    this.listEl = this.contentEl.createDiv({ attr: { 'aria-live': 'polite' } });
    const subscription = this.owner.linkEngine?.onChanged(() => {
      this.render();
    });
    if (subscription) {
      this.register(() => this.owner.linkEngine?.offref(subscription));
    }
    this.render();
    await noopAsync();
  }

  public render(): void {
    const list = this.listEl;
    if (!list) {
      return;
    }
    const groups = groupProblems(this.owner.getProblems(), { folder: this.folder, ignoredPaths: this.owner.ignoredPaths, kind: this.kind });
    this.rows.unload();
    this.rows.load();
    list.empty();
    list.createEl('p', { text: `${String([...groups.values()].reduce((count, problems) => count + problems.length, 0))} problem(s)` });
    for (const [path, problems] of groups) {
      const section = list.createEl('section');
      section.createEl('h3', { text: path });
      for (const problem of problems) {
        this.renderProblem(section, problem);
      }
    }
    if (groups.size === 0) {
      list.createEl('p', { text: 'No problems match these filters.' });
    }
  }

  private async openProblem(problem: LinkProblem): Promise<void> {
    const file = this.app.vault.getFileByPath(problem.row.sourcePath);
    if (!file) {
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true });
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      return;
    }
    const position = problem.row.position;
    // Frontmatter links have keys instead of source ranges in Obsidian's metadata.
    const start = position ? { ch: position.start.col, line: position.start.line } : { ch: 0, line: 0 };
    const end = position ? { ch: position.end.col, line: position.end.line } : start;
    view.editor.setSelection(start, end);
    view.editor.scrollIntoView({ from: start, to: end }, true);
  }

  private renderProblem(parent: HTMLElement, problem: LinkProblem): void {
    const row = parent.createDiv({ cls: 'vault-problems-row' });
    const location = problem.row.position ? `Line ${String(problem.row.position.start.line + 1)}` : `Property ${problem.row.key ?? ''}`;
    row.createSpan({ cls: 'vault-problems-severity', text: 'Error' });
    const open = row.createEl('button', { cls: 'vault-problems-open', text: `${location}: ${problem.message}` });
    this.rows.registerDomEvent(open, 'click', () => {
      invokeAsyncSafely(() => this.openProblem(problem));
    });
    const cause = problem.cause;
    row.createEl('small', { text: cause ? `Broke after ${cause.kind}: ${cause.oldPath ? `${cause.oldPath} → ` : ''}${cause.path}` : 'Standing problem' });
    const fix = row.createEl('button', { attr: { 'aria-label': `Quick fixes for ${problem.row.link}` }, text: 'Quick fixes' });
    this.rows.registerDomEvent(fix, 'click', ($event) => {
      invokeAsyncSafely(async () => {
        fix.disabled = true;
        try {
          const fixes = await this.owner.problemFixes?.getFixes(problem) ?? [];
          const menu = new Menu();
          for (const action of fixes) {
            menu.addItem((item) =>
              item.setTitle(action.label).onClick(() => {
                invokeAsyncSafely(async () => {
                  try {
                    await action.run();
                  } catch (error) {
                    this.owner.showProblemError(error);
                  }
                });
              })
            );
          }
          menu.showAtMouseEvent($event);
        } catch (error) {
          this.owner.showProblemError(error);
        } finally {
          fix.disabled = false;
        }
      });
    });
  }
}
