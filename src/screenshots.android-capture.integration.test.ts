/**
 * @file
 *
 * Produces the mobile screenshots the README and the community-store listing show, driving a small showcase vault in
 * Obsidian Mobile on an Android emulator and writing `images/screenshots/screenshot-mobile-N.png`.
 *
 * The mobile counterpart of the desktop capture suite, with its two headline frames: the Problems view, then the
 * quick fixes on an underlined link. On a phone the Problems view is a drawer over the note rather than a pane beside
 * it, which is why the mobile set is taken rather than the desktop images reused.
 *
 * It runs on the dedicated `obsidian_screenshots` AVD, built at exactly 900x1600, so the device frame already IS the
 * listing size and needs no crop or rescale. The harness never installs the Obsidian APK on it, so provision it with
 * `provision-obsidian-avd.ps1 -AvdName obsidian_screenshots` whenever its Obsidian falls below the manifest's
 * `minAppVersion`.
 *
 * Named `*.android-capture.` so no standard project collects it. Run it with `npm run capture:screenshots`.
 */

import {
  mkdirSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
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

const WIDTH_IN_PIXELS = 900;
const HEIGHT_IN_PIXELS = 1600;

/**
 * Waited on from Node, one short eval at a time, so a slow vault scan on a freshly booted emulator is not bounded by
 * the transport's ~30s per-closure cap.
 */
const POLL_TIMEOUT_IN_MILLISECONDS = 60_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 180_000;

/**
 * Opening a drawer or a menu plays a short slide-in on mobile; a frame taken inside it shows it half drawn.
 */
const SETTLE_DELAY_IN_MILLISECONDS = 1500;

const MEETING_NOTES_PATH = 'Meeting notes.md';
const RELEASE_CHECKLIST_PATH = 'Release checklist.md';
const ROADMAP_PATH = 'Roadmap.md';
const STANDUP_PATH = 'Standup.md';

/**
 * Problems the showcase vault starts with: six in the roadmap and two syntax problems in the standup note.
 */
const INITIAL_PROBLEM_COUNT = 8;

/**
 * The roadmap's line holding a resolved and an unresolved heading link.
 */
const ROADMAP_HEADING_LINKS_LINE = 5;

/**
 * The same showcase vault as the desktop capture, so the two sets show the same problems.
 */
const SHOWCASE_NOTES: Record<string, string> = {
  [MEETING_NOTES_PATH]: '# Meeting notes\n\n## Agenda\n\nReview the roadmap and the budget.\n\n## Decisions\n\nShip the beta in March.\n',
  [RELEASE_CHECKLIST_PATH]: '# Release checklist\n\n- Update the changelog.\n- Review the release notes.\n',
  [ROADMAP_PATH]: '---\nrelated: "[[Budget 2026]]"\n---\n# Roadmap\n\nThe plan follows the [[Meeting notes#Decisions|decisions]] and the [[Meeting notes#Action items|action items]] from last week.\n\nCosts are in the [[Budget 2026]], and the design is in ![[architecture.png]].\n\nOpen questions are listed in [the API spec](Specs/API.md).\n\n- [ ] Finish the [[Release checklist#^final-review|final review]]\n',
  [STANDUP_PATH]: '---\ntitle: "Standup notes\ntags: [daily]\n---\n# Standup\n\nWaiting for the review %% ask about the deadline\n'
};

const IMAGES_DIRECTORY = join(process.cwd(), 'images', 'screenshots');

beforeAll(async () => {
  /*
   * Written through the vault API rather than pushed with `vault.syncToDevice()`: Obsidian Mobile does not reliably
   * notice a pushed set (bases-auto-row-height, 2026-11-07), while a file the vault itself creates is indexed at once.
   */
  await evalInObsidian({
    async callback({ app, notes }): Promise<void> {
      for (const [path, content] of Object.entries(notes)) {
        const existingFile = app.vault.getFileByPath(path);
        if (existingFile) {
          await app.vault.modify(existingFile, content);
        } else {
          await app.vault.create(path, content);
        }
      }
      // The default dark theme, as on desktop, so the sets read as one series.
      app.changeTheme('obsidian');
      // The note's own H1 is its title; an inline title above it would show the name twice.
      app.vault.setConfig('showInlineTitle', false);
      app.workspace.updateOptions();
      app.workspace.leftSplit.collapse();
      app.workspace.rightSplit.collapse();
    },
    input: { notes: SHOWCASE_NOTES },
    vaultPath: vaultPath()
  });

  await pollInObsidian({
    poll: ({ app }) => (app.plugins.getPlugin('vault-problems') as null | Plugin)?.getProblems().length ?? 0,
    timeoutInMilliseconds: POLL_TIMEOUT_IN_MILLISECONDS,
    timeoutMessage: 'the showcase problems',
    until: (count) => count >= INITIAL_PROBLEM_COUNT,
    vaultPath: vaultPath()
  });
}, TEST_TIMEOUT_IN_MILLISECONDS);

describe('mobile store screenshots', () => {
  it('1 - the Problems view', async () => {
    await openRoadmap();
    await evalInObsidian({
      async callback({ app }): Promise<void> {
        const leaf = app.workspace.getLeavesOfType('vault-problems')[0] ?? app.workspace.getRightLeaf(false);
        if (!leaf) {
          throw new Error('No sidebar leaf.');
        }
        await leaf.setViewState({ active: true, type: 'vault-problems' });
        app.workspace.rightSplit.expand();
        await app.workspace.revealLeaf(leaf);
      },
      vaultPath: vaultPath()
    });
    const rowCount = await pollInObsidian({
      poll: ({ app }) => app.workspace.getLeavesOfType('vault-problems')[0]?.view.containerEl.querySelectorAll('.vault-problems-row').length ?? 0,
      timeoutInMilliseconds: POLL_TIMEOUT_IN_MILLISECONDS,
      timeoutMessage: 'the Problems view rows',
      until: (count) => count > 0,
      vaultPath: vaultPath()
    });
    expect(rowCount).toBeGreaterThan(0);
    await shoot(1, 'Every broken link and syntax problem in one live list');
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('2 - quick fixes on an underlined link', async () => {
    await evalInObsidian({
      callback({ app }): void {
        app.workspace.rightSplit.collapse();
      },
      vaultPath: vaultPath()
    });
    await openRoadmap();
    await waitForUnderlines();
    const labels = await evalInObsidian({
      async callback({ app, lib: { waitUntil }, lineNumber }): Promise<string[]> {
        const editor = app.workspace.activeEditor?.editor;
        if (!editor) {
          throw new Error('No editor.');
        }
        const line = editor.getLine(lineNumber);
        // The cursor is placed without focusing the editor, so the soft keyboard stays down and the note stays visible.
        editor.setCursor({ ch: line.indexOf('#Action items') + 2, line: lineNumber });
        if (!app.commands.executeCommandById('vault-problems:quick-fixes-at-cursor')) {
          throw new Error('The quick fix command did not run at the cursor.');
        }
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
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});

/**
 * Opens the roadmap in the main area in source mode, where the underlines sit on the link text itself.
 */
async function openRoadmap(): Promise<void> {
  await evalInObsidian({
    async callback({ app, path }): Promise<void> {
      const note = app.vault.getFileByPath(path);
      if (!note) {
        throw new Error(`No ${path}.`);
      }
      const leaf = app.workspace.getLeaf(false);
      await leaf.setViewState({ active: true, state: { file: path, mode: 'source', source: true }, type: 'markdown' });
      app.workspace.setActiveLeaf(leaf, { focus: false });
    },
    input: { path: ROADMAP_PATH },
    vaultPath: vaultPath()
  });
}

/**
 * Captures the device screen, captions it and writes it as `images/screenshots/screenshot-mobile-<index>.png`.
 *
 * The capture is the device's own framebuffer, so its size is asserted before captioning: run against any AVD but
 * the 900x1600 one and this fails loudly instead of shipping an off-spec image.
 *
 * @param index - The 1-based listing position.
 * @param caption - The caption burned into the shot.
 */
async function shoot(index: number, caption: string): Promise<void> {
  await sleep(SETTLE_DELAY_IN_MILLISECONDS);
  const captured = await captureObsidianScreenshot({ vaultPath: vaultPath() });
  expect(readPngDimensions(captured)).toStrictEqual({
    heightInPixels: HEIGHT_IN_PIXELS,
    widthInPixels: WIDTH_IN_PIXELS
  });
  const labeled = await labelScreenshot(captured, { text: caption });
  mkdirSync(IMAGES_DIRECTORY, { recursive: true });
  writeFileSync(join(IMAGES_DIRECTORY, `screenshot-mobile-${String(index)}.png`), labeled);
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
