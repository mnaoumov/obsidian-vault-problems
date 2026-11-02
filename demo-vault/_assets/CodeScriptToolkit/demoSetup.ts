import type { App } from 'obsidian';

/** Changes the fixture through the same vault API as a normal note edit. */
export async function setHeading(app: App, heading: string): Promise<void> {
  const file = app.vault.getFileByPath('Materials/01 Live links/Target.md');
  if (!file) {
    throw new Error('The live-link target note is missing.');
  }
  await app.vault.modify(file, `# ${heading}\n\nThis is the heading used by the [source note](./Source.md). The walkthrough changes it and restores it.\n`);
}
