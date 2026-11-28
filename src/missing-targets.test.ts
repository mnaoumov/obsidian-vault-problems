import { App } from 'obsidian-test-mocks/obsidian';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { LinkProblem } from './link-model.ts';

import {
  decodeLink,
  getMissingFilePath,
  getMissingPath,
  MissingTargetClassifier
} from './missing-targets.ts';

function problem(link: string, overrides: Partial<LinkProblem['row']> = {}, extra: Partial<LinkProblem> = {}): LinkProblem {
  return {
    cause: null,
    message: `Cannot resolve ${link}`,
    row: { id: link, key: null, kind: 'link', link, position: null, sourcePath: 'Folder/Source.md', target: null, targetPath: null, ...overrides },
    status: 'standing',
    ...extra
  };
}

describe('missing link targets', () => {
  it('resolves the vault path a link names, relative or not, adding .md to a name with no extension', () => {
    expect(getMissingPath(problem('Note').row)).toBe('Note.md');
    expect(getMissingPath(problem('./Sub/Image.png').row)).toBe('Folder/Sub/Image.png');
    expect(getMissingPath(problem('../Other%20Note#Heading').row)).toBe('Other Note.md');
    expect(getMissingPath(problem('../../Out').row)).toBeNull();
    expect(getMissingPath(problem('#Heading').row)).toBeNull();
    expect(getMissingPath(problem('a:b').row)).toBeNull();
    expect(decodeLink('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('takes only links to a missing file, not missing headings, findings or misplaced attachments', () => {
    expect(getMissingFilePath(problem('Note'))).toBe('Note.md');
    expect(getMissingFilePath(problem('Note#Gone', { targetPath: 'Note.md' }))).toBeNull();
    expect(getMissingFilePath(problem('Note', { kind: 'syntax' }))).toBeNull();
    expect(getMissingFilePath(problem('Note', {}, { misplacedAttachment: { attachmentPath: 'a.png', properAttachmentFolderPath: '/' } }))).toBeNull();
  });

  it('tells a near miss from a planned note, and keeps its answers until the vault changes', async () => {
    const app = App.createConfigured__().asOriginalType__();
    await app.vault.create('Meeting notes.md', '');
    const classifier = new MissingTargetClassifier(app);
    const typo = problem('Meeting nots');
    const planned = problem('Someday project');
    const heading = problem('Meeting notes#Gone', { targetPath: 'Meeting notes.md' });
    const classes = classifier.classify([typo, planned, heading, problem('Meeting nots', { id: 'second' })]);
    expect(classes.get(typo)).toBe('near-miss');
    expect(classes.get(planned)).toBe('planned');
    expect(classes.has(heading)).toBe(false);
    expect(classes.size).toBe(3);

    const getFiles = vi.spyOn(app.vault, 'getFiles');
    classifier.classify([typo, planned]);
    expect(getFiles).not.toHaveBeenCalled();

    await app.vault.create('Someday projects.md', '');
    expect(classifier.classify([planned]).get(planned)).toBe('planned');
    classifier.invalidate();
    expect(classifier.classify([planned]).get(planned)).toBe('near-miss');
  });

  it('forgets its answers when a note gains or loses aliases or a title, and only then', async () => {
    const app = App.createConfigured__().asOriginalType__();
    const note = await app.vault.create('Project.md', '---\ntitle: Alpha\n---\n');
    const classifier = new MissingTargetClassifier(app);
    const planned = problem('Roadmap');
    expect(classifier.classify([planned]).get(planned)).toBe('planned');
    const getFiles = vi.spyOn(app.vault, 'getFiles');

    classifier.onMetadataChanged(note.path, { title: 'Alpha' });
    classifier.onMetadataChanged('Other.md', undefined);
    classifier.classify([planned]);
    expect(getFiles).not.toHaveBeenCalled();

    vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue({ frontmatter: { aliases: ['Roadmap'], title: 'Alpha' } });
    classifier.onMetadataChanged(note.path, { aliases: ['Roadmap'], title: 'Alpha' });
    expect(classifier.classify([planned]).get(planned)).toBe('near-miss');

    vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue({});
    classifier.onMetadataChanged(note.path, undefined);
    expect(classifier.classify([planned]).get(planned)).toBe('planned');
  });
});
