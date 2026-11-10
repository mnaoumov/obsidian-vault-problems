import type {
  Loc,
  Pos
} from 'obsidian';

import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { parseDocument } from 'yaml';

/**
An insertion that repairs a syntax issue, applied to the text the issue was found in.
*/
export interface SyntaxFix {
  readonly insert: string;
  readonly label: string;
  readonly offset: number;
}

/**
A place where the text silently means something other than it appears to.
*/
export interface SyntaxIssue {
  readonly code: SyntaxIssueCode;
  readonly fix: null | SyntaxFix;
  readonly message: string;
  readonly position: Pos;
}

/**
The kinds of syntax issues the checks report.
*/
export type SyntaxIssueCode =
  | 'frontmatter-parse-error'
  | 'unclosed-code-span'
  | 'unclosed-comment'
  | 'unclosed-link-destination'
  | 'unterminated-quote';

interface Line {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

interface Range {
  readonly end: number;
  readonly start: number;
}

interface Segment extends Range {
  readonly codeSpans: readonly Range[];
  readonly unclosedCodeSpans: readonly Range[];
}

const COMMENT_MARKER = '%%';
const ESCAPED_END_PATTERN = /(?:^|[^\\])\\(?:\\\\)*$/u;
const FENCE_PATTERN = /^ {0,3}(?<marker>`{3,}|~{3,})/u;
const KEY_LINE_PATTERN = /^[ \t]*[^\s#"'-][^#]*?:(?:[ \t]|$)/u;
const LIST_LINE_PATTERN = /^[ \t]*-[ \t]+\S/u;
const QUOTE_OPENER_PATTERN = /^(?<prefix>[ \t]*(?:-[ \t]+)*(?:[^\s#"'-][^#]*?:[ \t]+)?)(?<quote>["'])/u;

/**
Checks the frontmatter and the Markdown body of one note, in source order.
*/
export function findSyntaxIssues(content: string): SyntaxIssue[] {
  const lines = splitLines(content);
  const locate = createLocator(lines);
  const issues: SyntaxIssue[] = [];
  const closeLine = findFrontmatterCloseLine(lines);
  if (closeLine !== null) {
    issues.push(...findFrontmatterIssues(content, lines.slice(1, closeLine), locate));
  }
  issues.push(...findBodyIssues(content, lines.slice(closeLine === null ? 0 : closeLine + 1), locate));
  return issues.sort((left, right) => left.position.start.offset - right.position.start.offset);
}

function createLocator(lines: readonly Line[]): (offset: number) => Loc {
  return (offset: number): Loc => {
    let line = 0;
    while ((lines[line + 1]?.start ?? Infinity) <= offset) {
      line++;
    }
    return { col: offset - ensureNonNullable(lines[line]).start, line, offset };
  };
}

function findBodyIssues(content: string, lines: readonly Line[], locate: (offset: number) => Loc): SyntaxIssue[] {
  const segments = readSegments(content, lines);
  const issues: SyntaxIssue[] = [];
  const comments: Range[] = [];
  let openComment: null | number = null;
  for (const segment of segments) {
    const text = content.slice(segment.start, segment.end);
    for (const match of text.matchAll(/%%/gu)) {
      const offset = segment.start + match.index;
      if (isInside(offset, segment.codeSpans)) {
        continue;
      }
      if (openComment === null) {
        openComment = offset;
      } else {
        comments.push({ end: offset + COMMENT_MARKER.length, start: openComment });
        openComment = null;
      }
    }
  }
  if (openComment !== null) {
    comments.push({ end: content.length, start: openComment });
    issues.push({
      code: 'unclosed-comment',
      fix: null,
      message: 'The comment opened with %% is never closed, so everything after it is hidden.',
      position: { end: locate(openComment + COMMENT_MARKER.length), start: locate(openComment) }
    });
  }
  for (const segment of segments) {
    for (const span of segment.unclosedCodeSpans) {
      if (isInside(span.start, comments)) {
        continue;
      }
      issues.push({
        code: 'unclosed-code-span',
        fix: null,
        message: 'The code span opened here has no closing backticks in its paragraph, so the backticks show literally.',
        position: { end: locate(span.end), start: locate(span.start) }
      });
    }
    const text = content.slice(segment.start, segment.end);
    for (const match of text.matchAll(/\]\(/gu)) {
      const offset = segment.start + match.index;
      if (
        isInside(offset, segment.codeSpans) || isInside(offset, comments) || !text.slice(0, match.index).includes('[')
        || isLinkDestinationClosed(text, match.index + match[0].length)
      ) {
        continue;
      }
      const lineEnd = text.indexOf('\n', match.index);
      issues.push({
        code: 'unclosed-link-destination',
        fix: null,
        message: 'The link destination is never closed with ), so the link shows as plain text.',
        position: { end: locate(lineEnd === -1 ? segment.end : segment.start + lineEnd), start: locate(offset) }
      });
    }
  }
  return issues;
}

function findClosingQuote(text: string, from: number, quote: string): number {
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (quote === '"' && char === '\\') {
      index++;
      continue;
    }
    if (char !== quote) {
      continue;
    }
    if (quote === '\'' && text[index + 1] === '\'') {
      index++;
      continue;
    }
    return index;
  }
  return -1;
}

function findFrontmatterCloseLine(lines: readonly Line[]): null | number {
  if (lines[0]?.text.trimEnd() !== '---') {
    return null;
  }
  const index = lines.findIndex((line, lineIndex) => lineIndex > 0 && line.text.trimEnd() === '---');
  return index === -1 ? null : index;
}

function findFrontmatterIssues(content: string, lines: readonly Line[], locate: (offset: number) => Loc): SyntaxIssue[] {
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) {
    return [];
  }
  const quoteIssues = findUnterminatedQuotes(lines, locate);
  // An unterminated quote is the cause of the parse error that usually follows it, and carries the fix.
  if (quoteIssues.length > 0) {
    return quoteIssues;
  }
  const yamlText = content.slice(first.start, last.end);
  const error = parseDocument(yamlText, { prettyErrors: false, uniqueKeys: false }).errors[0];
  if (!error) {
    return [];
  }
  const start = first.start + Math.min(error.pos[0], yamlText.length);
  // Keep the range at least one character wide where the text allows, so the editor can underline it.
  const end = Math.max(first.start + Math.min(error.pos[1], yamlText.length), Math.min(start + 1, last.end));
  return [{
    code: 'frontmatter-parse-error',
    fix: null,
    message: `The frontmatter does not parse, so none of its properties apply: ${error.message.split('\n', 1).join('')}`,
    position: { end: locate(end), start: locate(start) }
  }];
}

function findUnterminatedQuotes(lines: readonly Line[], locate: (offset: number) => Loc): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const groups = line && QUOTE_OPENER_PATTERN.exec(line.text)?.groups;
    const prefix = groups?.['prefix'];
    const quote = groups?.['quote'];
    if (!line || prefix === undefined || quote === undefined || !prefix.trim() || findClosingQuote(line.text, prefix.length + 1, quote) !== -1) {
      continue;
    }
    let swallowed = 0;
    let next = index + 1;
    for (; next < lines.length; next++) {
      const text = ensureNonNullable(lines[next]).text;
      if (KEY_LINE_PATTERN.test(text) || LIST_LINE_PATTERN.test(text)) {
        swallowed++;
      }
      if (findClosingQuote(text, 0, quote) !== -1) {
        break;
      }
    }
    if (swallowed > 0) {
      const lineNumber = locate(line.start).line + 1;
      issues.push({
        code: 'unterminated-quote',
        fix: { insert: quote, label: `Close the quote at the end of line ${String(lineNumber)}`, offset: line.start + line.text.trimEnd().length },
        message: `The quoted value is not closed on its line, so it swallows ${String(swallowed)} property line(s) after it.`,
        position: { end: locate(line.end), start: locate(line.start + prefix.length) }
      });
    }
    index = next;
  }
  return issues;
}

function isInside(offset: number, ranges: readonly Range[]): boolean {
  return ranges.some((range) => range.start <= offset && offset < range.end);
}

function isLinkDestinationClosed(text: string, from: number): boolean {
  let index = from;
  while (text[index] === ' ' || text[index] === '\t') {
    index++;
  }
  if (text[index] === '<') {
    const close = text.indexOf('>', index);
    const lineEnd = text.indexOf('\n', index);
    return close !== -1 && (lineEnd === -1 || close < lineEnd) && text.includes(')', close);
  }
  let depth = 0;
  for (; index < text.length; index++) {
    switch (text[index]) {
      case '\t':
      case '\n':
      case ' ': {
        // A title may follow the destination; it still needs the closing parenthesis.
        return text.includes(')', index);
      }
      case '(': {
        depth++;
        break;
      }
      case ')': {
        if (depth === 0) {
          return true;
        }
        depth--;
        break;
      }
      case '\\': {
        index++;
        break;
      }
      default: {
        break;
      }
    }
  }
  return false;
}

function readCodeSpans(content: string, segment: Range): Pick<Segment, 'codeSpans' | 'unclosedCodeSpans'> {
  const text = content.slice(segment.start, segment.end);
  const runs: Range[] = [];
  for (const match of text.matchAll(/`+/gu)) {
    // A backtick after an odd run of backslashes is escaped: it is literal and cannot open a code span.
    const start = match.index + (ESCAPED_END_PATTERN.test(text.slice(0, match.index)) ? 1 : 0);
    if (start < match.index + match[0].length) {
      runs.push({ end: segment.start + match.index + match[0].length, start: segment.start + start });
    }
  }
  const codeSpans: Range[] = [];
  const unclosedCodeSpans: Range[] = [];
  for (let index = 0; index < runs.length; index++) {
    const run = ensureNonNullable(runs[index]);
    const length = run.end - run.start;
    const closeIndex = runs.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.end - candidate.start === length);
    const close = runs[closeIndex];
    if (close) {
      codeSpans.push({ end: close.end, start: run.start });
      index = closeIndex;
    } else {
      unclosedCodeSpans.push(run);
    }
  }
  return { codeSpans, unclosedCodeSpans };
}

function readSegments(content: string, lines: readonly Line[]): Segment[] {
  const ranges: Range[] = [];
  let fence: null | string = null;
  let start = -1;
  let end = -1;
  function flush(): void {
    if (start !== -1) {
      ranges.push({ end, start });
    }
    start = -1;
  }
  for (const line of lines) {
    const marker = FENCE_PATTERN.exec(line.text)?.groups?.['marker'];
    if (fence !== null) {
      if (marker?.startsWith(fence.charAt(0)) && marker.length >= fence.length && !line.text.slice(line.text.indexOf(marker) + marker.length).trim()) {
        fence = null;
      }
      continue;
    }
    // A backtick fence opener cannot contain a backtick in its info string.
    if (marker && !(marker.startsWith('`') && line.text.slice(line.text.indexOf(marker) + marker.length).includes('`'))) {
      flush();
      fence = marker;
      continue;
    }
    if (!line.text.trim()) {
      flush();
      continue;
    }
    if (start === -1) {
      start = line.start;
    }
    end = line.end;
  }
  flush();
  return ranges.map((range) => ({ ...range, ...readCodeSpans(content, range) }));
}

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const segment of content.split('\n')) {
    const text = segment.endsWith('\r') ? segment.slice(0, -1) : segment;
    lines.push({ end: start + text.length, start, text });
    start += segment.length + 1;
  }
  return lines;
}
