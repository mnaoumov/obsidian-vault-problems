import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';
import type { RepairSettingTab } from './repair-setting-tab.ts';

describe('Path and misplaced-attachment problems', () => {
  it('reports a path too long for Windows under a long vault root, and renames it to a name that fits', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const tab = app.setting.pluginTabs.find((item) => item.id === 'vault-problems') as RepairSettingTab | undefined;
        if (!tab) {
          throw new Error('Missing settings tab');
        }
        // The settings tab names each platform by a string key, as a user's toggle does.
        const windowsKey = 'pathCompatibility:Windows';
        const oldWindowsValue = tab.getControlValue(windowsKey);
        const oldRootLength = plugin.maxVaultRootPathLength;
        const root = 'path-probe';
        await app.vault.createFolder(root);
        const file = await app.vault.create(`${root}/a-name-long-enough-to-truncate.md`, '');
        function pathKinds(path: string): string[] {
          return (plugin.linkEngine?.getProblems(path) ?? []).filter((problem) => problem.row.kind === 'path').map((problem) => String(problem.pathViolation?.type));
        }
        try {
          await tab.setControlValue(windowsKey, true);
          await tab.setControlValue('maxVaultRootPathLength', 220);
          await waitUntil({ predicate: () => pathKinds(file.path).length > 0, timeoutInMilliseconds: 8000 });
          const before = pathKinds(file.path);
          const problem = plugin.linkEngine?.getProblems(file.path).find((item) => item.row.kind === 'path');
          const fixes = problem ? await plugin.problemFixes?.getFixes(problem) : undefined;
          const fix = fixes?.[0];
          if (!fix) {
            throw new Error('Missing rename fix');
          }
          await fix.run();
          const renamed = app.vault.getFolderByPath(root)?.children.map((child) => child.path) ?? [];
          await waitUntil({ predicate: () => renamed.every((path) => pathKinds(path).length === 0), timeoutInMilliseconds: 8000 });
          return { before, label: fix.label, renamed };
        } finally {
          await tab.setControlValue(windowsKey, oldWindowsValue);
          await tab.setControlValue('maxVaultRootPathLength', oldRootLength);
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result.before).toContain('PathTooLong');
    expect(result.label).toMatch(/^Rename to a-name/u);
    expect(result.renamed).toHaveLength(1);
    expect(result.renamed[0]?.length).toBeLessThan('path-probe/a-name-long-enough-to-truncate.md'.length);
  });

  it('reports an embed of an attachment outside the note\'s attachment folder, and moves it there', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const oldFolder = app.vault.getConfig('attachmentFolderPath');
        app.vault.setConfig('attachmentFolderPath', 'misplaced-probe-home');
        const root = 'misplaced-probe';
        await app.vault.createFolder(root);
        const image = await app.vault.createBinary(`${root}/probe-image.png`, new ArrayBuffer(8));
        const note = await app.vault.create('misplaced-probe-note.md', `![[${image.path}]]\n`);
        function misplaced(): string[] {
          return (plugin.linkEngine?.getProblems(note.path) ?? []).filter((problem) => problem.row.kind === 'misplaced-attachment').map((problem) => problem.message);
        }
        try {
          await waitUntil({ predicate: () => misplaced().length === 1, timeoutInMilliseconds: 8000 });
          const before = misplaced();
          const problem = plugin.linkEngine?.getProblems(note.path).find((item) => item.row.kind === 'misplaced-attachment');
          const fixes = problem ? await plugin.problemFixes?.getFixes(problem) : undefined;
          const fix = fixes?.[0];
          if (!fix) {
            throw new Error('Missing move fix');
          }
          await fix.run();
          await waitUntil({ predicate: () => misplaced().length === 0, timeoutInMilliseconds: 8000 });
          return { before, label: fix.label, moved: image.path, text: await app.vault.read(note) };
        } finally {
          app.vault.setConfig('attachmentFolderPath', oldFolder);
          await app.fileManager.trashFile(note);
          for (const path of [root, 'misplaced-probe-home']) {
            const folder = app.vault.getFolderByPath(path);
            if (folder) {
              await app.fileManager.trashFile(folder);
            }
          }
        }
      }
    });
    expect(result.before[0]).toContain('misplaced-probe/probe-image.png is outside');
    expect(result.label).toBe('Move probe-image.png to misplaced-probe-home');
    expect(result.moved).toBe('misplaced-probe-home/probe-image.png');
    expect(result.text).toContain('probe-image.png');
  });
});
