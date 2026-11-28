import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

describe('Duplicate frontmatter keys and reference definitions', () => {
  it('matches what Obsidian drops, and reports both', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib: { waitUntil }, obsidianModule: { Component, MarkdownRenderer } }) {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const content = '---\na: first\nb: 1\na: second\n---\n[x][r] and [y][R]\n\n[r]: first.md\n[R]: second.md\n';
        const file = await app.vault.create('syntax-duplicates.md', content);
        const component = new Component();
        component.load();
        try {
          function syntaxCodes(): string[] {
            return (plugin.linkEngine?.getProblems(file.path) ?? []).flatMap((problem) => problem.syntax?.code ?? []);
          }
          await waitUntil({ predicate: () => syntaxCodes().length === 2, timeoutInMilliseconds: 8000 });
          const el = createDiv();
          await MarkdownRenderer.render(app, content, el, file.path, component);
          return {
            codes: syntaxCodes(),
            frontmatter: app.metadataCache.getFileCache(file)?.frontmatter ?? null,
            linkTargets: Array.from(el.querySelectorAll('a'), (anchor) => anchor.getAttribute('href'))
          };
        } finally {
          component.unload();
          await app.vault.delete(file);
        }
      }
    });
    // Obsidian rejects the whole frontmatter over one repeated key, and the first definition of a label wins.
    expect(result.frontmatter).toBeNull();
    expect(result.linkTargets).toEqual(['first.md', 'first.md']);
    expect(result.codes).toEqual(['duplicate-frontmatter-key', 'duplicate-reference-definition']);
  });
});
