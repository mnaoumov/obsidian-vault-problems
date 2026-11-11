import type { WorkspaceLeaf } from 'obsidian';

import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { noopAsync } from '@mnaoumov/typescript-lib/function';
import {
  Component,
  ItemView,
  MarkdownView,
  Menu,
  setIcon
} from 'obsidian';

import type { LinkProblem } from './link-model.ts';
import type { Plugin } from './plugin.ts';
import type { ProblemGrouping } from './problem-filter.ts';

import {
  groupProblems,
  PROBLEM_KIND_LABELS
} from './problem-filter.ts';

/**
The workspace persists this view type across reloads.
*/
export const PROBLEMS_VIEW_TYPE = 'vault-problems';

/**
A group with more problems than this starts collapsed, so one noisy note cannot push every other note off screen.
*/
export const PROBLEMS_COLLAPSE_THRESHOLD = 10;

/**
How many groups, and how many rows inside one group, are rendered before a Show more button.

Paging bounds the DOM of one render whatever the vault holds: a result the size of the 27 MB consistency report
renders the same few hundred elements as a small one, and the rest is one click away.
*/
export const PROBLEMS_PAGE_SIZE = 100;

/**
A live, keyboard-accessible projection of the shared diagnostics snapshot.
*/
export class ProblemsView extends ItemView {
  /**
  An Expand all or Collapse all choice, which overrides the size-based default until a group is toggled.
  */
  private allExpanded: boolean | null = null;
  /**
  Each group's explicit toggle, keyed by grouping and group key, kept across live re-renders.
  */
  private readonly expanded = new Map<string, boolean>();
  private folder = '';
  private grouping: ProblemGrouping = 'file';
  private groupLimit = PROBLEMS_PAGE_SIZE;
  private kind = '';
  private listEl: HTMLElement | null = null;
  private readonly rowLimits = new Map<string, number>();
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
    for (const value of ['', 'link', 'embed', 'frontmatter', 'reference', 'syntax', 'html']) {
      kind.createEl('option', { text: value || 'All kinds', value });
    }
    kind.value = this.kind;
    this.registerDomEvent(kind, 'change', () => {
      this.kind = kind.value;
      this.groupLimit = PROBLEMS_PAGE_SIZE;
      this.render();
    });
    const folder = controls.createEl('input', { attr: { 'aria-label': 'Folder', 'placeholder': 'Folder (including subfolders)', 'type': 'text' } });
    folder.value = this.folder;
    this.registerDomEvent(folder, 'input', () => {
      this.folder = folder.value;
      this.groupLimit = PROBLEMS_PAGE_SIZE;
      this.render();
    });
    const grouping = controls.createEl('select', { attr: { 'aria-label': 'Group by' } });
    grouping.createEl('option', { text: 'Group by file', value: 'file' });
    grouping.createEl('option', { text: 'Group by kind', value: 'kind' });
    grouping.value = this.grouping;
    this.registerDomEvent(grouping, 'change', () => {
      this.grouping = grouping.value === 'kind' ? 'kind' : 'file';
      this.groupLimit = PROBLEMS_PAGE_SIZE;
      this.render();
    });
    for (const [text, isExpanded] of [['Expand all', true], ['Collapse all', false]] as const) {
      const button = controls.createEl('button', { cls: 'vault-problems-toggle-all', text });
      this.registerDomEvent(button, 'click', () => {
        this.allExpanded = isExpanded;
        this.expanded.clear();
        this.render();
      });
    }
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
    const groups = groupProblems(this.owner.getProblems(), { folder: this.folder, ignoredPaths: this.owner.ignoredPaths, kind: this.kind }, this.grouping);
    this.rows.unload();
    this.rows.load();
    list.empty();
    const total = [...groups.values()].reduce((count, problems) => count + problems.length, 0);
    const unit = this.grouping === 'kind' ? 'kind(s)' : 'file(s)';
    list.createEl('p', { cls: 'vault-problems-summary', text: `${String(total)} problem(s) in ${String(groups.size)} ${unit}` });
    const htmlStatus = this.owner.htmlCheckComponent?.statusMessage;
    if (htmlStatus && (this.kind === '' || this.kind === 'html')) {
      list.createEl('p', { cls: 'vault-problems-status', text: htmlStatus });
    }
    let shown = 0;
    for (const [key, problems] of groups) {
      if (shown === this.groupLimit) {
        break;
      }
      shown++;
      this.renderGroup(list, key, problems);
    }
    this.renderShowMore(list, groups.size - shown, unit, () => {
      this.groupLimit += PROBLEMS_PAGE_SIZE;
    });
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

  private renderGroup(list: HTMLElement, key: string, problems: readonly LinkProblem[]): void {
    const groupKey = `${this.grouping}:${key}`;
    const isExpanded = this.expanded.get(groupKey) ?? this.allExpanded ?? problems.length <= PROBLEMS_COLLAPSE_THRESHOLD;
    const section = list.createEl('section', { cls: 'vault-problems-group' });
    const title = this.grouping === 'kind' ? PROBLEM_KIND_LABELS[key as LinkProblem['row']['kind']] : key;
    const header = section.createEl('button', {
      attr: { 'aria-expanded': String(isExpanded), 'aria-label': `${title}, ${String(problems.length)} problem(s)` },
      cls: 'vault-problems-group-header'
    });
    setIcon(header.createSpan({ cls: 'vault-problems-group-icon' }), isExpanded ? 'chevron-down' : 'chevron-right');
    header.createSpan({ cls: 'vault-problems-group-title', text: title });
    header.createSpan({ cls: 'vault-problems-group-count', text: String(problems.length) });
    this.rows.registerDomEvent(header, 'click', () => {
      this.expanded.set(groupKey, !isExpanded);
      this.render();
    });
    if (!isExpanded) {
      return;
    }
    const body = section.createDiv({ cls: 'vault-problems-group-body' });
    const limit = this.rowLimits.get(groupKey) ?? PROBLEMS_PAGE_SIZE;
    for (const problem of problems.slice(0, limit)) {
      this.renderProblem(body, problem);
    }
    this.renderShowMore(body, problems.length - limit, 'problem(s)', () => {
      this.rowLimits.set(groupKey, limit + PROBLEMS_PAGE_SIZE);
    });
  }

  private renderProblem(parent: HTMLElement, problem: LinkProblem): void {
    const row = parent.createDiv({ cls: 'vault-problems-row' });
    const line = problem.row.position ? `Line ${String(problem.row.position.start.line + 1)}` : `Property ${problem.row.key ?? ''}`;
    // Grouped by kind, the heading no longer names the note, so each row does.
    const location = this.grouping === 'kind' ? `${problem.row.sourcePath}, ${line}` : line;
    // An HTML finding is a candidate from a lexical index, so it is reviewed rather than asserted.
    row.createSpan({ cls: problem.html ? 'vault-problems-severity is-warning' : 'vault-problems-severity', text: problem.html ? 'Warning' : 'Error' });
    const open = row.createEl('button', { cls: 'vault-problems-open', text: `${location}: ${problem.message}` });
    this.rows.registerDomEvent(open, 'click', () => {
      invokeAsyncSafely(() => this.openProblem(problem));
    });
    const cause = problem.cause;
    row.createEl('small', { text: cause ? `Broke after ${cause.kind}: ${cause.oldPath ? `${cause.oldPath} → ` : ''}${cause.path}` : 'Standing problem' });
    // HTML is only reported: deleting markup on a lexical candidate could lose content.
    if (problem.html) {
      return;
    }
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

  private renderShowMore(parent: HTMLElement, remaining: number, unit: string, showMore: () => void): void {
    if (remaining <= 0) {
      return;
    }
    const button = parent.createEl('button', {
      cls: 'vault-problems-more',
      text: `Show ${String(Math.min(remaining, PROBLEMS_PAGE_SIZE))} more (${String(remaining)} ${unit} not shown)`
    });
    this.rows.registerDomEvent(button, 'click', () => {
      showMore();
      this.render();
    });
  }
}
