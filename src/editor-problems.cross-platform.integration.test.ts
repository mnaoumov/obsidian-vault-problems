import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

describe('Editor problem command', () => {
  it('opens quick fixes at the cursor and unlinks the selected problem', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { clickElement, waitUntil } }) {
        const source = await app.vault.create('editor-command-probe.md', '[[Editor command missing|Caption]]\n');
        const leaf = app.workspace.getLeaf(true);
        const timeoutInMilliseconds = 5000;
        // A loaded single-core Android emulator takes several seconds to apply the fix and redraw.
        // The three waits stay under the 30 s cap of one evalInObsidian call.
        const fixTimeoutInMilliseconds = 15_000;
        try {
          await leaf.openFile(source, { active: true });
          await app.workspace.revealLeaf(leaf);
          await leaf.setViewState({ state: { file: source.path, mode: 'source', source: true }, type: 'markdown' });
          const view = leaf.view as import('obsidian').MarkdownView;
          const cm = view.editor.cm;
          await waitUntil({ message: 'the link is underlined', predicate: () => cm.dom.querySelector('.vault-problems-underline') !== null, timeoutInMilliseconds });
          view.editor.setCursor({ ch: 4, line: 0 });
          view.editor.focus();
          app.commands.executeCommandById('vault-problems:quick-fixes-at-cursor');
          await waitUntil({ message: 'the fix menu is available', predicate: () => [...document.querySelectorAll('.menu-item')].some((item) => item.textContent.includes('Remove link, keep text')), timeoutInMilliseconds });
          const remove = [...document.querySelectorAll<HTMLElement>('.menu-item')].find((item) => item.textContent.includes('Remove link, keep text'));
          if (!remove) {
            throw new Error('Missing unlink action');
          }
          await clickElement({ element: remove });
          await waitUntil({ message: 'the editor and diagnostics reflect the fix', predicate: () => view.editor.getValue() === 'Caption\n' && cm.dom.querySelector('.vault-problems-underline') === null, timeoutInMilliseconds: fixTimeoutInMilliseconds });
          return view.editor.getValue();
        } finally {
          leaf.detach();
          await app.fileManager.trashFile(source);
        }
      }
    });
    expect(result).toBe('Caption\n');
  });
});
