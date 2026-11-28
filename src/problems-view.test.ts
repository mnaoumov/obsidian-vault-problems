import type {
  App as AppOriginal,
  PluginManifest,
  TFile,
  WorkspaceLeaf
} from 'obsidian';

import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import {
  App,
  Menu,
  Plugin as PluginHost
} from 'obsidian-test-mocks/obsidian';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { LinkProblem } from './link-model.ts';
import type { UnambiguousFixPlan } from './problem-fixes.ts';

import { Plugin } from './plugin.ts';
import {
  FIX_PREVIEW_LIMIT,
  PROBLEMS_PAGE_SIZE,
  ProblemsView
} from './problems-view.ts';

interface ConfirmCall {
  readonly message: DocumentFragment | string;
  readonly okButtonText?: string;
}

const checkConfirmed = vi.hoisted(() => vi.fn<(params: ConfirmCall) => Promise<boolean>>());

vi.mock('@mnaoumov/obsidian-lib/modals/confirm', () => ({ confirm: checkConfirmed }));

const manifest: PluginManifest = { author: 'test', description: 'test', id: 'vault-problems', minAppVersion: '1.14.5', name: 'Vault Problems', version: '0.0.0' };

interface Fixture {
  readonly app: AppOriginal;
  readonly file: TFile;
  readonly leaf: WorkspaceLeaf;
  readonly plugin: Plugin;
  readonly problem: LinkProblem;
  readonly problems: LinkProblem[];
  readonly view: ProblemsView;
}

async function fixture(): Promise<Fixture> {
  const app = App.createConfigured__().asOriginalType__();
  const plugin = new Plugin(app, manifest);
  await plugin.onload();
  await app.vault.createFolder('Folder');
  const file = await app.vault.create('Folder/Source.md', '[[Missing|Caption]]');
  const problem: LinkProblem = { cause: null, message: 'Cannot resolve Missing', row: { id: '1', key: null, kind: 'link', link: 'Missing', position: { end: { col: 19, line: 0, offset: 19 }, start: { col: 0, line: 0, offset: 0 } }, sourcePath: file.path, target: null, targetPath: null }, status: 'standing' };
  const problems = [problem];
  vi.spyOn(plugin, 'getProblems').mockImplementation(() => problems);
  const leaf = ensureNonNullable(app.workspace.getRightLeaf(false));
  const view = new ProblemsView(leaf, plugin);
  view.render();
  view.load();
  await view.onOpen();
  return { app, file, leaf, plugin, problem, problems, view };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

describe('Problems panel', () => {
  it('renders live source groups, filters, causes and property locations, then unsubscribes on unload', async () => {
    const { plugin, problem, problems, view } = await fixture();
    expect(view.getViewType()).toBe('vault-problems');
    expect(view.getDisplayText()).toBe('Problems');
    expect(view.getIcon()).toBe('list-checks');
    expect(view.contentEl.textContent).toContain('Folder/Source.md');
    expect(view.contentEl.textContent).toContain('Standing problem');
    problems.push({ ...problem, cause: { kind: 'rename', oldPath: 'Old.md', path: 'New.md' }, row: { ...problem.row, key: 'related', kind: 'frontmatter', position: null } }, { ...problem, cause: { kind: 'changed', path: 'Edited.md' }, row: { ...problem.row, key: null, position: null } });
    plugin.linkEngine?.initialize();
    expect(view.contentEl.textContent).toContain('Property related');
    expect(view.contentEl.textContent).toContain('Old.md → New.md');
    expect(view.contentEl.textContent).toContain('changed: Edited.md');
    const kind = ensureNonNullable(view.contentEl.querySelector('select'));
    kind.value = 'embed';
    kind.dispatchEvent(new Event('change'));
    expect(view.contentEl.textContent).toContain('No problems match');
    kind.value = '';
    kind.dispatchEvent(new Event('change'));
    const folder = ensureNonNullable(view.contentEl.querySelector('input'));
    folder.value = 'Elsewhere';
    folder.dispatchEvent(new Event('input'));
    expect(view.contentEl.textContent).toContain('0 problem(s)');
    view.unload();
    const render = vi.spyOn(view, 'render');
    plugin.linkEngine?.update({ kind: 'resolved', path: 'Removed.md' });
    expect(render).not.toHaveBeenCalled();
    plugin.unload();
  });

  it('shows an HTML problem as a warning without fixes, and says when HTML is not checked', async () => {
    const { plugin, problem, problems, view } = await fixture();
    const html: LinkProblem['html'] = { kind: 'sanitized', range: { html: '<script>', isClosing: false, kind: 'tag', namespace: 'html', position: { end: { col: 8, line: 0, offset: 8 }, start: { col: 0, line: 0, offset: 0 } }, tagName: 'script' } };
    problems.splice(0, problems.length, { ...problem, html, message: 'Sanitized <script>', row: { ...problem.row, kind: 'html', link: '<script>' } });
    view.render();
    expect(view.contentEl.querySelector('.vault-problems-severity.is-warning')?.textContent).toBe('Warning');
    expect(view.contentEl.querySelector('[aria-label^="Quick fixes"]')).toBeNull();
    function status(): null | string {
      return view.contentEl.querySelector('.vault-problems-status')?.textContent ?? null;
    }
    expect(status()).toContain('needs the Advanced Metadata Cache plugin');
    const kind = ensureNonNullable(view.contentEl.querySelector('select'));
    for (const [value, isShown] of [['html', true], ['link', false]] as const) {
      kind.value = value;
      kind.dispatchEvent(new Event('change'));
      expect(status() !== null).toBe(isShown);
    }
    plugin.htmlCheckComponent = null;
    kind.value = '';
    kind.dispatchEvent(new Event('change'));
    expect(status()).toBeNull();
    plugin.unload();
  });

  it('names the location of a path problem as the name itself', async () => {
    const { plugin, problem, problems, view } = await fixture();
    problems.splice(0, problems.length, { ...problem, message: 'Windows reserves this name for a device', row: { ...problem.row, kind: 'path', position: null } });
    view.render();
    expect(view.contentEl.textContent).toContain('Name: Windows reserves this name for a device');
    plugin.unload();
  });

  it('names the location of a community-plugin problem as the plugin id', async () => {
    const { plugin, problem, problems, view } = await fixture();
    problems.splice(0, problems.length, { ...problem, message: 'gone is enabled but not installed', missingCommunityPluginId: 'gone', row: { ...problem.row, key: 'gone', kind: 'community-plugin', link: 'gone', position: null } });
    view.render();
    expect(view.contentEl.textContent).toContain('Plugin gone: gone is enabled but not installed');
    expect(view.contentEl.querySelector('.vault-problems-severity.is-warning')?.textContent).toBe('Warning');
    plugin.unload();
  });

  it('navigates to a source range and safely ignores a removed source', async () => {
    const { app, file, plugin, view } = await fixture();
    const leaf = app.workspace.getLeaf(false);
    const open = vi.spyOn(leaf, 'openFile');
    ensureNonNullable(view.contentEl.querySelector<HTMLButtonElement>('.vault-problems-open')).click();
    await settle();
    expect(open).toHaveBeenCalledWith(file, { active: true });
    const current = leaf.view;
    const originalOpen = leaf.openFile.bind(leaf);
    open.mockImplementation(() => {
      leaf.view = view;
      return noopAsync();
    });
    ensureNonNullable(view.contentEl.querySelector<HTMLButtonElement>('.vault-problems-open')).click();
    await settle();
    // eslint-disable-next-line require-atomic-updates -- Restore the injected view after the simulated click has settled.
    leaf.view = current;
    open.mockImplementation(originalOpen);
    await app.fileManager.trashFile(file);
    open.mockClear();
    ensureNonNullable(view.contentEl.querySelector<HTMLButtonElement>('.vault-problems-open')).click();
    await settle();
    expect(open).not.toHaveBeenCalled();
    view.unload();
    plugin.unload();
  });

  it('opens a frontmatter location and remains usable without an engine or fix provider', async () => {
    const { plugin, problem, problems, view } = await fixture();
    problems[0] = { ...problem, row: { ...problem.row, key: 'related', kind: 'frontmatter', position: null } };
    plugin.linkEngine = null;
    plugin.problemFixes = null;
    await view.onOpen();
    ensureNonNullable(view.contentEl.querySelector<HTMLButtonElement>('.vault-problems-open')).click();
    ensureNonNullable(view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Quick fixes for Missing"]')).click();
    await settle();
    expect(view.contentEl.textContent).toContain('Property related');
    view.unload();
    plugin.unload();
  });

  it('offers fixes in a native menu, runs the chosen fix and reports errors', async () => {
    const { plugin, view } = await fixture();
    const action = vi.fn<() => Promise<void>>().mockResolvedValue();
    const fixes = vi.spyOn(ensureNonNullable(plugin.problemFixes), 'getFixes').mockResolvedValue([{ label: 'Chosen fix', run: action }]);
    const error = vi.spyOn(plugin, 'showProblemError');
    const menus: Menu[] = [];
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function recordMenu(this: Menu): Menu {
      menus.push(this);
      return this;
    });
    function click(): void {
      ensureNonNullable(view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Quick fixes for Missing"]')).click();
    }
    click();
    await settle();
    const menu = ensureNonNullable(menus[0]);
    expect(menu.menuItems__[0]?.title__).toBe('Chosen fix');
    ensureNonNullable(ensureNonNullable(menu.menuItems__[0]).onClick__)(new MouseEvent('click'));
    await settle();
    expect(action).toHaveBeenCalledOnce();
    action.mockRejectedValue(new Error('Cannot apply'));
    ensureNonNullable(ensureNonNullable(menu.menuItems__[0]).onClick__)(new MouseEvent('click'));
    await settle();
    expect(error).toHaveBeenCalledWith(new Error('Cannot apply'));
    fixes.mockRejectedValue(new Error('Cannot load'));
    click();
    await settle();
    expect(error).toHaveBeenCalledWith(new Error('Cannot load'));
    expect(view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Quick fixes for Missing"]')?.disabled).toBe(false);
    view.unload();
    plugin.unload();
  });

  it('collapses a large file group, toggles groups, and pages groups and rows', async () => {
    const { plugin, problem, problems, view } = await fixture();
    function header(): HTMLButtonElement {
      return ensureNonNullable(view.contentEl.querySelector<HTMLButtonElement>('.vault-problems-group-header'));
    }
    function rowCount(): number {
      return view.contentEl.querySelectorAll('.vault-problems-row').length;
    }
    function button(text: string): HTMLButtonElement {
      return ensureNonNullable([...view.contentEl.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent.startsWith(text)));
    }
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(header().textContent).toBe('Folder/Source.md1');
    expect(rowCount()).toBe(1);
    header().click();
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(rowCount()).toBe(0);
    header().click();
    expect(rowCount()).toBe(1);

    // Another note: the toggles above are remembered for Folder/Source.md.
    const many = Array.from({ length: PROBLEMS_PAGE_SIZE + 5 }, (_, index) => ({ ...problem, row: { ...problem.row, id: String(index), sourcePath: 'Folder/Large.md' } }));
    problems.splice(0, problems.length, ...many);
    view.render();
    expect(view.contentEl.textContent).toContain(`${String(many.length)} problem(s) in 1 file(s)`);
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(rowCount()).toBe(0);
    button('Expand all').click();
    expect(rowCount()).toBe(PROBLEMS_PAGE_SIZE);
    button('Show 5 more').click();
    expect(rowCount()).toBe(many.length);
    button('Collapse all').click();
    expect(rowCount()).toBe(0);

    const files = Array.from({ length: PROBLEMS_PAGE_SIZE + 1 }, (_, index) => ({ ...problem, row: { ...problem.row, id: String(index), sourcePath: `Note ${String(index).padStart(3, '0')}.md` } }));
    problems.splice(0, problems.length, ...files);
    view.render();
    expect(view.contentEl.querySelectorAll('.vault-problems-group')).toHaveLength(PROBLEMS_PAGE_SIZE);
    button('Show 1 more').click();
    expect(view.contentEl.querySelectorAll('.vault-problems-group')).toHaveLength(files.length);
    view.unload();
    plugin.unload();
  });

  it('groups by kind, naming the note on each row', async () => {
    const { plugin, problem, problems, view } = await fixture();
    problems.push({ ...problem, message: 'Unclosed code span', row: { ...problem.row, id: '2', kind: 'syntax' } });
    const grouping = ensureNonNullable(view.contentEl.querySelector<HTMLSelectElement>('select[aria-label="Group by"]'));
    grouping.value = 'kind';
    grouping.dispatchEvent(new Event('change'));
    const titles = [...view.contentEl.querySelectorAll('.vault-problems-group-title')].map((title) => title.textContent);
    expect(titles).toEqual(['Links', 'Syntax']);
    expect(view.contentEl.textContent).toContain('2 problem(s) in 2 kind(s)');
    expect(view.contentEl.textContent).toContain('Folder/Source.md, Line 1: Unclosed code span');
    grouping.value = 'file';
    grouping.dispatchEvent(new Event('change'));
    expect([...view.contentEl.querySelectorAll('.vault-problems-group-title')].map((title) => title.textContent)).toEqual(['Folder/Source.md']);
    view.unload();
    plugin.unload();
  });

  it('labels near misses and planned notes, hides planned notes on request, and re-classifies after a vault change', async () => {
    const { app, file, plugin, problem, problems, view } = await fixture();
    problems.push({ ...problem, message: 'Cannot resolve Sources', row: { ...problem.row, id: '2', link: 'Sources', position: { end: { col: 11, line: 1, offset: 31 }, start: { col: 0, line: 1, offset: 20 } } } });
    // An edit that leaves aliases and titles alone keeps the classes.
    app.metadataCache.trigger('changed', file, '', {});
    view.render();
    function labels(): (null | string)[] {
      return [...view.contentEl.querySelectorAll('.vault-problems-missing-target')].map((label) => label.textContent);
    }
    expect(labels()).toEqual(['Planned note', 'Near miss']);
    const hidePlanned = ensureNonNullable(view.contentEl.querySelector<HTMLInputElement>(':scope .vault-problems-hide-planned > input'));
    hidePlanned.checked = true;
    hidePlanned.dispatchEvent(new Event('change'));
    expect(labels()).toEqual(['Near miss']);
    expect(view.contentEl.textContent).toContain('1 problem(s) in 1 file(s), 1 planned note link(s) hidden');
    await app.vault.create('Missing.md', '');
    expect(labels()).toEqual(['Near miss', 'Near miss']);
    hidePlanned.checked = false;
    hidePlanned.dispatchEvent(new Event('change'));
    expect(view.contentEl.textContent).not.toContain('hidden');
    view.unload();
    plugin.unload();
  });

  it('persists ignore globs without discarding other plugin data and refreshes existing views', async () => {
    const { app, leaf, plugin, view } = await fixture();
    leaf.view = view;
    vi.spyOn(plugin, 'loadData').mockResolvedValue({ other: 'kept' });
    const save = vi.spyOn(plugin, 'saveData').mockResolvedValue();
    vi.spyOn(app.workspace, 'getLeavesOfType').mockReturnValue([leaf, app.workspace.getLeaf(false)]);
    await plugin.setIgnoredPaths(' Folder/** \n\narchive ');
    expect(save).toHaveBeenCalledWith({ ignoredPaths: ['Folder/**', 'archive'], other: 'kept' });
    expect(view.contentEl.textContent).toContain('No problems match');
    const command = PluginHost.fromOriginalType2__(plugin).commands__.get('open-problems');
    command?.callback?.();
    await settle();
    view.unload();
    plugin.unload();
  });
});

describe('Fix all unambiguous', () => {
  function clickFixAll(view: ProblemsView): void {
    ensureNonNullable(view.contentEl.querySelector<HTMLButtonElement>('.vault-problems-fix-all')).click();
  }

  it('plans over every shown problem, previews the plan and applies it once confirmed', async () => {
    const { plugin, problem, problems, view } = await fixture();
    const hidden: LinkProblem = { ...problem, row: { ...problem.row, id: '2', sourcePath: 'Elsewhere/Other.md' } };
    problems.push(hidden);
    const fixes = ensureNonNullable(plugin.problemFixes);
    const plan: UnambiguousFixPlan = { edits: [{ after: '[[Found|Caption]]', before: '[[Missing|Caption]]', path: problem.row.sourcePath }], fixes: [{ label: 'Use Found.md', problem }] };
    const planFixes = vi.spyOn(fixes, 'planUnambiguousFixes').mockResolvedValue(plan);
    const apply = vi.spyOn(fixes, 'applyPlan').mockResolvedValue();
    const folder = ensureNonNullable(view.contentEl.querySelector('input'));
    folder.value = 'Folder';
    folder.dispatchEvent(new Event('input'));
    checkConfirmed.mockResolvedValueOnce(false);
    clickFixAll(view);
    await settle();
    expect(planFixes).toHaveBeenCalledWith([problem]);
    const params = ensureNonNullable(checkConfirmed.mock.calls[0])[0];
    expect(params.okButtonText).toBe('Apply 1 fix(es)');
    const preview = document.createElement('div');
    preview.append(params.message);
    expect(preview.textContent).toContain('1 fix(es) in 1 note(s). 0 shown problem(s) need a choice');
    expect(preview.textContent).toContain('Folder/Source.md, Line 1: Use Found.md');
    expect(apply).not.toHaveBeenCalled();
    checkConfirmed.mockResolvedValueOnce(true);
    clickFixAll(view);
    await settle();
    expect(apply).toHaveBeenCalledWith(plan);
    plugin.unload();
  });

  it('says when nothing has exactly one fix, lists only the first fixes of a long plan, and reports errors', async () => {
    const { plugin, problem, view } = await fixture();
    const fixes = ensureNonNullable(plugin.problemFixes);
    const message = vi.spyOn(plugin, 'showMessage');
    const error = vi.spyOn(plugin, 'showProblemError');
    const planFixes = vi.spyOn(fixes, 'planUnambiguousFixes').mockResolvedValue({ edits: [], fixes: [] });
    checkConfirmed.mockClear();
    clickFixAll(view);
    await settle();
    expect(message).toHaveBeenCalledWith('No shown problem has exactly one quick fix: choose each fix by hand.');
    expect(checkConfirmed).not.toHaveBeenCalled();
    planFixes.mockResolvedValue({ edits: [], fixes: Array.from({ length: FIX_PREVIEW_LIMIT + 2 }, (_value, index) => ({ label: `Fix ${String(index)}`, problem })) });
    checkConfirmed.mockResolvedValueOnce(false);
    clickFixAll(view);
    await settle();
    const preview = document.createElement('div');
    preview.append(ensureNonNullable(checkConfirmed.mock.calls[0])[0].message);
    expect(preview.querySelectorAll('li')).toHaveLength(FIX_PREVIEW_LIMIT);
    expect(preview.textContent).toContain('And 2 more.');
    planFixes.mockRejectedValue(new Error('Cannot plan'));
    clickFixAll(view);
    await settle();
    expect(error).toHaveBeenCalledWith(new Error('Cannot plan'));
    expect(ensureNonNullable(view.contentEl.querySelector<HTMLButtonElement>('.vault-problems-fix-all')).disabled).toBe(false);
    plugin.problemFixes = null;
    clickFixAll(view);
    await settle();
    expect(planFixes).toHaveBeenCalledTimes(3);
    plugin.unload();
  });
});
