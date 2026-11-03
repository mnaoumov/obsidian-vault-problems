import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';
import type { ProblemsView } from './problems-view.ts';

describe('Live Problems view and quick fixes', () => {
  it('unlinks reference use sites and preserves their formatting and code examples', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const source = await app.vault.create('problems-reference-removal.md', '[**Caption**][ref]\n\n`[code][ref]`\n\n[ref]: NoSuchNote.md "Title"\n');
        try {
          await waitUntil({ predicate: () => plugin.linkEngine?.getProblems(source.path).length === 1, timeoutInMilliseconds: 8000 });
          const problem = plugin.linkEngine?.getProblems(source.path)[0];
          if (!problem) {
            throw new Error('Missing reference problem');
          }
          const fixes = await plugin.problemFixes?.getFixes(problem);
          const remove = fixes?.find((fix) => fix.label === 'Remove link, keep text');
          if (!remove) {
            throw new Error('Missing reference unlink action');
          }
          await remove.run();
          await waitUntil({ predicate: () => plugin.linkEngine?.getProblems(source.path).length === 0, timeoutInMilliseconds: 8000 });
          return await app.vault.read(source);
        } finally {
          await app.fileManager.trashFile(source);
        }
      }
    });
    expect(result).toBe('**Caption**\n\n`[code][ref]`\n\n\n');
  });
  it('shows live groups and filters, navigates to a link, and removes it while preserving its caption', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const root = 'problems-view-probe';
        await app.vault.createFolder(root);
        const source = await app.vault.create(`${root}/Source.md`, 'Hello [[Never exists|caption]].\n');
        try {
          await waitUntil({ predicate: () => plugin.getProblems().some((problem) => problem.row.sourcePath === source.path), timeoutInMilliseconds: 8000 });
          const leaf = app.workspace.getRightLeaf(false);
          if (!leaf) {
            throw new Error('No sidebar leaf');
          }
          await leaf.setViewState({ type: 'vault-problems' });
          const view = leaf.view as ProblemsView;
          const folder = view.contentEl.querySelector<HTMLInputElement>('input');
          const kind = view.contentEl.querySelector<HTMLSelectElement>('select');
          if (!folder || !kind) {
            throw new Error('Missing filters');
          }
          folder.value = root;
          folder.dispatchEvent(new Event('input'));
          const shown = view.contentEl.textContent;
          kind.value = 'embed';
          kind.dispatchEvent(new Event('change'));
          const filtered = view.contentEl.textContent;
          kind.value = '';
          kind.dispatchEvent(new Event('change'));
          view.contentEl.querySelector<HTMLButtonElement>('.vault-problems-open')?.click();
          await waitUntil({ predicate: () => app.workspace.activeEditor?.file?.path === source.path && app.workspace.activeEditor.editor?.getSelection() === '[[Never exists|caption]]', timeoutInMilliseconds: 8000 });
          const selection = app.workspace.activeEditor?.editor?.getSelection();
          const problem = plugin.getProblems().find((item) => item.row.sourcePath === source.path);
          if (!problem || !plugin.problemFixes) {
            throw new Error('Missing problem');
          }
          const fixes = await plugin.problemFixes.getFixes(problem);
          const remove = fixes.find((fix) => fix.label === 'Remove link, keep text');
          if (!remove) {
            throw new Error('Missing remove action');
          }
          await remove.run();
          await waitUntil({ predicate: () => plugin.linkEngine?.getProblems(source.path).length === 0, timeoutInMilliseconds: 8000 });
          return { after: await app.vault.read(source), filtered, selection, shown, text: view.contentEl.textContent };
        } finally {
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result.shown).toContain('Cannot resolve Never exists');
    expect(result.filtered).toContain('No problems match');
    expect(result.selection).toBe('[[Never exists|caption]]');
    expect(result.after).toBe('Hello caption.\n');
    expect(result.text).toContain('0 problem(s)');
  });

  it('creates a missing note and heading, restores a chosen block id and chooses a replacement heading', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const root = 'problems-create-probe';
        await app.vault.createFolder(root);
        const target = await app.vault.create(`${root}/Target.md`, '# Existing\n\nParagraph to restore.\n');
        const source = await app.vault.create(`${root}/Source.md`, `[[${root}/New]]\n[[${root}/Target#Missing]]\n[[${root}/Target#^old-id]]\n`);
        try {
          await waitUntil({ predicate: () => plugin.linkEngine?.getProblems(source.path).length === 3, timeoutInMilliseconds: 8000 });
          const actions: string[] = [];
          for (const prefix of [`Create ${root}/New.md`, 'Create heading #Missing', 'Restore ^old-id']) {
            const problems = plugin.linkEngine?.getProblems(source.path) ?? [];
            let didRun = false;
            for (const problem of problems) {
              const fixes = await plugin.problemFixes?.getFixes(problem) ?? [];
              const fix = fixes.find((item) => item.label.startsWith(prefix));
              if (fix) {
                actions.push(fix.label);
                await fix.run();
                didRun = true;
                break;
              }
            }
            if (!didRun) {
              throw new Error(`Missing quick fix: ${prefix}`);
            }
            const count = 3 - actions.length;
            await waitUntil({ predicate: () => plugin.linkEngine?.getProblems(source.path).length === count, timeoutInMilliseconds: 8000 });
          }
          await app.vault.modify(source, `[[${root}/Target#Not here|Keep]]\n`);
          await waitUntil({ predicate: () => plugin.linkEngine?.getProblems(source.path)[0]?.row.link.endsWith('#Not here') === true, timeoutInMilliseconds: 8000 });
          const problem = plugin.linkEngine?.getProblems(source.path)[0];
          if (!problem) {
            throw new Error('Missing heading problem');
          }
          const fixes = await plugin.problemFixes?.getFixes(problem);
          const replacement = fixes?.find((fix) => fix.label === `Use ${root}/Target.md#Existing`);
          if (!replacement) {
            throw new Error('Missing heading candidate');
          }
          await replacement.run();
          return { actions, note: app.vault.getFileByPath(`${root}/New.md`)?.path, source: await app.vault.read(source), target: await app.vault.read(target) };
        } finally {
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result.actions).toHaveLength(3);
    expect(result.note).toBe('problems-create-probe/New.md');
    expect(result.target).toContain('# Missing');
    expect(result.target).toContain('Paragraph to restore. ^old-id');
    expect(result.source).toContain('#Existing|Keep');
  });

  it('repairs a renamed target in a mixed wikilink, frontmatter and reference-definition batch', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const root = 'problems-batch-probe';
        const oldAuto = app.vault.getConfig('alwaysUpdateLinks');
        app.vault.setConfig('alwaysUpdateLinks', false);
        await app.vault.createFolder(root);
        const target = await app.vault.create(`${root}/Old.md`, '---\naliases: [Old]\n---\n');
        const source = await app.vault.create(`${root}/Source.md`, `---\nrelated: "[[${root}/Old]]"\n---\n\n[[${root}/Old|Caption]]\n\n[caption][ref]\n\n[ref]: ${root}/Old.md "Title"\n`);
        try {
          await waitUntil({ predicate: () => plugin.linkEngine?.getRows(source.path).length === 3, timeoutInMilliseconds: 8000 });
          await app.vault.rename(target, `${root}/New.md`);
          await waitUntil({ predicate: () => plugin.linkEngine?.getProblems(source.path).length === 3, timeoutInMilliseconds: 8000 });
          const problem = plugin.linkEngine?.getProblems(source.path)[0];
          if (!problem) {
            throw new Error('Missing rename problem');
          }
          const fixes = await plugin.problemFixes?.getFixes(problem);
          const fix = fixes?.find((item) => item.label.startsWith('Update 3 links'));
          if (!fix) {
            throw new Error('Missing batch quick fix');
          }
          await fix.run();
          await waitUntil({ predicate: () => plugin.linkEngine?.getProblems(source.path).length === 0, timeoutInMilliseconds: 8000 });
          return await app.vault.read(source);
        } finally {
          app.vault.setConfig('alwaysUpdateLinks', oldAuto);
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result).toContain('New');
    expect(result).not.toContain('/Old');
    expect(result).toContain('|Caption]]');
    expect(result).toContain('[caption][ref]');
    expect(result).toContain('"Title"');
  });
});
