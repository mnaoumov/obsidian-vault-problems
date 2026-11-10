import {
  describe,
  expect,
  it
} from 'vitest';

import { findSyntaxIssues } from './syntax-checks.ts';

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

  it('accepts duplicate keys, which Obsidian tolerates', () => {
    expect(codes('---\na: 1\na: 2\n---\n')).toEqual([]);
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
