/**
 * @file
 *
 * Produces the desktop screenshots the README and the community-store listing show, driving a small showcase vault
 * in a real Obsidian and writing `images/screenshots/screenshot-desktop-N.png`.
 *
 * A capture script rather than an assertion suite: it runs in a desktop project because that is where a real,
 * plugin-enabled Obsidian already exists, and it is named `*.desktop-capture.` so no standard project collects it.
 * Run it with `npm run capture:screenshots`.
 */

import {
  mkdirSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  applyObsidianTheme,
  captureObsidianScreenshot,
  evalInObsidian,
  labelScreenshot,
  pollInObsidian,
  readPngDimensions
} from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import {
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { Plugin } from './plugin.ts';

const WIDTH_IN_PIXELS = 1200;
const HEIGHT_IN_PIXELS = 800;
const POLL_TIMEOUT_IN_MILLISECONDS = 30_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

const MEETING_NOTES_PATH = 'Meeting notes.md';
const RELEASE_CHECKLIST_PATH = 'Release checklist.md';
const ROADMAP_PATH = 'Roadmap.md';
const STANDUP_PATH = 'Standup.md';

/**
 * Problems the showcase vault starts with: six in the roadmap and two syntax problems in the standup note. The
 * standup note sorts after the roadmap, so the roadmap leads the list.
 */
const INITIAL_PROBLEM_COUNT = 8;

/**
 * The roadmap's line holding a resolved and an unresolved heading link.
 */
const ROADMAP_HEADING_LINKS_LINE = 5;

/**
 * The meeting notes' `## Decisions` line.
 */
const DECISIONS_HEADING_LINE = 6;

const REPAIR_TIMEOUT_IN_MILLISECONDS = 20_000;

const SHOWCASE_NOTES: Record<string, string> = {
  [MEETING_NOTES_PATH]: '# Meeting notes\n\n## Agenda\n\nReview the roadmap and the budget.\n\n## Decisions\n\nShip the beta in March.\n',
  [RELEASE_CHECKLIST_PATH]: '# Release checklist\n\n- Update the changelog.\n- Review the release notes.\n',
  [ROADMAP_PATH]: '---\nrelated: "[[Budget 2026]]"\n---\n# Roadmap\n\nThe plan follows the [[Meeting notes#Decisions|decisions]] and the [[Meeting notes#Action items|action items]] from last week.\n\nCosts are in the [[Budget 2026]], and the design is in ![[architecture.png]].\n\nOpen questions are listed in [the API spec](Specs/API.md).\n\n- [ ] Finish the [[Release checklist#^final-review|final review]]\n',
  [STANDUP_PATH]: '---\ntitle: "Standup notes\ntags: [daily]\n---\n# Standup\n\nWaiting for the review %% ask about the deadline\n'
};

const IMAGES_DIRECTORY = join(process.cwd(), 'images', 'screenshots');

beforeAll(async () => {
  const vault = getTemporaryVault();
  vault.populate(SHOWCASE_NOTES);
  await vault.syncToDevice();

  // The author's plugins are all shot in the default dark theme, so the sets read as one series.
  await applyObsidianTheme({ theme: 'dark', vaultPath: vaultPath() });

  await pollInObsidian({
    poll: ({ app }) => (app.plugins.getPlugin('vault-problems') as null | Plugin)?.getProblems().length ?? 0,
    timeoutInMilliseconds: POLL_TIMEOUT_IN_MILLISECONDS,
    timeoutMessage: 'the showcase problems',
    until: (count) => count >= INITIAL_PROBLEM_COUNT,
    vaultPath: vaultPath()
  });

  await evalInObsidian({
    async callback({ app }): Promise<void> {
      // The note's own H1 is its title; an inline title above it would show the name twice.
      app.vault.setConfig('showInlineTitle', false);
      app.workspace.updateOptions();
      app.workspace.leftSplit.collapse();
      const leaf = app.workspace.getRightLeaf(false);
      if (!leaf) {
        throw new Error('No sidebar leaf.');
      }
      await leaf.setViewState({ active: true, type: 'vault-problems' });
      app.workspace.rightSplit.expand();
      await app.workspace.revealLeaf(leaf);
    },
    vaultPath: vaultPath()
  });
}, TEST_TIMEOUT_IN_MILLISECONDS);

describe('desktop store screenshots', () => {
  it('1 - the Problems view beside underlined links', async () => {
    await openInSource(ROADMAP_PATH);
    await waitForUnderlines();
    await shoot(1, 'Every broken link and syntax problem in one live list');
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('2 - quick fixes at the cursor', async () => {
    await openInSource(ROADMAP_PATH);
    await waitForUnderlines();
    const labels = await evalInObsidian({
      async callback({ app, lib: { waitUntil }, lineNumber }): Promise<string[]> {
        const editor = app.workspace.activeEditor?.editor;
        if (!editor) {
          throw new Error('No editor.');
        }
        const line = editor.getLine(lineNumber);
        editor.setCursor({ ch: line.indexOf('#Action items') + 2, line: lineNumber });
        editor.focus();
        app.commands.executeCommandById('vault-problems:quick-fixes-at-cursor');
        await waitUntil({
          message: 'the quick fix menu',
          predicate: () => document.querySelectorAll('.menu .menu-item').length > 1,
          timeoutInMilliseconds: 10_000
        });
        return [...document.querySelectorAll('.menu .menu-item')].map((item) => item.textContent);
      },
      input: { lineNumber: ROADMAP_HEADING_LINKS_LINE },
      vaultPath: vaultPath()
    });
    expect(labels).toContain('Remove link, keep text');
    await shoot(2, 'Quick fixes: pick the heading you meant, create it, or unlink');
    await evalInObsidian({
      async callback({ lib: { pressKey } }): Promise<void> {
        await pressKey({ key: 'Escape' });
      },
      vaultPath: vaultPath()
    });
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('3 - an edited heading takes its links with it', async () => {
    await openInSource(MEETING_NOTES_PATH);
    await evalInObsidian({
      callback({ app, lineNumber, obsidianModule: { MarkdownView } }): void {
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          throw new Error('No Markdown view.');
        }
        const editor = view.editor;
        const line = editor.getLine(lineNumber);
        if (line !== '## Decisions') {
          throw new Error(`Unexpected heading line: ${line}`);
        }
        editor.focus();
        const offset = editor.posToOffset({ ch: line.length, line: lineNumber });
        // One typed insertion, the way the editor reports a user typing at the end of the heading.
        editor.cm.dispatch({ changes: { from: offset, insert: ' and owners' }, userEvent: 'input.type' });
      },
      input: { lineNumber: DECISIONS_HEADING_LINE },
      vaultPath: vaultPath()
    });
    const roadmap = await pollInObsidian({
      input: { path: ROADMAP_PATH },
      async poll({ app, path }): Promise<string> {
        const roadmapFile = app.vault.getFileByPath(path);
        return roadmapFile ? app.vault.cachedRead(roadmapFile) : '';
      },
      timeoutInMilliseconds: REPAIR_TIMEOUT_IN_MILLISECONDS,
      timeoutMessage: 'the roadmap follows the edited heading',
      until: (text) => text.includes('#Decisions and owners'),
      vaultPath: vaultPath()
    });
    expect(roadmap).toContain('[[Meeting notes#Decisions and owners|decisions]]');
    await pollInObsidian({
      poll: () => [...document.querySelectorAll('.notice')].some((notice) => notice.textContent.includes('Undo')),
      timeoutInMilliseconds: POLL_TIMEOUT_IN_MILLISECONDS,
      timeoutMessage: 'the repair notice',
      until: (isShown) => isShown,
      vaultPath: vaultPath()
    });
    await shoot(3, 'Edit a heading and its links follow, with one-step Undo');
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('4 - syntax problems in a note', async () => {
    await evalInObsidian({
      callback(): void {
        for (const notice of document.querySelectorAll('.notice')) {
          notice.remove();
        }
      },
      vaultPath: vaultPath()
    });
    await openInSource(STANDUP_PATH);
    await evalInObsidian({
      callback({ app }): void {
        const leaf = app.workspace.getLeavesOfType('vault-problems')[0];
        const kind = leaf?.view.containerEl.querySelector<HTMLSelectElement>('select');
        if (!kind) {
          throw new Error('No kind filter.');
        }
        kind.value = 'syntax';
        kind.dispatchEvent(new Event('change'));
      },
      vaultPath: vaultPath()
    });
    await waitForUnderlines();
    await shoot(4, 'Broken frontmatter and unclosed comments are caught too');
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});

/**
 * Opens a note in the main area in source mode, where the underlines sit on the link text itself.
 *
 * @param notePath - The note to open.
 */
async function openInSource(notePath: string): Promise<void> {
  await evalInObsidian({
    async callback({ app, path }): Promise<void> {
      const note = app.vault.getFileByPath(path);
      if (!note) {
        throw new Error(`No ${path}.`);
      }
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(note, { active: true });
      await leaf.setViewState({ active: true, state: { file: path, mode: 'source', source: true }, type: 'markdown' });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    },
    input: { path: notePath },
    vaultPath: vaultPath()
  });
}

/**
 * Captures the current Obsidian window, captions it and writes it as
 * `images/screenshots/screenshot-desktop-<index>.png`, failing if it does not come back at the listing size.
 *
 * @param index - The 1-based listing position.
 * @param caption - The caption burned into the shot.
 */
async function shoot(index: number, caption: string): Promise<void> {
  const bytes = await captureObsidianScreenshot({
    heightInPixels: HEIGHT_IN_PIXELS,
    vaultPath: vaultPath(),
    widthInPixels: WIDTH_IN_PIXELS
  });
  const labeled = await labelScreenshot(bytes, { text: caption });
  expect(readPngDimensions(labeled)).toStrictEqual({
    heightInPixels: HEIGHT_IN_PIXELS,
    widthInPixels: WIDTH_IN_PIXELS
  });
  mkdirSync(IMAGES_DIRECTORY, { recursive: true });
  writeFileSync(join(IMAGES_DIRECTORY, `screenshot-desktop-${String(index)}.png`), labeled);
}

function vaultPath(): string {
  return getTemporaryVault().path;
}

/**
 * Waits for the active editor to underline at least one problem.
 */
async function waitForUnderlines(): Promise<void> {
  await pollInObsidian({
    poll: ({ app }) => app.workspace.activeEditor?.editor?.cm.dom.querySelectorAll('.vault-problems-underline').length ?? 0,
    timeoutInMilliseconds: POLL_TIMEOUT_IN_MILLISECONDS,
    timeoutMessage: 'the editor underlines',
    until: (count) => count > 0,
    vaultPath: vaultPath()
  });
}
