import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

describe('Live editor problems', () => {
  it('underlines a missing link, offers hover and cursor fixes, and removes the underline after fixing', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { clickElement, hoverElement, waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const source = await app.vault.create('editor-problems-probe.md', '[[Editor problem missing target|Caption]]\n');
        const leaf = app.workspace.getLeaf(true);
        const timeoutInMilliseconds = 5000;
        try {
          await leaf.openFile(source, { active: true });
          await app.workspace.revealLeaf(leaf);
          const view = leaf.view as import('obsidian').MarkdownView;
          await leaf.setViewState({ state: { file: source.path, mode: 'source', source: true }, type: 'markdown' });
          const cm = view.editor.cm;
          await waitUntil({ message: 'the missing link is underlined', predicate: () => cm.dom.querySelector('.vault-problems-underline') !== null, timeoutInMilliseconds });
          const mark = cm.dom.querySelector<HTMLElement>('.vault-problems-underline');
          if (!mark) {
            throw new Error('Missing underline');
          }
          await hoverElement({ element: mark });
          await waitUntil({ message: 'hover offers quick fixes', predicate: () => document.querySelector('.vault-problems-tooltip button') !== null, timeoutInMilliseconds });
          const hoverText = document.querySelector('.vault-problems-tooltip')?.textContent;
          view.editor.setCursor({ ch: 4, line: 0 });
          view.editor.focus();
          app.commands.executeCommandById('vault-problems:quick-fixes-at-cursor');
          await waitUntil({ message: 'the cursor command opens the fix menu', predicate: () => [...document.querySelectorAll('.menu-item')].some((item) => item.textContent.includes('Remove link, keep text')), timeoutInMilliseconds });
          const remove = [...document.querySelectorAll<HTMLElement>('.menu-item')].find((item) => item.textContent.includes('Remove link, keep text'));
          if (!remove) {
            throw new Error('Missing unlink action');
          }
          await clickElement({ element: remove });
          await waitUntil({ message: 'unlink removes the diagnostic and underline', predicate: () => plugin.linkEngine?.getProblems(source.path).length === 0 && cm.dom.querySelector('.vault-problems-underline') === null, timeoutInMilliseconds });
          return { hoverText, text: view.editor.getValue() };
        } finally {
          leaf.detach();
          await app.fileManager.trashFile(source);
        }
      }
    });
    expect(result.hoverText).toContain('Quick fixes');
    expect(result.text).toBe('Caption\n');
  });
});
