import type { WorkspaceLeaf } from 'obsidian';

import { confirm } from '@mnaoumov/obsidian-lib/modals/confirm';
import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { noopAsync } from '@mnaoumov/typescript-lib/function';
import {
  Component,
  ItemView,
  MarkdownView,
  Menu,
  setIcon
} from 'obsidian';

import type {
  LinkProblem,
  LinkRow
} from './link-model.ts';
import type { MissingTargetClass } from './missing-targets.ts';
import type { Plugin } from './plugin.ts';
import type { ProblemGrouping } from './problem-filter.ts';
import type { UnambiguousFixPlan } from './problem-fixes.ts';

import {
  MISSING_TARGET_CLASS_LABELS,
  MissingTargetClassifier
} from './missing-targets.ts';
import {
  groupProblems,
  isWarningProblem,
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
How many fixes the Fix all preview lists by name before counting the rest.
*/
export const FIX_PREVIEW_LIMIT = 50;

/**
The problems the current filters show, grouped, and the planned-note links they hid.
*/
interface ShownGroups {
  readonly groups: Map<string, LinkProblem[]>;
  readonly plannedProblems: ReadonlySet<LinkProblem>;
}

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
  /**
  Hides links to a missing file with no candidate, so a vault of intentional unresolved links does not bury the breaks.
  */
  private hidePlanned = false;
  private kind = '';
  private listEl: HTMLElement | null = null;
  private missingTargetClasses = new Map<LinkProblem, MissingTargetClass>();
  private readonly missingTargetClassifier = new MissingTargetClassifier(this.app);
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
    for (const value of ['', 'link', 'embed', 'frontmatter', 'reference', 'syntax', 'html', 'misplaced-attachment', 'path', 'community-plugin']) {
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
    const hidePlannedLabel = controls.createEl('label', { cls: 'vault-problems-hide-planned' });
    const hidePlanned = hidePlannedLabel.createEl('input', { type: 'checkbox' });
    hidePlanned.checked = this.hidePlanned;
    hidePlannedLabel.appendText('Hide planned notes');
    hidePlannedLabel.setAttribute('aria-label', 'Hide links to notes that do not exist yet and have no similar note');
    this.registerDomEvent(hidePlanned, 'change', () => {
      this.hidePlanned = hidePlanned.checked;
      this.groupLimit = PROBLEMS_PAGE_SIZE;
      this.render();
    });
    const classifier = this.missingTargetClassifier;
    const invalidate = (): void => {
      classifier.invalidate();
      this.render();
    };
    this.registerEvent(this.app.vault.on('create', invalidate));
    this.registerEvent(this.app.vault.on('delete', invalidate));
    this.registerEvent(this.app.vault.on('rename', invalidate));
    this.registerEvent(this.app.metadataCache.on('changed', (file, _data, cache) => {
      classifier.onMetadataChanged(file.path, cache.frontmatter);
    }));
    for (const [text, isExpanded] of [['Expand all', true], ['Collapse all', false]] as const) {
      const button = controls.createEl('button', { cls: 'vault-problems-toggle-all', text });
      this.registerDomEvent(button, 'click', () => {
        this.allExpanded = isExpanded;
        this.expanded.clear();
        this.render();
      });
    }
    const fixAll = controls.createEl('button', {
      attr: { 'aria-label': 'Apply the one quick fix of every shown problem that has exactly one, after a preview' },
      cls: 'vault-problems-fix-all',
      text: 'Fix all unambiguous'
    });
    this.registerDomEvent(fixAll, 'click', () => {
      invokeAsyncSafely(() => this.fixAllUnambiguous(fixAll));
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
    const { groups, plannedProblems } = this.getShownGroups();
    this.rows.unload();
    this.rows.load();
    list.empty();
    const total = [...groups.values()].reduce((count, problems) => count + problems.length, 0);
    const unit = this.grouping === 'kind' ? 'kind(s)' : 'file(s)';
    const hiddenCount = plannedProblems.size;
    list.createEl('p', {
      cls: 'vault-problems-summary',
      text: `${String(total)} problem(s) in ${String(groups.size)} ${unit}${hiddenCount > 0 ? `, ${String(hiddenCount)} planned note link(s) hidden` : ''}`
    });
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

  /**
  Plans the one fix of every problem the filters show (every page, collapsed groups included), previews the plan and
  applies it as one Undo step once confirmed.
  */
  private async fixAllUnambiguous(button: HTMLButtonElement): Promise<void> {
    const problemFixes = this.owner.problemFixes;
    if (!problemFixes) {
      return;
    }
    button.disabled = true;
    try {
      const problems = [...this.getShownGroups().groups.values()].flat();
      const plan = await problemFixes.planUnambiguousFixes(problems);
      if (plan.fixes.length === 0) {
        this.owner.showMessage('No shown problem has exactly one quick fix: choose each fix by hand.');
        return;
      }
      const isConfirmed = await confirm({
        app: this.app,
        cssClasses: ['vault-problems-fix-all-preview'],
        message: renderFixPreview(plan, problems.length),
        okButtonText: `Apply ${String(plan.fixes.length)} fix(es)`,
        title: 'Fix all unambiguous problems'
      });
      if (isConfirmed) {
        await problemFixes.applyPlan(plan);
      }
    } catch (error) {
      this.owner.showProblemError(error);
    } finally {
      button.disabled = false;
    }
  }

  private getShownGroups(): ShownGroups {
    const allProblems = this.owner.getProblems();
    this.missingTargetClasses = this.missingTargetClassifier.classify(allProblems);
    const plannedProblems = this.hidePlanned
      ? new Set([...this.missingTargetClasses].filter(([, missingTargetClass]) => missingTargetClass === 'planned').map(([problem]) => problem))
      : new Set<LinkProblem>();
    const groups = groupProblems(allProblems, { folder: this.folder, ignoredPaths: this.owner.ignoredPaths, kind: this.kind, plannedProblems }, this.grouping);
    return { groups, plannedProblems };
  }

  private async openProblem(problem: LinkProblem): Promise<void> {
    const file = this.app.vault.getFileByPath(problem.row.sourcePath);
    if (!file) {
      // A folder's name problem, or a config file outside the vault's file index, has nothing to open; its quick fixes are on the row.
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
    const line = describeLocation(problem.row);
    // Grouped by kind, the heading no longer names the note, so each row does.
    const location = this.grouping === 'kind' ? `${problem.row.sourcePath}, ${line}` : line;
    // An HTML finding is a candidate from a lexical index, so it is reviewed rather than asserted.
    row.createSpan({ cls: isWarningProblem(problem) ? 'vault-problems-severity is-warning' : 'vault-problems-severity', text: isWarningProblem(problem) ? 'Warning' : 'Error' });
    const missingTargetClass = this.missingTargetClasses.get(problem);
    if (missingTargetClass) {
      row.createSpan({ cls: `vault-problems-missing-target is-${missingTargetClass}`, text: MISSING_TARGET_CLASS_LABELS[missingTargetClass] });
    }
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

/**
Where in its file a problem sits: a line, a frontmatter property, the file or folder name itself, or a plugin id in
the enabled list.
*/
function describeLocation(row: LinkRow): string {
  if (row.position) {
    return `Line ${String(row.position.start.line + 1)}`;
  }
  switch (row.kind) {
    case 'community-plugin': {
      // The row's link is the enabled id itself.
      return `Plugin ${row.link}`;
    }
    case 'path': {
      return 'Name';
    }
    default: {
      return `Property ${row.key ?? ''}`;
    }
  }
}

/**
The preview of a batch fix: what it changes, line by line, and how many shown problems it leaves for an explicit choice.
*/
function renderFixPreview(plan: UnambiguousFixPlan, shownCount: number): DocumentFragment {
  const fragment = createFragment();
  const left = shownCount - plan.fixes.length;
  fragment.createEl('p', {
    text: `${String(plan.fixes.length)} fix(es) in ${String(plan.edits.length)} note(s). ${String(left)} shown problem(s) need a choice and are left as they are. One Undo reverts every note.`
  });
  const list = fragment.createEl('ol', { cls: 'vault-problems-fix-all-list' });
  for (const fix of plan.fixes.slice(0, FIX_PREVIEW_LIMIT)) {
    list.createEl('li', { text: `${fix.problem.row.sourcePath}, ${describeLocation(fix.problem.row)}: ${fix.label}` });
  }
  if (plan.fixes.length > FIX_PREVIEW_LIMIT) {
    fragment.createEl('p', { text: `And ${String(plan.fixes.length - FIX_PREVIEW_LIMIT)} more.` });
  }
  return fragment;
}
