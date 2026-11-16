import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

describe('Community plugin problems', () => {
  it('reports an enabled id with no installed plugin, and removes it from community-plugins.json', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const id = 'vault-problems-missing-probe';
        const configPath = `${app.vault.configDir}/community-plugins.json`;
        function missing(): string[] {
          return (plugin.linkEngine?.getProblems(configPath) ?? []).flatMap((problem) => problem.missingCommunityPluginId ?? []);
        }
        async function savedIds(): Promise<unknown> {
          return JSON.parse(await app.vault.adapter.read(configPath));
        }
        try {
          // A stale id as a hand edit or an id change leaves it: listed as enabled, with no plugin folder.
          app.plugins.enabledPlugins.add(id);
          await app.plugins.saveConfig();
          app.plugins.trigger('changed');
          await waitUntil({ predicate: () => missing().includes(id), timeoutInMilliseconds: 8000 });
          const before = missing();
          const savedBefore = await savedIds();
          const problem = plugin.linkEngine?.getProblems(configPath).find((item) => item.missingCommunityPluginId === id);
          const fixes = problem ? await plugin.problemFixes?.getFixes(problem) : undefined;
          const fix = fixes?.[0];
          if (!fix) {
            throw new Error('Missing remove fix');
          }
          await fix.run();
          await waitUntil({ predicate: () => !missing().includes(id), timeoutInMilliseconds: 8000 });
          return { before, label: fix.label, savedAfter: await savedIds(), savedBefore, stillEnabled: app.plugins.enabledPlugins.has(id) };
        } finally {
          if (app.plugins.enabledPlugins.delete(id)) {
            await app.plugins.saveConfig();
            app.plugins.trigger('changed');
          }
        }
      }
    });
    expect(result.before).toContain('vault-problems-missing-probe');
    expect(result.savedBefore).toContain('vault-problems-missing-probe');
    expect(result.label).toBe('Remove vault-problems-missing-probe from the enabled community plugins');
    expect(result.savedAfter).not.toContain('vault-problems-missing-probe');
    expect(result.savedAfter).toContain('vault-problems');
    expect(result.stillEnabled).toBe(false);
  });
});
