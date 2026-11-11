import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

describe('Cut-and-paste repair on Android', () => {
  it('follows heading and block targets through a trusted Ctrl+X and Ctrl+V into another note', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { pressKey, waitUntil }, obsidianModule: { MarkdownView } }) {
        const root = 'automatic-move-repair-android';
        const timeoutInMilliseconds = 8000;
        const readyTimeoutInMilliseconds = 2500;
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const leaf = app.workspace.getLeaf(true);
        const trace: unknown[] = [];
        const renameRef = app.vault.on('rename', (file, oldPath) => {
          trace.push({ fileOperation: 'rename', oldPath, path: file.path });
        });
        const deleteRef = app.vault.on('delete', (file) => {
          trace.push({ fileOperation: 'delete', path: file.path });
        });
        await app.vault.createFolder(root);
        try {
          const text = '# Original\n\nA block. ^alpha\n';
          const target = await app.vault.create(`${root}/Target.md`, text);
          const destination = await app.vault.create(`${root}/Destination.md`, '');
          const source = await app.vault.create(`${root}/Source.md`, `[[${root}/Target#original|Heading]]\n[[${root}/Target#^alpha|Block]]\n`);
          await waitUntil({ message: 'heading and block backlinks resolve before the cut', predicate: () => plugin.linkEngine?.getRows(source.path).filter((row) => row.target).length === 2, timeoutInMilliseconds });
          await leaf.openFile(target, { state: { mode: 'source' } });
          await app.workspace.revealLeaf(leaf);
          if (!(leaf.view instanceof MarkdownView)) {
            throw new TypeError('Expected the source editor.');
          }
          await waitUntil({ message: 'the target content is loaded in the source editor', predicate: () => leaf.view instanceof MarkdownView && leaf.view.editor.getValue().includes('^alpha'), timeoutInMilliseconds: readyTimeoutInMilliseconds });
          const cutText = leaf.view.editor.getValue();
          // A failure reports every editor transaction and file operation from the cut on, since the repair needs a
          // Delete.cut and an input.paste with no other user edit or file operation between them.
          const { cm } = leaf.view.editor;
          const originalUpdate = cm.update.bind(cm);
          cm.update = (transactions): void => {
            for (const transaction of transactions) {
              const userEvent = ['delete.cut', 'input.paste', 'input', 'delete', 'undo', 'redo', 'select'].find((candidate) => transaction.isUserEvent(candidate)) ?? null;
              trace.push({ changes: transaction.changes.toJSON(), userEvent });
            }
            originalUpdate(transactions);
          };
          leaf.view.editor.focus();
          leaf.view.editor.setSelection({ ch: 0, line: 0 }, leaf.view.editor.offsetToPos(cutText.length));
          await waitUntil({ message: 'the source editor holds focus for Ctrl+X', predicate: () => leaf.view instanceof MarkdownView && leaf.view.editor.hasFocus(), timeoutInMilliseconds: readyTimeoutInMilliseconds });
          // A trusted Ctrl+X runs the WebView's own Cut command, which fires a trusted cut event that CodeMirror turns
          // Into a delete.cut transaction and writes to the device clipboard.
          await pressKey({ key: 'x', modifiers: ['Ctrl'] });
          await waitUntil({ message: 'Ctrl+X removes the selected content', predicate: () => leaf.view instanceof MarkdownView && leaf.view.editor.getValue() === '', timeoutInMilliseconds: readyTimeoutInMilliseconds });
          await leaf.openFile(destination, { state: { mode: 'source' } });
          await app.workspace.revealLeaf(leaf);
          if (!(leaf.view instanceof MarkdownView)) {
            throw new TypeError('Expected the destination editor.');
          }
          leaf.view.editor.focus();
          await waitUntil({ message: 'the destination editor holds focus for Ctrl+V', predicate: () => leaf.view instanceof MarkdownView && leaf.view.editor.hasFocus(), timeoutInMilliseconds: readyTimeoutInMilliseconds });
          // A trusted Ctrl+V runs the WebView's Paste command, which reads the device clipboard into a trusted paste event.
          await pressKey({ key: 'v', modifiers: ['Ctrl'] });
          try {
            await waitUntil({ message: 'Ctrl+V inserts the cut content into the destination editor', predicate: () => leaf.view instanceof MarkdownView && leaf.view.editor.getValue().replaceAll('\r\n', '\n') === cutText.replaceAll('\r\n', '\n'), timeoutInMilliseconds: readyTimeoutInMilliseconds });
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
            throw new Error(`${String(error)}: ${JSON.stringify({ destination: await app.vault.read(destination), editorText, expectedText: cutText, headings: app.metadataCache.getFileCache(destination)?.headings, notices: [...document.querySelectorAll('.notice')].map((notice) => notice.textContent), problems: plugin.linkEngine?.getProblems(source.path), source: await app.vault.read(source), target: await app.vault.read(target), trace })}`, { cause: error });
          }
          return await app.vault.read(source);
        } finally {
          app.vault.offref(renameRef);
          app.vault.offref(deleteRef);
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
