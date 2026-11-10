/**
@file

HTML problems against the REAL `Advanced Metadata Cache`, a release publishing contract `1.15.0`, with its opt-in
`HTML` module turned on. A stand-in API would only prove that this plugin shows what it is handed; the point here is
that the verdict is the running Obsidian's sanitizer's, and that an edit and the provider going away both reach the
Problems list.

The released plugin is written into the vault and enabled inside the closure, then disabled and removed, so the
other suites sharing the vault never see it.
*/

import { evalInObsidian } from 'obsidian-integration-testing';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

import { downloadReleasedPlugin } from '../scripts/helpers/download-released-plugin.ts';

const ADVANCED_METADATA_CACHE_PLUGIN_ID = 'advanced-metadata-cache';
const ADVANCED_METADATA_CACHE_REPO = 'mnaoumov/obsidian-advanced-metadata-cache';
const ADVANCED_METADATA_CACHE_VERSION = '2.6.0';

// Several waits on this constant, under the transport's ~30 s closure cap.
const WAIT_TIMEOUT_IN_MILLISECONDS = 5000;

const CONTENT = 'Text <nonExistingTag>bravo</nonExistingTag> <alpha-widget>charlie</alpha-widget> <b>bold</b>\n\n<script>alert(1)</script>\n\n`<code-example>`\n';

interface ProbeResult {
  readonly afterEdit: string[];
  readonly afterUnload: UnloadResult;
  readonly initial: string[];
  readonly kinds: string[];
}

interface UnloadResult {
  readonly problems: string[];
  readonly status: null | string;
}

describe('HTML problems', () => {
  it('lists unknown and sanitized tags from Advanced Metadata Cache, follows an edit, and says when it cannot check', async () => {
    const released = await downloadReleasedPlugin({
      pluginId: ADVANCED_METADATA_CACHE_PLUGIN_ID,
      repo: ADVANCED_METADATA_CACHE_REPO,
      version: ADVANCED_METADATA_CACHE_VERSION
    });

    const result = await evalInObsidian({
      async callback({ app, content, lib: { waitUntil }, mainJs, manifestJson, providerId, waitTimeoutInMilliseconds }): Promise<ProbeResult> {
        const plugin = app.plugins.getPlugin('vault-problems') as Plugin;
        const stamp = `${Date.now().toString()}-${Math.floor(performance.now()).toString()}`;
        const notePath = `html-problems-${stamp}.md`;
        const pluginFolder = `${app.vault.configDir}/plugins/${providerId}`;

        function describeProblems(): string[] {
          return (plugin.linkEngine?.getProblems(notePath) ?? []).filter((problem) => problem.html).map((problem) => `${String(problem.row.position?.start.line)}:${problem.message}`);
        }

        await app.vault.adapter.mkdir(pluginFolder);
        await app.vault.adapter.write(`${pluginFolder}/main.js`, mainJs);
        await app.vault.adapter.write(`${pluginFolder}/manifest.json`, manifestJson);
        await app.vault.adapter.write(`${pluginFolder}/data.json`, JSON.stringify({ isHtmlModuleEnabled: true }));

        const note = await app.vault.create(notePath, content);
        try {
          await app.plugins.loadManifests();
          await app.plugins.enablePlugin(providerId);
          await waitUntil({
            message: 'the note\'s HTML problems did not reach the engine',
            predicate: () => describeProblems().length >= 3,
            timeoutInMilliseconds: waitTimeoutInMilliseconds
          });
          const initial = describeProblems();
          const kinds = [...new Set((plugin.linkEngine?.getProblems(notePath) ?? []).filter((problem) => problem.html).map((problem) => problem.row.kind))];

          await app.vault.modify(note, 'Only <b>bold</b> and <nonExistingTag>x</nonExistingTag>\n');
          await waitUntil({
            message: 'the edit did not refresh the note\'s HTML problems',
            predicate: () => describeProblems().every((line) => !line.includes('<script>')) && describeProblems().length > 0,
            timeoutInMilliseconds: waitTimeoutInMilliseconds
          });
          const afterEdit = describeProblems();

          await app.plugins.disablePlugin(providerId);
          await waitUntil({
            message: 'the HTML problems were not cleared when the provider went away',
            predicate: () => describeProblems().length === 0 && plugin.htmlCheckComponent?.statusMessage !== null,
            timeoutInMilliseconds: waitTimeoutInMilliseconds
          });
          const afterUnload = { problems: describeProblems(), status: plugin.htmlCheckComponent?.statusMessage ?? null };

          return { afterEdit, afterUnload, initial, kinds };
        } finally {
          await app.plugins.disablePlugin(providerId);
          await app.vault.adapter.rmdir(pluginFolder, true);
          await app.plugins.loadManifests();
          await app.fileManager.trashFile(note);
        }
      },
      input: {
        content: CONTENT,
        mainJs: released.mainJs,
        manifestJson: released.manifestJson,
        providerId: ADVANCED_METADATA_CACHE_PLUGIN_ID,
        waitTimeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
      }
    });

    expect(result.kinds).toEqual(['html']);
    expect(result.initial).toContain('0:Unknown HTML tag <nonExistingTag>: Obsidian renders it as an element no browser knows');
    expect(result.initial).toContain('2:Obsidian\'s sanitizer changes or removes <script> when it renders this note');
    // A custom element is not unknown for want of registration, though Obsidian's sanitizer drops it (measured in
    // Obsidian 1.15). Ordinary HTML is not a problem, and a code span is not HTML at all.
    expect(result.initial).toContain('0:Obsidian\'s sanitizer changes or removes <alpha-widget> when it renders this note');
    expect(result.initial.join('\n')).not.toContain('Unknown HTML tag <alpha-widget>');
    expect(result.initial.join('\n')).not.toContain('<b>');
    expect(result.initial.join('\n')).not.toContain('code-example');

    expect(result.afterEdit).toContain('0:Unknown HTML tag <nonExistingTag>: Obsidian renders it as an element no browser knows');

    expect(result.afterUnload.problems).toEqual([]);
    expect(result.afterUnload.status).toContain('needs the Advanced Metadata Cache plugin');
  }, 180_000);
});
