import type { App } from 'obsidian';

/** Changes the fixture through the same vault API as a normal note edit. */
export async function setHeading(app: App, heading: string): Promise<void> {
  const file = app.vault.getFileByPath('Materials/01 Live links/Target.md');
  if (!file) {
    throw new Error('The live-link target note is missing.');
  }
  await app.vault.modify(file, `# ${heading}\n\nThis is the heading used by the [source note](./Source.md). The walkthrough changes it and restores it.\n`);
}

/** Writes the syntax-check fixture, with its title quote closed or dropped. */
export async function setTitleQuote(app: App, isClosed: boolean): Promise<void> {
  const file = app.vault.getFileByPath('Materials/04 Syntax checks/Note.md');
  if (!file) {
    throw new Error('The syntax-check note is missing.');
  }
  await app.vault.modify(file, `---\ntitle: "A title${isClosed ? '"' : ''}\ntags:\n  - demo\n---\n# Note\n\nThis note supplies the frontmatter used by the [syntax-check walkthrough](<../../04 Syntax checks.md>).\n`);
}