import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

describe('Automatic link repair', () => {
  it('follows an editor heading edit across notes and restores every link through the notice Undo button', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { pressKey, waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const root = 'automatic-link-repair';
        const timeoutInMilliseconds = 8000;
        await app.vault.createFolder(root);
        const leaf = app.workspace.getLeaf(true);
        try {
          const target = await app.vault.create(`${root}/Target.md`, '# Original\n');
          const originalSource = `---\nrelated: "[[${root}/Target#Original|Property label]]"\n---\n\n[[${root}/Target#Original|Keep this label]]\n\n![[${root}/Target#Original]]\n\n[Reference label][heading-ref]\n\n[heading-ref]: <${root}/Target.md#Original> "Preserved title"\n`;
          const originalOther = `[Keep this text](${root}/Target.md#original)\n`;
          const source = await app.vault.create(`${root}/Source.md`, originalSource);
          const other = await app.vault.create(`${root}/Other.md`, originalOther);
          const sourceLinkCount = 4;
          await waitUntil({ message: 'all backlink kinds are indexed before editing', predicate: () => Boolean(plugin.linkEngine?.getRows(source.path).filter((row) => row.target).length === sourceLinkCount && plugin.linkEngine.getRows(other.path)[0]?.target), timeoutInMilliseconds });
          await leaf.openFile(target);
          await app.workspace.revealLeaf(leaf);
          const view = leaf.view;
          if (!('editor' in view)) {
            throw new Error('The target did not open in an editor.');
          }
          const editor = view.editor as import('obsidian').Editor;
          editor.setSelection({ ch: 2, line: 0 }, { ch: 10, line: 0 });
          editor.focus();
          const earlierNotices = new Set(document.querySelectorAll('.notice'));
          await pressKey({ key: 'R' });
          try {
            await waitUntil({
              message: 'both backlink files follow the edited heading',
              predicate: async () => {
                const first = await app.vault.read(source);
                const second = await app.vault.read(other);
                return first.includes('#R') && second.includes('#R') && !/#original/iu.test(first);
              },
              timeoutInMilliseconds
            });
          } catch (error) {
            throw new Error(`${String(error)}: ${JSON.stringify({ headings: app.metadataCache.getFileCache(target)?.headings, notices: [...document.querySelectorAll('.notice')].map((notice) => notice.textContent), other: await app.vault.read(other), problems: plugin.linkEngine?.getProblems(source.path), source: await app.vault.read(source), target: await app.vault.read(target) })}`, { cause: error });
          }
          const repaired = [await app.vault.read(source), await app.vault.read(other)];
          // An earlier suite's notice can still be showing its own Undo, so take the one this repair added.
          const repairNotice = [...document.querySelectorAll<HTMLElement>('.notice')].find((notice) => !earlierNotices.has(notice) && notice.textContent.includes('Updated links:'));
          const undo = [...repairNotice?.querySelectorAll<HTMLButtonElement>('button') ?? []].find((button) => button.textContent === 'Undo');
          if (!undo) {
            throw new Error('The repair notice has no Undo button.');
          }
          // This click exercises our own handler, which does not require trusted input.
          undo.click();
          await waitUntil({
            message: 'one Undo restores both files',
            predicate: async () => {
              const first = await app.vault.read(source);
              const second = await app.vault.read(other);
              return first === originalSource && second === originalOther;
            },
            timeoutInMilliseconds
          });
          return { original: [originalSource, originalOther], repaired, restored: [await app.vault.read(source), await app.vault.read(other)] };
        } finally {
          leaf.detach();
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result.repaired.every((text) => text.includes('#R'))).toBe(true);
    expect(result.repaired[0]).toContain('Keep this label');
    expect(result.repaired[0]).toContain('Property label');
    expect(result.repaired[0]).toContain('Reference label');
    expect(result.repaired[0]).toContain('"Preserved title"');
    expect(result.repaired[1]).toContain('Keep this text');
    expect(result.restored).toEqual(result.original);
  });
});
