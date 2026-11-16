import type { App } from 'obsidian';

import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

interface DemoSetup {
  readonly createIncompatibleName: (app: App) => Promise<void>;
  readonly createMisplacedAttachment: (app: App) => Promise<void>;
  readonly removeIncompatibleName: (app: App) => Promise<void>;
  readonly removeMisplacedAttachment: (app: App) => Promise<void>;
}

// The demo vault's `06 Path and attachment checks` buttons call these helpers. The button suite only proves they
// Run; this proves each one makes the row the note promises, and that the quick fix it names repairs it.
describe('Demo vault path and attachment checks', () => {
  it('creates a name a link cannot reach, reports it, and renames it with the quick fix', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        // `CodeScript Toolkit` resolves a root-relative require against its modules root, as the button does.
        // eslint-disable-next-line @typescript-eslint/no-require-imports, import-x/no-absolute-path, unicorn/prefer-module -- Only `CodeScript Toolkit`'s require reaches the vault's root-relative /demoSetup.ts.
        const demo = require('/demoSetup.ts') as DemoSetup;
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const path = 'Materials/06 Path and attachment checks/Draft #1.md';
        function pathProblems(): string[] {
          return (plugin.linkEngine?.getProblems(path) ?? []).filter((problem) => problem.row.kind === 'path').map((problem) => String(problem.pathViolation?.type));
        }
        try {
          await demo.createIncompatibleName(app);
          await waitUntil({ predicate: () => pathProblems().length > 0, timeoutInMilliseconds: 8000 });
          const kinds = pathProblems();
          const problem = plugin.linkEngine?.getProblems(path).find((item) => item.row.kind === 'path');
          const fixes = problem ? await plugin.problemFixes?.getFixes(problem) : undefined;
          const fix = fixes?.[0];
          if (!fix) {
            throw new Error('Missing rename fix');
          }
          await fix.run();
          const isRenamed = app.vault.getFileByPath('Materials/06 Path and attachment checks/Draft -1.md') !== null;
          await demo.removeIncompatibleName(app);
          return { isRenamed, kinds, label: fix.label, left: app.vault.getFolderByPath('Materials/06 Path and attachment checks')?.children.map((child) => child.name) };
        } finally {
          await demo.removeIncompatibleName(app);
        }
      }
    });
    expect(result.kinds).toContain('ObsidianForbiddenCharacter');
    expect(result.label).toBe('Rename to Draft -1.md');
    expect(result.isRenamed).toBe(true);
    expect(result.left).toEqual(['Note.md']);
  });

  it('creates an attachment outside the attachment folder, reports it, and moves it with the quick fix', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, import-x/no-absolute-path, unicorn/prefer-module -- Only `CodeScript Toolkit`'s require reaches the vault's root-relative /demoSetup.ts.
        const demo = require('/demoSetup.ts') as DemoSetup;
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const notePath = 'Materials/06 Path and attachment checks/Note.md';
        function misplaced(): string[] {
          return (plugin.linkEngine?.getProblems(notePath) ?? []).filter((problem) => problem.row.kind === 'misplaced-attachment').map((problem) => problem.message);
        }
        try {
          await demo.createMisplacedAttachment(app);
          await waitUntil({ predicate: () => misplaced().length === 1, timeoutInMilliseconds: 8000 });
          const messages = misplaced();
          const problem = plugin.linkEngine?.getProblems(notePath).find((item) => item.row.kind === 'misplaced-attachment');
          const fixes = problem ? await plugin.problemFixes?.getFixes(problem) : undefined;
          const fix = fixes?.[0];
          if (!fix) {
            throw new Error('Missing move fix');
          }
          await fix.run();
          await waitUntil({ predicate: () => misplaced().length === 0, timeoutInMilliseconds: 8000 });
          const isMoved = app.vault.getFileByPath('_assets/attachments/Diagram.svg') !== null;
          const note = app.vault.getFileByPath(notePath);
          const text = note ? await app.vault.read(note) : '';
          await demo.removeMisplacedAttachment(app);
          const cleanText = note ? await app.vault.read(note) : '';
          return { cleanText, isMoved, label: fix.label, messages, text };
        } finally {
          await demo.removeMisplacedAttachment(app);
        }
      }
    });
    expect(result.messages[0]).toContain('Materials/06 Path and attachment checks/Diagram.svg is outside');
    expect(result.label).toBe('Move Diagram.svg to _assets/attachments');
    expect(result.isMoved).toBe(true);
    expect(result.text).toContain('Diagram.svg');
    expect(result.cleanText).not.toContain('Diagram.svg');
  });
});
