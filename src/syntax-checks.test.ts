import {
  describe,
  expect,
  it
} from 'vitest';

import {
  findSyntaxIssues,
  isWarningSyntaxIssue
} from './syntax-checks.ts';

function applyFix(content: string): string {
  const fix = findSyntaxIssues(content)[0]?.fix;
  if (!fix) {
    throw new Error('No fix');
  }
  return content.slice(0, fix.offset) + fix.insert + content.slice(fix.offset);
}

function codes(content: string): string[] {
  return findSyntaxIssues(content).map((issue) => issue.code);
}

describe('findSyntaxIssues', () => {
  it('accepts a clean note', () => {
    expect(findSyntaxIssues('---\ntitle: "A"\ntags:\n  - x\n---\n# Heading\n\nText with `code` and [a](b.md) %%c%%.\n')).toEqual([]);
  });

  it('reports a quoted value that swallowed the keys after it, with the fix that closes it', () => {
    const content = '---\ntitle: "Unclosed\ntags: [a]\nrelated: "[[Note]]"\n---\nBody\n';
    const [issue] = findSyntaxIssues(content);
    expect(issue?.code).toBe('unterminated-quote');
    expect(issue?.position.start).toEqual({ col: 7, line: 1, offset: 11 });
    expect(issue?.message).toContain('swallows 2 property line(s)');
    expect(issue?.fix?.label).toBe('Close the quote at the end of line 2');
    const fixed = applyFix(content);
    expect(fixed).toBe('---\ntitle: "Unclosed"\ntags: [a]\nrelated: "[[Note]]"\n---\nBody\n');
    expect(findSyntaxIssues(fixed)).toEqual([]);
  });

  it('reports a single-quoted list item that swallowed the next item', () => {
    const content = '---\naliases:\n  - \'It\'\'s\n  - Other\n---\n';
    expect(codes(content)).toEqual(['unterminated-quote']);
    expect(applyFix(content)).toBe('---\naliases:\n  - \'It\'\'s\'\n  - Other\n---\n');
  });

  it('accepts a quoted value that legitimately continues on prose lines', () => {
    expect(codes('---\ndescription: "first line\n  continues here"\n---\n')).toEqual([]);
  });

  it('reports a frontmatter parse error at its line', () => {
    const [issue] = findSyntaxIssues('---\ntitle: a\n  bad: indent: here\n---\n');
    expect(issue?.code).toBe('frontmatter-parse-error');
    expect(issue?.position.start.line).toBeGreaterThanOrEqual(1);
    expect(issue?.message).toMatch(/^The frontmatter does not parse/u);
    expect(issue?.fix).toBeNull();
  });

  it('reports a duplicate frontmatter key at its second occurrence, since Obsidian then rejects the frontmatter', () => {
    const issues = findSyntaxIssues('---\na: 1\nb: 2\na: 3\n---\n');
    expect(issues.map((issue) => issue.code)).toEqual(['duplicate-frontmatter-key']);
    expect(issues[0]?.position.start).toEqual({ col: 0, line: 3, offset: 14 });
    expect(issues[0]?.message).toBe('The key "a" appears more than once, so Obsidian rejects the frontmatter and none of its properties apply.');
    expect(issues[0]?.fix).toBeNull();
    expect(issues[0] && isWarningSyntaxIssue(issues[0])).toBe(false);
  });

  it('reports a duplicate key in a nested map, and accepts the same key in sibling maps', () => {
    expect(codes('---\nouter:\n  x: 1\n  x: 2\n---\n')).toEqual(['duplicate-frontmatter-key']);
    expect(codes('---\none:\n  x: 1\ntwo:\n  x: 2\n---\n')).toEqual([]);
  });

  it('leaves the key out of the message when it is not a plain key on its line', () => {
    const [issue] = findSyntaxIssues('---\n? x\n: 1\n? x\n: 2\n---\n');
    expect(issue?.code).toBe('duplicate-frontmatter-key');
    expect(issue?.message).toBe('The key appears more than once, so Obsidian rejects the frontmatter and none of its properties apply.');
  });

  it('reports a later duplicate reference definition as a warning, matching labels case-insensitively', () => {
    const content = '[x][r]\n\n[r]: first.md\n[R]:  second.md\n\n[ r ]: third.md "t"\n';
    const issues = findSyntaxIssues(content);
    expect(issues.map((issue) => [issue.code, issue.position.start.line])).toEqual([
      ['duplicate-reference-definition', 3],
      ['duplicate-reference-definition', 5]
    ]);
    expect(issues[0]?.position.start.offset).toBe(22);
    expect(issues[0]?.position.end.offset).toBe(37);
    expect(issues[0]?.message).toBe('The reference [R] is already defined on line 3, so this definition is ignored and its links use the first one.');
    expect(issues.every((issue) => isWarningSyntaxIssue(issue) && issue.fix === null)).toBe(true);
  });

  it('accepts distinct reference labels and ignores footnotes, code, comments and definitions inside a paragraph', () => {
    expect(codes('[a]: a.md\n[b]: b.md\n')).toEqual([]);
    expect(codes('[^1]: note\n\n[^1]: again\n')).toEqual([]);
    expect(codes('[a]: a.md\n\n```\n[a]: b.md\n```\n\n    [a]: c.md\n')).toEqual([]);
    expect(codes('[a]: a.md\n\n%%\n[a]: b.md\n%%\n')).toEqual([]);
    expect(codes('[a]: a.md\n\ntext\n[a]: b.md\n')).toEqual([]);
    expect(codes('[a]: a.md\n\n[a]:\n')).toEqual([]);
  });

  it('reports a duplicate reference definition after frontmatter with CRLF line endings', () => {
    const issues = findSyntaxIssues('---\r\nk: v\r\n---\r\n[a]: a.md\r\n[A]: b.md\r\n');
    expect(issues.map((issue) => [issue.code, issue.position.start.offset, issue.position.end.offset])).toEqual([['duplicate-reference-definition', 27, 36]]);
  });

  it('ignores a note without closed frontmatter fences', () => {
    expect(codes('---\ntitle: "x\n')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const content = '---\r\ntitle: "x\r\nb: 1\r\n---\r\n';
    expect(codes(content)).toEqual(['unterminated-quote']);
    expect(applyFix(content)).toBe('---\r\ntitle: "x"\r\nb: 1\r\n---\r\n');
  });

  it('reports an unclosed code span and ignores a closed or escaped one', () => {
    const issues = findSyntaxIssues('Use `code here\n\nThen ``a ` b`` and \\` fine\n');
    expect(issues.map((issue) => [issue.code, issue.position.start.offset])).toEqual([['unclosed-code-span', 4]]);
  });

  it('does not let a code span cross a blank line', () => {
    expect(codes('a `b\n\nc` d\n')).toEqual(['unclosed-code-span', 'unclosed-code-span']);
  });

  it('reports an unclosed link destination', () => {
    const issues = findSyntaxIssues('See [a](b.md and more\n\n[ok](c.md "title") ![i](<d e.png>)\n');
    expect(issues.map((issue) => issue.code)).toEqual(['unclosed-link-destination']);
    expect(issues[0]?.position.start.offset).toBe(6);
    expect(issues[0]?.position.end.offset).toBe(21);
  });

  it('accepts balanced parentheses in a destination', () => {
    expect(codes('[a](b_(c).md)\n')).toEqual([]);
    expect(codes('[a](b_(c.md)\n')).toEqual(['unclosed-link-destination']);
  });

  it('reports an unclosed comment opener once', () => {
    const issues = findSyntaxIssues('a %%b%% c\n\n%% open\n\nmore `x\n');
    expect(issues.map((issue) => [issue.code, issue.position.start.line])).toEqual([['unclosed-comment', 2]]);
  });

  it('lets a comment span paragraphs', () => {
    expect(codes('%%\nhidden\n\nstill hidden\n%%\n')).toEqual([]);
  });

  it('ignores everything inside fenced code blocks and code spans', () => {
    expect(codes('```js\nconst a = `x;\n[a](b\n%%\n```\n\n~~~~\n`\n~~~~\n\nUse `%%` and `[a](b`.\n')).toEqual([]);
  });

  it('reports an unclosed code fence at its opener, with the fix that closes it at the end of the note', () => {
    const content = '# Title\n\n  ````js\nconst a = 1;\n```\n[[Hidden link]]\n';
    const issues = findSyntaxIssues(content);
    expect(issues.map((issue) => issue.code)).toEqual(['unclosed-code-fence']);
    expect(issues[0]?.position.start).toEqual({ col: 2, line: 2, offset: 11 });
    expect(issues[0]?.position.end.offset).toBe(17);
    expect(issues[0]?.message).toContain('````');
    expect(issues[0]?.fix?.label).toBe('Close the code block with ```` at the end of the note');
    const fixed = applyFix(content);
    expect(fixed).toBe(`${content}\`\`\`\`\n`);
    expect(findSyntaxIssues(fixed)).toEqual([]);
  });

  it('closes an unclosed tilde fence on a line of its own when the note has no trailing newline', () => {
    const content = 'a\n~~~\ncode';
    expect(applyFix(content)).toBe('a\n~~~\ncode\n~~~');
    expect(findSyntaxIssues(applyFix(content))).toEqual([]);
  });

  it('keeps CRLF line endings when closing an unclosed fence', () => {
    expect(applyFix('```\r\ncode\r\n')).toBe('```\r\ncode\r\n```\r\n');
    expect(applyFix('```\r\ncode')).toBe('```\r\ncode\r\n```');
  });

  it('does not let a shorter or other-character marker close a fence', () => {
    expect(codes('````\n```\n~~~~\n')).toEqual(['unclosed-code-fence']);
    expect(codes('```\n``` js\n')).toEqual(['unclosed-code-fence']);
  });

  it('reports an unclosed fence after frontmatter and ignores one inside an unclosed comment', () => {
    expect(findSyntaxIssues('---\na: 1\n---\n```\nx\n')[0]?.position.start).toEqual({ col: 0, line: 3, offset: 13 });
    expect(codes('%%\n```\nx\n')).toEqual(['unclosed-comment']);
  });

  it('does not take a backtick line with backticks in its info string for a fence', () => {
    expect(codes('``` a ` b\n')).toEqual(['unclosed-code-span', 'unclosed-code-span']);
  });

  it('checks the body after frontmatter with offsets in the whole note', () => {
    const issues = findSyntaxIssues('---\na: 1\n---\nx `y\n');
    expect(issues[0]?.position.start).toEqual({ col: 2, line: 3, offset: 15 });
  });

  it('reports a double-quoted value whose escaped quote does not close it', () => {
    expect(codes('---\ntitle: "a \\" b\nnext: 1\n---\n')).toEqual(['unterminated-quote']);
  });

  it('accepts empty frontmatter', () => {
    expect(codes('---\n---\nBody\n')).toEqual([]);
  });

  it('locates an issue on a last line without a trailing newline', () => {
    expect(findSyntaxIssues('a\nb `c')[0]?.position.start).toEqual({ col: 2, line: 1, offset: 4 });
  });

  it('ends an unclosed link destination range at the end of its line', () => {
    const [issue] = findSyntaxIssues('See [a](b.md\nmore\n');
    expect(issue?.position.end.offset).toBe(12);
  });

  it('reads angle-bracket destinations, whitespace, titles and escapes', () => {
    expect(codes('[a](<b\nc>)\n')).toEqual(['unclosed-link-destination']);
    expect(codes('[a](<b>\n"t")\n')).toEqual([]);
    expect(codes('[a](b\t"t")\n')).toEqual([]);
    expect(codes('[a](  b)\n')).toEqual([]);
    expect(codes('[a](b\n"t")\n')).toEqual([]);
    expect(codes('[a](b\\)c)\n')).toEqual([]);
    expect(codes('[a](b\\)\n')).toEqual(['unclosed-link-destination']);
    expect(codes('no bracket ](x\n')).toEqual([]);
  });
});
