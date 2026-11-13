# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## Filing an issue (for AI agents and humans)

Open issues through the [issue forms](https://github.com/mnaoumov/obsidian-vault-problems/issues/new/choose), not as blank issues.

Filing from the CLI or the API (`gh issue create --body`, or an AI agent filing for you) skips the form, and `gh issue create --template` cannot load an issue form. In that case, open the matching form in [`.github/ISSUE_TEMPLATE/`](https://github.com/mnaoumov/obsidian-vault-problems/tree/HEAD/.github/ISSUE_TEMPLATE), copy every field as a `### <label>` heading in the form's order, and fill in each one. Always state the plugin version, the Obsidian version and your operating system.

## Overview

`Vault Problems` is live analysis for a vault, in the way an IDE analyses code while it is typed. Today a broken link is found when somebody runs a vault check, often weeks after the edit that broke it, when nobody remembers the edit. This plugin finds it at the moment it breaks:

1. It keeps every link as an entity with two ends: the source position in a note and the target (a note, a heading, a block, an attachment).
2. After every change it compares the links before and after. A change that breaks either end is caught at once:
   1. When exactly one repair exists, it is applied at once, as a refactoring, and can be undone as one step.
   2. Otherwise the problem is reported at once, with the change that caused it.
3. A **Problems** view lists every current problem in the vault, grouped by note, with in-place quick fixes, like the problems panel of an IDE.
4. The editor underlines a problem where it is, with the same quick fixes on the underline.

A second family of checks covers syntax that silently changes meaning: frontmatter that does not parse as YAML, a quoted value that swallowed the lines after it, an unclosed link destination or code span, a stray comment opener.

### Prior art

Searched on 2026-11-01: the community registry (9801 plugins) for the vocabulary of broken, dangling, orphaned and unresolved links, link checks, link repair, vault health, lint, diagnostics, problems, validation and refactoring, plus each candidate's README.

1. **Reporters** list broken links on demand or on a refresh timer, in a side panel or a dashboard: `Link Doctor` (`link-doctor`; notes, headings, blocks, embeds; no fixes by design), `Link Integrity` (`link-integrity`; continuous refresh, no edits), `Vault Inspector` (`vault-inspector`; a scan with severity levels and link removal), `Vault Plus` (`vault-plus`; a health dashboard with one-click fixes), `Dangling links` (`obsidian-dangling-links`), `Broken Links` (`broken-links`), `Vault Link Check` (`vault-link-check`; near-miss names), `Cairn Vault Linter` (`cairn-vault-linter`).
2. **Repairers of one move:** `Persistent Links` (`persistent-links`) rewrites heading and block links when a heading or block is cut and pasted to another note, for wikilinks only, and has had no commit since 2023.
3. **In-editor diagnostics** exist for other rule sets: `Markdownlint` (`markdownlint`) and `rumdl` (`rumdl`) for markdown style, `Structured Context` (`structured-context`) and `Note Schemas` (`note-schemas`) for frontmatter against a schema.
4. `Consistent Attachments and Links` already has a batch consistency check and a broken-links view whose fixes come from the vault's `git` renames, aliases and titles.

**What this plugin does that none of them does:** it ties a problem to the change that caused it, at the moment of the change, repairs it when the repair is unambiguous, and keeps one live list of link and syntax problems with quick fixes, both in a view and as underlines in the editor. Every reporter above answers "what is broken now?"; none answers "what did I just break?".

## Current state

The repo was generated on 2026-11-01 with `create-obsidian-plugin` (preset `all-in-one`, desktop and mobile, the unofficial API subset, CodeMirror editor extensions). Its answers are in `.create-obsidian-plugin.json`.

The link engine is implemented in `src/link-engine.ts`, with its shared model in `src/link-model.ts` and lifecycle subscriptions in `src/link-engine-component.ts`. `Plugin.linkEngine` exposes rows and problems per note and an `onChanged` subscription. Startup takes one snapshot; later changes use core backlinks plus reverse indexes retained by the engine. New breaks keep their cause until repaired and produce a plugin-owned notice. File renames and deletions are compared after the metadata resolver settles. `runInBatch` and `updateMany` compare a batch once. `src/rename-handler-batch-component.ts` subscribes to `Advanced Rename and Delete Handler`'s bulk-operation notifications (contract `^1.4.0`, through `watchPluginApi`, reconnecting when the provider changes) and holds an engine batch (`beginBatch`) from each `moveMany` or `runInBatch` start to its end, failures included; a replayed start leaves a partial snapshot, and a batch left open when the provider unloads is closed. The provider's `api.d.ts` and `api-contract.ts` are copied unchanged from its `3.5.1` release into `src/advanced-rename-and-delete-handler/`.

Automatic repairs are implemented in `src/auto-repair-component.ts`, with transaction evidence in `src/auto-repair.ts`. A CodeMirror update listener recognizes isolated ATX or setext heading edits and correlates one cut with an identical paste into another note, retaining that evidence while the destination editor loads. Metadata must confirm that the original endpoint disappeared and exactly one replacement exists at the expected position. Backlinks come from the link engine's retained reverse index; the shared library edits wikilinks, Markdown links, embeds and frontmatter. Reference-style definitions are rewritten in the same pass through the shared library's `referenceDefinitionConverter`, which validates each definition against its metadata range and changes only the destination, preserving labels, titles, angle brackets and use sites. References already updated by another handler are left alone. A file rename or delete invalidates the pending editor evidence it touches (the cut or edited note, the paste destination, a backlink source, or a folder holding one of them), and leaves evidence for other notes alone; programmatic and external edits remain reported by the engine.

Each repair has one plugin-owned notice naming the endpoint changes and an Undo button. Endpoints from one operation share a metadata snapshot, including different fragment spellings for the same heading. A journal groups all rewritten notes; shared editor locks, dirty-buffer saves, compare-and-swap writes and rollback protect concurrent edits. Undo refuses to overwrite a note edited after the repair. The searchable **Automatically repair links** setting is enabled by default and persisted in plugin data.

The Problems side view is implemented in `src/problems-view.ts`, opened from the ribbon or **Open problems** command. It subscribes to the link engine, groups problems by note and source position, shows severity and cause, and opens the selected range. Each group is a collapsible header with its count (`aria-expanded`); a group of more than `PROBLEMS_COLLAPSE_THRESHOLD` (10) starts collapsed, Expand all / Collapse all override that, and a group's own toggle is kept across live re-renders. A Group by select switches to one group per row kind (`groupProblems(..., 'kind')`, headings from `PROBLEM_KIND_LABELS`), where each row names its note. Rendering is paged rather than windowed: `PROBLEMS_PAGE_SIZE` (100) groups and 100 rows per group, each with a Show more button, so one render's DOM is bounded whatever the vault holds. Parity with the `Consistent Attachments and Links` consistency report lacks path-compatibility and misplaced-attachment problems; both checks are to move into `obsidian-lib` first. Frontmatter links have a property key rather than a metadata range, so navigation opens the start of that note. Kind and folder filters combine with the persisted **Ignore paths in Problems** setting, supporting literal paths/folders and `*`, `**`, `?` globs. Filtering hides panel rows without suppressing engine evidence or automatic repairs.

`src/problem-fixes.ts` provides explicit candidate selection, note/heading creation, paragraph selection for restoring a block id, unlinking while keeping the caption, and grouped updates to a renamed endpoint. Candidate evidence comes from `obsidian-lib`'s shared finder (`git` renames on desktop, causal renames, aliases, titles, case changes and same-name paths). Git is loaded only when the user asks for fixes. Body, frontmatter and reference definitions can be repaired together, preserving reference labels and titles. Fixes reuse the repair journal and its concurrency checks and undo. Reference unlinking uses a Markdown AST; it conservatively refuses notes containing `%%` rather than modifying hidden text. Creating a note never fabricates an attachment and undo refuses to trash an edited note.

Editor diagnostics are implemented in `src/editor-problems.ts`. Each editor projects the link engine's ranges, subscribes to affected-note changes and unsubscribes on destruction. Edits clear stale marks until the next snapshot. Hover tooltips and the **Quick fixes at cursor** command reuse `ProblemFixes`; frontmatter without source ranges stays in the panel. Panel filters do not suppress editor evidence.

Syntax checks are implemented in `src/syntax-checks.ts` (a pure text checker) and `src/syntax-check-component.ts`, which reads every note once at layout ready and then checks the text each metadata `changed` event carries. The engine keeps them beside its link problems (`setSyntaxIssues`) as rows of the `syntax` kind with a `syntax` detail, follows renames and deletions, and publishes them through `onChanged` without a notice. A quoted frontmatter value left open is reported in place of the YAML parse error it causes, because it carries the fix; its quick fix re-runs the check at click time and inserts the quote through the repair journal, so it has Undo. Frontmatter is parsed with the `yaml` package with duplicate keys allowed, as Obsidian allows them. The Markdown checks skip fenced code blocks and code spans, let `%%` comments span paragraphs, and confine code spans and link destinations to their paragraph; indented code blocks are not detected. HTML checks are implemented in `src/html-check-component.ts`, which watches `Advanced Metadata Cache`'s plugin API (`advanced-metadata-cache`, contract `^1.15.0`; the consumed subset is declared in `src/advanced-metadata-cache.ts`, not copied) and asks `getHtmlDiagnosticsSafe` once per note at layout ready, then once per metadata `changed`, re-asking with back-off (250 ms doubling, 5 retries) while the provider answers `null` for a pending edit. The engine keeps them as rows of the `html` kind with an `html` detail (`setHtmlDiagnostics`), beside the syntax problems, follows renames and deletions, and drops them all (`clearHtmlDiagnostics`) when the provider goes away. Nothing here scans or sanitizes HTML. The component's `statusMessage` is shown in the Problems view while the provider is missing, its HTML module is off (every answer `null`) or the first scan runs, so an unchecked vault never reads as clean. HTML problems are `Warning` rows with no quick fix, by design: the candidates are lexical. The sample commands and suggest have been removed. The demo vault demonstrates heading edits, automatic repair, the Problems view, syntax checks and HTML problems. Unit tests run with `npm run test:coverage`; live tests are `src/html-problems.desktop.integration.test.ts` (the released `Advanced Metadata Cache`, pinned there, installed and removed inside the test), `src/link-engine.cross-platform.integration.test.ts`, `src/auto-repair.cross-platform.integration.test.ts`, `src/auto-repair-move.desktop.integration.test.ts`, `src/auto-repair-move.android.integration.test.ts` (a trusted Ctrl+X and Ctrl+V through the WebView's own Cut and Paste commands, which produce the same `delete.cut` and `input.paste` transactions as desktop; run it with one worker, and never beside another Android suite, since they share one emulator), `src/problems.cross-platform.integration.test.ts`, `src/editor-problems.cross-platform.integration.test.ts` and `src/editor-problems.desktop.integration.test.ts`. `src/rename-handler-batch.rename-handler.integration.test.ts` runs in its own project, `npm run test:integration:rename-handler`, whose vault also has the released provider (pinned in `scripts/helpers/advanced-rename-and-delete-handler-seed.ts`, downloaded once through `obsidian-dev-toolkit`'s released-plugin helper into `node_modules/.cache/`). Run these with the matching `Vitest` integration project and one worker when sharing a bulk processor budget. `npm run capture:screenshots` runs `src/screenshots.desktop-capture.integration.test.ts` in its own `capture-screenshots:desktop` project, which no other script collects: it builds a small showcase vault in a real desktop Obsidian and rewrites the four README and listing shots in `images/screenshots/`, then runs `src/screenshots.android-capture.integration.test.ts` in the `capture-screenshots:android` project, which writes `screenshot-mobile-1.png` (the Problems view drawer) and `-2.png` (the quick-fix menu on an underlined link) on the 900x1600 `obsidian_screenshots` AVD. The Android leg boots the emulator, so run it only while holding the machine's emulator lock, and keep that AVD's Obsidian at or above `minAppVersion` with `provision-obsidian-avd.ps1 -AvdName obsidian_screenshots`. The README `## See also` table supersedes the prior-art list below as the maintained comparison.

## Design

### Engine: a link snapshot, diffed per change

1. The link table is built from the metadata cache: `links`, `embeds`, `frontmatterLinks` and `referenceLinks` (reference-style links) for every note, each with its resolved target (file, heading, block) or none.
2. On every `changed`, `rename`, `delete` and `resolved` event, the engine recomputes only the rows the event can touch: the changed note's own links, and the links whose target is the changed note (through the backlink index). The vault-wide scan runs once, at layout ready.
3. A row that resolved before the event and does not after it is a **new break**, attributed to that event. A row that never resolved is a **standing problem**. The view shows both; only a new break raises a notice.
4. A batch of operations from `Advanced Rename and Delete Handler` (its `runInBatch` API) is one change: the diff runs once, at the end of the batch, so a folder move is one report, not hundreds.
5. Backlinks come from the core API, which `Advanced Metadata Cache` speeds up when it is installed. Its unresolved-backlinks lookup, once it ships, answers "which links point at a name that does not exist" without a scan.

### What is repaired and what is only reported

The plugin never re-does what the rename and delete handlers already do. A note or attachment rename, move or delete is handled by `Advanced Rename and Delete Handler` or by the core "Automatically update internal links" setting. When one of them is on and does its job, nothing breaks, and this plugin sees nothing to fix. When neither is on, the break is reported with the one-click fix "Update the N links to the new path".

Auto-repaired at once, because there is exactly one candidate:

1. A heading edited in place: one heading disappears and one appears at the same position in the same note. Links to `Note#Old` become `Note#New`.
2. A heading or block cut from one note and pasted into another in the same editor transaction. Links follow it to the new note.

Reported only, each with the quick fixes that apply:

1. A link to a note, heading, block or attachment that does not exist: pick a candidate (`git` rename, alias, title, near-miss name), create the target, or remove the link and keep its text.
2. A block id removed from a note while links still point at it: restore the id, or remove the links.
3. A frontmatter link that resolves to nothing.

Every auto-repair shows a notice naming what it changed, with an **Undo** button that restores every file it touched, as one step. A setting turns auto-repair off, leaving every case reported only.

### Syntax checks

1. **Frontmatter:** the block between the `---` fences is parsed with a YAML parser that keeps positions. A parse error is reported at its line. A value that parses but holds a newline followed by a `key:` line or a list item line is reported as a probable unterminated quote, with the quick fix "close the quote at the end of the line".
2. **Markdown:** an unclosed link destination, an unclosed code span, and a `%%` comment opener with no closer, each reported at its position. These checks read the text, not the rendered view, so they work in every mode.

### Problems view

A side view listing every problem, grouped by note and sorted by position: severity, the message, the change that caused it when known, and its quick fixes. Clicking a row opens the note with the range selected. Filters by kind and by folder; an ignore list of paths and globs in the settings.

### In the editor

A CodeMirror extension underlines each problem of the open note and offers its quick fixes on hover and through a command at the cursor. It reads the engine's results for the note and never runs a check of its own.

### Shared code

The pure candidate finder for a missing file target lives in `@mnaoumov/obsidian-lib/broken-link-candidates`. Both this plugin and `Consistent Attachments and Links` import it, so there is one copy. Its current evidence kinds are `git` renames, aliases, titles, case changes, renamed folders and matching file names.
