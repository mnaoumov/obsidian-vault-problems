import type { App } from 'obsidian';

const PATH_CHECKS_FOLDER = 'Materials/06 Path and attachment checks';
const INCOMPATIBLE_NAME_PATH = `${PATH_CHECKS_FOLDER}/Draft #1.md`;
const ATTACHMENT_NAME = 'Diagram.svg';
const ATTACHMENT_NOTE_PATH = `${PATH_CHECKS_FOLDER}/Note.md`;
const DIAGRAM_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#7c5cff"/></svg>\n';

/**
 * Creates a note whose name holds `#`, a character Obsidian links cannot carry, so every platform check reports it.
 */
export async function createIncompatibleName(app: App): Promise<void> {
  if (!app.vault.getAbstractFileByPath(INCOMPATIBLE_NAME_PATH)) {
    await app.vault.create(INCOMPATIBLE_NAME_PATH, '# Draft #1\n\nThe `#` in this note\'s name stops a link from reaching it.\n');
  }
}

/**
 * Puts an image beside the fixture note and embeds it there, outside the vault's attachment folder.
 */
export async function createMisplacedAttachment(app: App): Promise<void> {
  const attachmentPath = `${PATH_CHECKS_FOLDER}/${ATTACHMENT_NAME}`;
  if (!app.vault.getAbstractFileByPath(attachmentPath)) {
    await app.vault.create(attachmentPath, DIAGRAM_SVG);
  }
  await writeAttachmentNote(app, `![[${attachmentPath}]]\n`);
}

/**
 * Removes the note `createIncompatibleName` made, under its original name or the name its quick fix gave it.
 */
export async function removeIncompatibleName(app: App): Promise<void> {
  for (const path of [INCOMPATIBLE_NAME_PATH, `${PATH_CHECKS_FOLDER}/Draft -1.md`]) {
    const file = app.vault.getAbstractFileByPath(path);
    if (file) {
      await app.fileManager.trashFile(file);
    }
  }
}

/**
 * Removes the image `createMisplacedAttachment` made, from beside the note or from the attachment folder, and its embed.
 */
export async function removeMisplacedAttachment(app: App): Promise<void> {
  await writeAttachmentNote(app, '');
  const attachmentFolder = String(app.vault.getConfig('attachmentFolderPath'));
  for (const path of [`${PATH_CHECKS_FOLDER}/${ATTACHMENT_NAME}`, `${attachmentFolder}/${ATTACHMENT_NAME}`]) {
    const file = app.vault.getAbstractFileByPath(path);
    if (file) {
      await app.fileManager.trashFile(file);
    }
  }
}

/**
 * Changes the fixture through the same vault API as a normal note edit.
 */
export async function setHeading(app: App, heading: string): Promise<void> {
  const file = app.vault.getFileByPath('Materials/01 Live links/Target.md');
  if (!file) {
    throw new Error('The live-link target note is missing.');
  }
  await app.vault.modify(file, `# ${heading}\n\nThis is the heading used by the [source note](./Source.md). The walkthrough changes it and restores it.\n`);
}

/**
 * Writes the syntax-check fixture, with its title quote closed or dropped.
 */
export async function setTitleQuote(app: App, isClosed: boolean): Promise<void> {
  const file = app.vault.getFileByPath('Materials/04 Syntax checks/Note.md');
  if (!file) {
    throw new Error('The syntax-check note is missing.');
  }
  await app.vault.modify(file, `---\ntitle: "A title${isClosed ? '"' : ''}\ntags:\n  - demo\n---\n# Note\n\nThis note supplies the frontmatter used by the [syntax-check walkthrough](<../../04 Syntax checks.md>).\n`);
}

async function writeAttachmentNote(app: App, embed: string): Promise<void> {
  const file = app.vault.getFileByPath(ATTACHMENT_NOTE_PATH);
  if (!file) {
    throw new Error('The attachment-check note is missing.');
  }
  await app.vault.modify(file, `# Note\n\nThis note embeds the image used by the [path and attachment walkthrough](<../../06 Path and attachment checks.md>).\n${embed === '' ? '' : `\n${embed}`}`);
}