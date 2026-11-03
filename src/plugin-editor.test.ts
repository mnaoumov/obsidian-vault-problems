import type {
  Extension,
  StateField
} from '@codemirror/state';
import type { Tooltip } from '@codemirror/view';
import type {
  App as AppOriginal,
  Command,
  Editor,
  MarkdownFileInfo,
  PluginManifest
} from 'obsidian';
import type { MockInstance } from 'vitest';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { editorInfoField } from 'obsidian';
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

import type { LinkEngine } from './link-engine.ts';
import type { LinkProblem } from './link-model.ts';
import type { ProblemFixes } from './problem-fixes.ts';

import { Plugin } from './plugin.ts';

interface HoverCapture {
  readonly hover: ((view: EditorView, pos: number) => null | Tooltip)[];
}

const captured = vi.hoisted((): HoverCapture => ({ hover: [] }));
vi.mock('@codemirror/view', async (importOriginal) => {
  const original = await importOriginal<typeof import('@codemirror/view')>();
  return {
    ...original,
    hoverTooltip: (source: (view: EditorView, pos: number) => null | Tooltip): ReturnType<typeof original.hoverTooltip> => {
      captured.hover.push(source);
      return original.hoverTooltip(source);
    }
  };
});

interface Fixture {
  readonly app: AppOriginal;
  readonly command: NonNullable<Command['editorCheckCallback']>;
  readonly editor: Editor;
  readonly engine: LinkEngine;
  readonly extension: Extension;
  readonly fixes: MockInstance<ProblemFixes['getFixes']>;
  readonly menus: Menu[];
  readonly plugin: Plugin;
  readonly problem: LinkProblem;
  readonly view: EditorView;
}

async function fixture(): Promise<Fixture> {
  const app = App.createConfigured__().asOriginalType__();
  const manifest: PluginManifest = { author: 'test', description: 'test', id: 'vault-problems', minAppVersion: '1.14.5', name: 'Vault Problems', version: '0.0.0' };
  const plugin = new Plugin(app, manifest);
  const extensions = vi.spyOn(plugin, 'registerEditorExtension');
  await plugin.onload();
  const file = await app.vault.create('Note.md', '[[Missing]]');
  const problem: LinkProblem = { cause: null, message: 'Missing', row: { id: 'one', key: null, kind: 'link', link: 'Missing', position: { end: { col: 11, line: 0, offset: 11 }, start: { col: 0, line: 0, offset: 0 } }, sourcePath: file.path, target: null, targetPath: null }, status: 'standing' };
  const engine = ensureNonNullable(plugin.linkEngine);
  vi.spyOn(engine, 'getProblems').mockReturnValue([problem]);
  const extension = castTo<Extension>(ensureNonNullable(extensions.mock.calls[1])[0]);
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: '[[Missing]]', extensions: [extension, castTo<StateField<MarkdownFileInfo>>(editorInfoField).init(() => castTo({ file }))] }) });
  const editor = castTo<Editor>({ cm: view });
  const command = ensureNonNullable(PluginHost.fromOriginalType2__(plugin).commands__.get('quick-fixes-at-cursor')?.editorCheckCallback);
  const fixes = vi.spyOn(ensureNonNullable(plugin.problemFixes), 'getFixes');
  const menus: Menu[] = [];
  vi.spyOn(Menu.prototype, 'showAtPosition').mockImplementation(function record(this: Menu): Menu {
    menus.push(this);
    return this;
  });
  vi.spyOn(view, 'coordsAtPos').mockReturnValue({ bottom: 20, left: 10, right: 20, top: 10 });
  return { app, command, editor, engine, extension, fixes, menus, plugin, problem, view };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

describe('Editor fix command', () => {
  it('checks availability, opens shared actions, applies them and reports load and action errors', async () => {
    const { command, editor, engine, fixes, menus, plugin, view } = await fixture();
    const action = vi.fn<() => Promise<void>>().mockResolvedValue();
    fixes.mockResolvedValue([{ label: 'Chosen fix', run: action }]);
    const error = vi.spyOn(plugin, 'showProblemError');
    expect(command(true, editor, castTo({}))).toBe(true);
    expect(fixes).not.toHaveBeenCalled();
    expect(command(false, editor, castTo({}))).toBe(true);
    await settle();
    const menu = ensureNonNullable(menus[0]);
    const click = ensureNonNullable(ensureNonNullable(menu.menuItems__[0]).onClick__);
    view.dispatch({ selection: { anchor: 1 } });
    expect(menu.menuItems__[0]?.title__).toBe('Chosen fix');
    click(new MouseEvent('click'));
    await settle();
    expect(action).toHaveBeenCalledOnce();
    action.mockRejectedValue(new Error('Cannot apply'));
    click(new MouseEvent('click'));
    await settle();
    expect(error).toHaveBeenCalledWith(new Error('Cannot apply'));
    fixes.mockRejectedValue(new Error('Cannot load'));
    command(false, editor, castTo({}));
    await settle();
    expect(error).toHaveBeenCalledWith(new Error('Cannot load'));
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    click(new MouseEvent('click'));
    await settle();
    expect(action).toHaveBeenCalledTimes(2);
    expect(command(false, editor, castTo({}))).toBe(false);
    engine.initialize();
    await settle();
    view.destroy();
    plugin.unload();
  });

  it('does not open a menu after edits, detachment or a missing screen position', async () => {
    const { command, editor, fixes, menus, plugin, view } = await fixture();
    const originalState = view.state;
    fixes.mockImplementation(async () => {
      view.dispatch({ changes: { from: 0, insert: 'x' } });
      await noopAsync();
      return [];
    });
    command(false, editor, castTo({}));
    await settle();
    expect(menus).toHaveLength(0);
    view.setState(originalState);
    fixes.mockResolvedValue([]);
    vi.spyOn(view, 'coordsAtPos').mockReturnValue(null);
    command(false, editor, castTo({}));
    await settle();
    expect(menus).toHaveLength(0);
    view.dom.remove();
    command(false, editor, castTo({}));
    await settle();
    expect(menus).toHaveLength(0);
    view.destroy();
    plugin.unload();
  });

  it('opens fixes from hover, tolerates no provider and skips editors without a file', async () => {
    const { command, editor, extension, menus, plugin, view } = await fixture();
    plugin.problemFixes = null;
    const tooltip = ensureNonNullable(ensureNonNullable(captured.hover.at(-1))(view, 1));
    ensureNonNullable(tooltip.create(view).dom.querySelector('button')).click();
    await settle();
    expect(menus).toHaveLength(1);
    expect(menus[0]?.menuItems__).toHaveLength(0);
    expect(command(true, editor, castTo({}))).toBe(true);
    for (const fields of [[], [castTo<StateField<MarkdownFileInfo>>(editorInfoField).init(() => castTo({}))]]) {
      const bare = new EditorView({ parent: document.body, state: EditorState.create({ extensions: [extension, fields] }) });
      expect(command(true, castTo({ cm: bare }), castTo({}))).toBe(false);
      bare.destroy();
    }
    view.destroy();
    plugin.unload();
  });

  it('refuses fixes if the editor switches notes while loading or after the menu opens', async () => {
    const { app, command, editor, extension, fixes, menus, plugin, view } = await fixture();
    const originalState = view.state;
    const other = await app.vault.create('Other.md', '[[Missing]]');
    const action = vi.fn<() => Promise<void>>().mockResolvedValue();
    const actions = [{ label: 'Chosen fix', run: action }];
    for (const fields of [[], [castTo<StateField<MarkdownFileInfo>>(editorInfoField).init(() => castTo({}))], [castTo<StateField<MarkdownFileInfo>>(editorInfoField).init(() => castTo({ file: other }))]]) {
      function switchNote(): void {
        view.setState(EditorState.create({ doc: view.state.doc, extensions: [extension, fields] }));
      }
      view.setState(originalState);
      fixes.mockImplementation(async () => {
        switchNote();
        await noopAsync();
        return actions;
      });
      command(false, editor, castTo({}));
      const count = menus.length;
      await settle();
      expect(menus).toHaveLength(count);
      view.setState(originalState);
      fixes.mockResolvedValue(actions);
      command(false, editor, castTo({}));
      await settle();
      switchNote();
      const menu = ensureNonNullable(menus.at(-1));
      ensureNonNullable(ensureNonNullable(menu.menuItems__[0]).onClick__)(new MouseEvent('click'));
      await settle();
      expect(action).not.toHaveBeenCalled();
    }
    view.destroy();
    plugin.unload();
  });
});
