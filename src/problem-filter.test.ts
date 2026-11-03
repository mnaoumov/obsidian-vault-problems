import {
  describe,
  expect,
  it
} from 'vitest';

import type { LinkProblem } from './link-model.ts';

import {
  groupProblems,
  isIgnoredPath
} from './problem-filter.ts';

function problem(path: string, offset: null | number, kind: LinkProblem['row']['kind'] = 'link'): LinkProblem {
  return { cause: null, message: 'Missing', row: { id: path, key: null, kind, link: 'Missing', position: offset === null ? null : { end: { col: offset, line: 0, offset }, start: { col: offset, line: 0, offset } }, sourcePath: path, target: null, targetPath: null }, status: 'standing' };
}

describe('Problems filters', () => {
  it('matches literal names and folders without treating regex syntax as a glob', () => {
    expect(isIgnoredPath('notes/a.md', ['notes'])).toBe(true);
    expect(isIgnoredPath('notes2/a.md', ['notes'])).toBe(false);
    expect(isIgnoredPath('a[1].md', ['a[1].md'])).toBe(true);
    expect(isIgnoredPath('a1.md', ['a[1].md'])).toBe(false);
    expect(isIgnoredPath('file.md', [' ', ''])).toBe(false);
  });

  it('supports zero or more folders, a single segment, question marks and Windows separators', () => {
    for (const path of ['draft.md', 'folder/draft.md', 'a/b/draft.md']) {
      expect(isIgnoredPath(path, ['**/draft.md'])).toBe(true);
    }
    expect(isIgnoredPath('a/b/c.md', ['a/**'])).toBe(true);
    expect(isIgnoredPath('a/b/c.md', ['a/*.md'])).toBe(false);
    expect(isIgnoredPath('a/x.md', [' /a\\?.md/ '])).toBe(true);
    expect(isIgnoredPath('a/xx.md', ['a/?.md'])).toBe(false);
  });

  it('groups by source path, sorts by position, and filters independently', () => {
    const items = [problem('b/x.md', 4), problem('a/x.md', 20), problem('a/x.md', 2), problem('a/x.md', null, 'frontmatter'), problem('ab/x.md', 1)];
    const all = groupProblems(items, { folder: '', ignoredPaths: [], kind: '' });
    expect([...all.keys()]).toEqual(['a/x.md', 'ab/x.md', 'b/x.md']);
    expect(all.get('a/x.md')?.map((item) => item.row.position?.start.offset)).toEqual([undefined, 2, 20]);
    expect([...groupProblems(items, { folder: '/a/', ignoredPaths: [], kind: 'frontmatter' }).values()].flat()).toEqual([items[3]]);
    expect(groupProblems(items, { folder: '', ignoredPaths: ['**/x.md'], kind: '' }).size).toBe(0);
  });
});
