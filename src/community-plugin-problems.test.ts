import type { CustomArrayDict } from '@obsidian-typings/obsidian-public-latest';
import type {
  App as AppOriginal,
  PluginManifest,
  Reference
} from 'obsidian';

import { ResourceLockComponent } from '@mnaoumov/obsidian-lib/resource-lock';
import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { LinkProblem } from './link-model.ts';
import type { PathRepairScope } from './problem-fixes.ts';

import { AutoRepairComponent } from './auto-repair-component.ts';
import {
  CommunityPluginComponent,
  getCommunityPluginsConfigPath
} from './community-plugin-component.ts';
import { LinkEngine } from './link-engine.ts';
import {
  groupProblems,
  isWarningProblem,
  PROBLEM_KIND_LABELS
} from './problem-filter.ts';
import { ProblemFixes } from './problem-fixes.ts';

interface Fixture {
  readonly app: AppOriginal;
  readonly engine: LinkEngine;
  readonly fixes: ProblemFixes;
  readonly install: (id: string) => void;
  readonly notify: ReturnType<typeof vi.fn<(message: string, undo: () => Promise<void>) => void>>;
  readonly ready: () => void;
  readonly saved: string[][];
}

function fixture(enabledIds: readonly string[], installedIds: readonly string[]): Fixture {
  const app = App.createConfigured__().asOriginalType__();
  app.metadataCache.getBacklinksForFile = (): CustomArrayDict<Reference> => castTo({ keys: () => [] });
  let ready: (() => void) | undefined;
  vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation((callback) => {
    ready = callback;
  });
  const { plugins } = app;
  function install(id: string): void {
    plugins.manifests[id] = castTo<PluginManifest>({ id });
  }
  for (const id of installedIds) {
    install(id);
  }
  for (const id of enabledIds) {
    plugins.enabledPlugins.add(id);
  }
  const saved: string[][] = [];
  // The mock models the registry's state only; these two act as Obsidian's do on that state.
  Object.assign(plugins, {
    disablePluginAndSave: vi.fn(async (id: string): Promise<void> => {
      plugins.enabledPlugins.delete(id);
      plugins.trigger('changed');
      await noopAsync();
    }),
    saveConfig: vi.fn(async (): Promise<void> => {
      saved.push([...plugins.enabledPlugins]);
      await noopAsync();
    })
  });
  const engine = new LinkEngine({ app, notify: vi.fn() });
  engine.initialize();
  const notify = vi.fn<(message: string, undo: () => Promise<void>) => void>();
  const repairs = new AutoRepairComponent({ app, engine, isEnabled: (): boolean => false, notify, resourceLockComponent: new ResourceLockComponent(app, 'vault-problems') });
  const fixes = new ProblemFixes({
    app,
    getPathRepairScope: (): PathRepairScope => ({ forbiddenCharacterReplacement: '-', maxVaultRootPathLength: 0, platforms: [] }),
    getProblems: (): readonly LinkProblem[] => engine.getAllProblems(),
    notify,
    repairs
  });
  return {
    app,
    engine,
    fixes,
    install,
    notify,
    ready: (): void => {
      ensureNonNullable(ready)();
    },
    saved
  };
}

function missingIds(engine: LinkEngine): (string | undefined)[] {
  return engine.getAllProblems().filter((problem) => problem.row.kind === 'community-plugin').map((problem) => problem.missingCommunityPluginId);
}

describe('Community plugin problem labels', () => {
  it('names the kind, treats it as a warning, and groups it under the config file', () => {
    const { app, engine } = fixture([], []);
    engine.setMissingCommunityPlugins(getCommunityPluginsConfigPath(app), ['gone']);
    const [problem] = engine.getAllProblems();
    expect(PROBLEM_KIND_LABELS['community-plugin']).toBe('Community plugins');
    expect(isWarningProblem(ensureNonNullable(problem))).toBe(true);
    expect(problem?.row.sourcePath).toBe(`${app.vault.configDir}/community-plugins.json`);
    expect(problem?.message).toContain('gone is enabled but not installed');
    expect([...groupProblems(engine.getAllProblems(), { folder: '', ignoredPaths: [], kind: 'community-plugin' }).keys()]).toEqual([`${app.vault.configDir}/community-plugins.json`]);
  });
});

describe('LinkEngine community-plugin problems', () => {
  it('publishes only a real difference, and moves the list when the config folder changes', () => {
    const { engine } = fixture([], []);
    const changed = vi.fn();
    engine.onChanged(changed);
    engine.setMissingCommunityPlugins('.obsidian/community-plugins.json', ['a', 'b']);
    engine.setMissingCommunityPlugins('.obsidian/community-plugins.json', ['a', 'b']);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(engine.getProblems('.obsidian/community-plugins.json').map((problem) => problem.row.id)).toEqual(['community-plugin:a', 'community-plugin:b']);
    engine.setMissingCommunityPlugins('.config/community-plugins.json', ['a']);
    expect(engine.getProblems('.obsidian/community-plugins.json')).toEqual([]);
    expect(engine.getProblems('.config/community-plugins.json').map((problem) => problem.row.key)).toEqual(['a']);
    engine.setMissingCommunityPlugins('.config/community-plugins.json', []);
    expect(engine.getAllProblems()).toEqual([]);
  });
});

describe('CommunityPluginComponent', () => {
  it('reports enabled ids with no installed plugin at layout ready, then follows the registry\'s changed event', () => {
    const { app, engine, install, ready } = fixture(['smart-rename', 'obsidian-smart-rename', 'zeta-gone'], ['smart-rename']);
    const component = new CommunityPluginComponent({ app, engine });
    component.load();
    expect(missingIds(engine)).toEqual([]);
    ready();
    expect(missingIds(engine)).toEqual(['obsidian-smart-rename', 'zeta-gone']);
    install('zeta-gone');
    app.plugins.trigger('changed');
    expect(missingIds(engine)).toEqual(['obsidian-smart-rename']);
    component.unload();
    app.plugins.enabledPlugins.add('later');
    app.plugins.trigger('changed');
    expect(missingIds(engine)).toEqual(['obsidian-smart-rename']);
  });
});

describe('ProblemFixes community-plugin fix', () => {
  it('removes the id through the registry, saves the list, and undoes it', async () => {
    const { app, engine, fixes, notify, ready, saved } = fixture(['kept', 'gone'], ['kept']);
    const component = new CommunityPluginComponent({ app, engine });
    component.load();
    ready();
    const problem = ensureNonNullable(engine.getAllProblems()[0]);
    const [fix] = await fixes.getFixes(problem);
    expect(fix?.label).toBe('Remove gone from the enabled community plugins');
    await ensureNonNullable(fix).run();
    expect(app.plugins.disablePluginAndSave).toHaveBeenCalledWith('gone');
    expect(saved).toEqual([['kept']]);
    expect(missingIds(engine)).toEqual([]);
    expect(await fixes.getFixes(problem)).toEqual([]);
    const [message, undo] = ensureNonNullable(notify.mock.calls[0]);
    expect(message).toBe('Removed gone from the enabled community plugins');
    await undo();
    expect(saved.at(-1)).toEqual(['kept', 'gone']);
    expect(missingIds(engine)).toEqual(['gone']);
    await expect(undo()).rejects.toThrow('Cannot undo');
    component.unload();
  });

  it('offers nothing once the plugin is installed, and refuses a fix whose id was installed after the offer', async () => {
    const { app, engine, fixes, install } = fixture(['gone'], []);
    engine.setMissingCommunityPlugins(getCommunityPluginsConfigPath(app), ['gone']);
    const problem = ensureNonNullable(engine.getAllProblems()[0]);
    const [fix] = await fixes.getFixes(problem);
    install('gone');
    await expect(ensureNonNullable(fix).run()).rejects.toThrow('changed since');
    expect(await fixes.getFixes(problem)).toEqual([]);
    expect(app.plugins.disablePluginAndSave).not.toHaveBeenCalled();
  });
});
