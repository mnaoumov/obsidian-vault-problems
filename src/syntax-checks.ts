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
  | 'duplicate-frontmatter-key'
  | 'duplicate-reference-definition'
  | 'frontmatter-parse-error'
  | 'unclosed-code-fence'
  | 'unclosed-code-span'
  | 'unclosed-comment'
  | 'unclosed-link-destination'
  | 'unterminated-quote';

interface Fence extends Range {
  readonly marker: string;
}

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

interface SegmentsResult {
  readonly segments: readonly Segment[];
  readonly unclosedFence: Fence | null;
}

const COMMENT_MARKER = '%%';
const REFERENCE_DEFINITION_PATTERN = /^ {0,3}\[(?<label>(?:[^\\[\]]|\\.){1,999})\]:/u;
const WARNING_CODES: ReadonlySet<SyntaxIssueCode> = new Set(['duplicate-reference-definition']);
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

/**
Tells whether a syntax issue is a warning: the note still renders, but part of its text is ignored.
*/
export function isWarningSyntaxIssue(issue: SyntaxIssue): boolean {
  return WARNING_CODES.has(issue.code);
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

/**
Reports a fence opener with no closer, which turns the rest of the note into code (CommonMark runs it to the end of the
document), hiding every link and heading after it. The fix appends the matching closer on a line of its own.

The idea comes from `VCoder IDE` (https://github.com/weank1984/obsidian-vcoder-ide, MIT), whose note diagnostics
report unclosed code fences; no code is copied from it.
*/
function createUnclosedFenceIssue(content: string, fence: Fence, locate: (offset: number) => Loc): SyntaxIssue {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = content.endsWith('\n');
  return {
    code: 'unclosed-code-fence',
    fix: {
      insert: hasTrailingNewline ? `${fence.marker}${newline}` : `${newline}${fence.marker}`,
      label: `Close the code block with ${fence.marker} at the end of the note`,
      offset: content.length
    },
    message: `The code block opened with ${fence.marker} is never closed, so the rest of the note is code and its links and headings are ignored.`,
    position: { end: locate(fence.end), start: locate(fence.start) }
  };
}

function findBodyIssues(content: string, lines: readonly Line[], locate: (offset: number) => Loc): SyntaxIssue[] {
  const { segments, unclosedFence } = readSegments(content, lines);
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
  if (unclosedFence && !isInside(unclosedFence.start, comments)) {
    issues.push(createUnclosedFenceIssue(content, unclosedFence, locate));
  }
  issues.push(...findDuplicateReferenceDefinitions(content, segments, comments, locate));
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

/**
Reports a reference definition whose label an earlier definition already took. Labels match case-insensitively with
whitespace collapsed, and the first definition wins, so this one is silently ignored (verified live on 1.15.1). A
definition can only open a paragraph, and definitions can follow one another, so each paragraph is read from its start
until its first line that is not a definition.

The idea comes from `Cairn Vault Linter` (https://github.com/tutivsoft-com/tool-app-Obsidian-Cairn-Vault-Linter, MIT),
which reports duplicate references; no code is copied from it.
*/
function findDuplicateReferenceDefinitions(
  content: string,
  segments: readonly Segment[],
  comments: readonly Range[],
  locate: (offset: number) => Loc
): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  const firstLines = new Map<string, number>();
  for (const segment of segments) {
    let lineStart = segment.start;
    for (const rawLine of content.slice(segment.start, segment.end).split('\n')) {
      const text = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const match = REFERENCE_DEFINITION_PATTERN.exec(text);
      const label = match?.groups?.['label'];
      if (!match || label === undefined || label.startsWith('^') || !label.trim() || !text.slice(match[0].length).trim() || isInside(lineStart, comments)) {
        break;
      }
      const key = label.trim().replaceAll(/\s+/gu, ' ').toUpperCase().toLowerCase();
      const firstLine = firstLines.get(key);
      const position = { end: locate(lineStart + text.length), start: locate(lineStart + text.indexOf('[')) };
      if (firstLine === undefined) {
        firstLines.set(key, position.start.line + 1);
      } else {
        issues.push({
          code: 'duplicate-reference-definition',
          fix: null,
          message: `The reference [${label}] is already defined on line ${String(firstLine)}, so this definition is ignored and its links use the first one.`,
          position
        });
      }
      lineStart += rawLine.length + 1;
    }
  }
  return issues;
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
  // Obsidian parses frontmatter with the same `yaml` package and its default unique keys, so a repeated key rejects the
  // whole block: no property applies and the Properties panel shows "Invalid properties" (verified live on 1.15.1).
  const error = parseDocument(yamlText, { prettyErrors: false }).errors[0];
  if (!error) {
    return [];
  }
  const start = first.start + Math.min(error.pos[0], yamlText.length);
  // Keep the range at least one character wide where the text allows, so the editor can underline it.
  const end = Math.max(first.start + Math.min(error.pos[1], yamlText.length), Math.min(start + 1, last.end));
  if (error.code === 'DUPLICATE_KEY') {
    const key = /^(?<key>[^:\r\n]*?)[ \t]*:/u.exec(content.slice(start, last.end))?.groups?.['key'];
    return [{
      code: 'duplicate-frontmatter-key',
      fix: null,
      message: `The key ${key ? `"${key}" ` : ''}appears more than once, so Obsidian rejects the frontmatter and none of its properties apply.`,
      position: { end: locate(end), start: locate(start) }
    }];
  }
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

function readSegments(content: string, lines: readonly Line[]): SegmentsResult {
  const ranges: Range[] = [];
  let fence: Fence | null = null;
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
      if (marker?.startsWith(fence.marker.charAt(0)) && marker.length >= fence.marker.length && !line.text.slice(line.text.indexOf(marker) + marker.length).trim()) {
        fence = null;
      }
      continue;
    }
    // A backtick fence opener cannot contain a backtick in its info string.
    if (marker && !(marker.startsWith('`') && line.text.slice(line.text.indexOf(marker) + marker.length).includes('`'))) {
      flush();
      fence = { end: line.end, marker, start: line.start + line.text.indexOf(marker) };
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
  return { segments: ranges.map((range) => ({ ...range, ...readCodeSpans(content, range) })), unclosedFence: fence };
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
