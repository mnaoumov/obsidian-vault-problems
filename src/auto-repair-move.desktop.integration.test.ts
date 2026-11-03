import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

describe('Cut-and-paste repair', () => {
  it('follows heading and block targets through a real cut and paste into another note', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil }, obsidianModule: { MarkdownView } }) {
        const root = 'automatic-move-repair';
        const timeoutInMilliseconds = 8000;
        const readyTimeoutInMilliseconds = 2500;
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const previousClipboard = window.electron.clipboard.readText();
        const leaf = app.workspace.getLeaf(true);
        await app.vault.createFolder(root);
        try {
          const text = '# Original\n\nA block. ^alpha\n';
          const target = await app.vault.create(`${root}/Target.md`, text);
          const destination = await app.vault.create(`${root}/Destination.md`, '');
          const source = await app.vault.create(`${root}/Source.md`, `[[${root}/Target#original|Heading]]\n[[${root}/Target#^alpha|Block]]\n`);
          await waitUntil({ message: 'heading and block backlinks resolve before the cut', predicate: () => plugin.linkEngine?.getRows(source.path).filter((row) => row.target).length === 2, timeoutInMilliseconds });
          await leaf.openFile(target);
          await app.workspace.revealLeaf(leaf);
          if (!(leaf.view instanceof MarkdownView)) {
            throw new TypeError('Expected the source editor.');
          }
          await waitUntil({ message: 'the target content is loaded in the source editor', predicate: () => leaf.view instanceof MarkdownView && leaf.view.editor.getValue().includes('^alpha'), timeoutInMilliseconds: readyTimeoutInMilliseconds });
          const cutText = leaf.view.editor.getValue();
          leaf.view.editor.setSelection({ ch: 0, line: 0 }, leaf.view.editor.offsetToPos(cutText.length));
          window.electron.remote.getCurrentWebContents().focus();
          leaf.view.editor.focus();
          // Native Edit > Cut drives a trusted clipboard event in the offscreen test window.
          window.electron.remote.getCurrentWebContents().cut();
          await waitUntil({ message: 'cut removes the selected content', predicate: () => leaf.view instanceof MarkdownView && leaf.view.editor.getValue() === '', timeoutInMilliseconds: readyTimeoutInMilliseconds });
          await leaf.openFile(destination);
          await app.workspace.revealLeaf(leaf);
          if (!(leaf.view instanceof MarkdownView)) {
            throw new TypeError('Expected the destination editor.');
          }
          window.electron.remote.getCurrentWebContents().focus();
          leaf.view.editor.focus();
          await waitUntil({ message: 'the destination editor holds focus for native Paste', predicate: () => leaf.view instanceof MarkdownView && leaf.view.editor.hasFocus(), timeoutInMilliseconds: readyTimeoutInMilliseconds });
          // Native Paste delivers no data in the owned offscreen window. A fixture ClipboardEvent drives
          // Obsidian/CodeMirror's actual paste handler; insertion and the resulting repair are both asserted.
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', cutText);
          const contentElement = leaf.view.containerEl.querySelector<HTMLElement>('.cm-content');
          if (!contentElement) {
            throw new Error('The destination clipboard handler is not mounted.');
          }
          contentElement.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
          try {
            await waitUntil({ message: 'native Paste inserts the cut content into the destination editor', predicate: () => leaf.view instanceof MarkdownView && leaf.view.editor.getValue().replaceAll('\r\n', '\n') === cutText.replaceAll('\r\n', '\n'), timeoutInMilliseconds: readyTimeoutInMilliseconds });
            await waitUntil({
              message: 'both links follow their pasted targets',
              predicate: async () => {
                const content = await app.vault.read(source);
                return content.includes('Destination#Original') && content.includes('Destination#^alpha');
              },
              timeoutInMilliseconds
            });
          } catch (error) {
            const editorText = leaf.view instanceof MarkdownView ? leaf.view.editor.getValue() : '';
            throw new Error(`${String(error)}: ${JSON.stringify({ actualLength: editorText.length, destination: await app.vault.read(destination), editorText: editorText.replaceAll(/\s/gu, '') === cutText.replaceAll(/\s/gu, '') ? editorText : 'not the fixture content', expectedText: cutText, headings: app.metadataCache.getFileCache(destination)?.headings, notices: [...document.querySelectorAll('.notice')].map((notice) => notice.textContent), problems: plugin.linkEngine?.getProblems(source.path), source: await app.vault.read(source), target: await app.vault.read(target) })}`, { cause: error });
          }
          return await app.vault.read(source);
        } finally {
          window.electron.clipboard.writeText(previousClipboard);
          leaf.detach();
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result).toContain('Destination#Original|Heading');
    expect(result).toContain('Destination#^alpha|Block');
    expect(result).not.toContain('Target#');
  });
});
