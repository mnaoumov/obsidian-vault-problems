import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

// Metadata edits use the same vault API on desktop and mobile; no editor input is simulated.
describe('Live link diagnostics', () => {
  it('reads real embeds, frontmatter, reference-style links and block targets', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const engine = plugin.linkEngine;
        if (!engine) {
          throw new Error('The link engine did not load.');
        }
        const root = 'live-link-kinds';
        const timeoutInMilliseconds = 8000;
        await app.vault.createFolder(root);
        try {
          await app.vault.create(`${root}/Target.md`, '# Original\n\nA block. ^example\n');
          const source = await app.vault.create(`${root}/Source.md`, `---\nrelated: "[[${root}/Target]]"\n---\n\n![[${root}/Target]]\n\n[heading][ref]\n\n[ref]: ${root}/Target#Original\n\n[block](${root}/Target#^example)\n`);
          await waitUntil({
            message: 'all four kinds appear in the live metadata snapshot',
            predicate: () => engine.getRows(source.path).length >= 4,
            timeoutInMilliseconds
          });
          return engine.getRows(source.path).map((row) => ({ kind: row.kind, target: row.target?.kind })).sort((left, right) => left.kind.localeCompare(right.kind));
        } finally {
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result).toEqual([
      { kind: 'embed', target: 'file' },
      { kind: 'frontmatter', target: 'file' },
      { kind: 'link', target: 'block' },
      { kind: 'reference', target: 'heading' }
    ]);
  });

  it('reports a heading edit and a deleted note as new breaks without a manual scan', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const engine = plugin.linkEngine;
        if (!engine) {
          throw new Error('The link engine did not load.');
        }
        const root = 'live-link-diagnostics';
        const timeoutInMilliseconds = 8000;
        await app.vault.createFolder(root);
        try {
          const target = await app.vault.create(`${root}/Target.md`, '# Original\n');
          const source = await app.vault.create(`${root}/Source.md`, `[[${root}/Target#Original]]\n[[${root}/Target]]\n`);
          await waitUntil({
            message: 'both initial links resolve in the live snapshot',
            predicate: () => engine.getRows(source.path).length === 2 && engine.getRows(source.path).every((row) => row.target),
            timeoutInMilliseconds
          });
          await app.vault.modify(target, '# Replacement\n');
          await waitUntil({
            message: 'the heading edit is reported as a new break',
            predicate: () => engine.getProblems(source.path).length === 1,
            timeoutInMilliseconds
          });
          const heading = engine.getProblems(source.path).map((problem) => ({ cause: problem.cause?.kind, status: problem.status }));
          await app.fileManager.trashFile(target);
          await waitUntil({
            message: 'deleting the target reports the remaining file link immediately after resolution',
            predicate: () => engine.getProblems(source.path).length === 2,
            timeoutInMilliseconds
          });
          return { deleted: engine.getProblems(source.path).map((problem) => problem.status), heading };
        } finally {
          const folder = app.vault.getFolderByPath(root);
          if (folder) {
            await app.fileManager.trashFile(folder);
          }
        }
      }
    });
    expect(result).toEqual({ deleted: ['new', 'new'], heading: [{ cause: 'changed', status: 'new' }] });
  });
});
