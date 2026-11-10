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

import { Plugin } from './plugin.ts';
import { ProblemsView } from './problems-view.ts';

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
