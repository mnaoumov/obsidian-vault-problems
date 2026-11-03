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
4. `Consistent Attachments and Links` already has a batch consistency check and a broken-links view whose fixes come from the vault's git renames, aliases and titles.

**What this plugin does that none of them does:** it ties a problem to the change that caused it, at the moment of the change, repairs it when the repair is unambiguous, and keeps one live list of link and syntax problems with quick fixes, both in a view and as underlines in the editor. Every reporter above answers "what is broken now?"; none answers "what did I just break?".

## Current state

The repo was generated on 2026-11-01 with `create-obsidian-plugin` (preset `all-in-one`, desktop and mobile, the unofficial API subset, CodeMirror editor extensions). Its answers are in `.create-obsidian-plugin.json`.

The link engine is implemented in `src/link-engine.ts`, with its shared model in `src/link-model.ts` and lifecycle subscriptions in `src/link-engine-component.ts`. `Plugin.linkEngine` exposes rows and problems per note and an `onChanged` subscription. Startup takes one snapshot; later changes use core backlinks plus reverse indexes retained by the engine. New breaks keep their cause until repaired and produce a plugin-owned notice. File renames and deletions are compared after the metadata resolver settles. `runInBatch` and `updateMany` compare a batch once; automatic observation of another plugin's rename-handler batches requires provider lifecycle notifications that its current public API does not expose.

Automatic repairs are implemented in `src/auto-repair-component.ts`, with transaction evidence in `src/auto-repair.ts`. A CodeMirror update listener recognizes isolated ATX or setext heading edits and correlates one cut with an identical paste into another note, retaining that evidence while the destination editor loads. Metadata must confirm that the original endpoint disappeared and exactly one replacement exists at the expected position. Backlinks come from the link engine's retained reverse index; the shared library edits wikilinks, Markdown links, embeds and frontmatter. Reference-style definitions use metadata ranges and destination-only validation in `src/reference-repair.ts`, preserving labels, titles and use sites. References already updated by another handler are left alone. File operations invalidate pending editor evidence; programmatic and external edits remain reported by the engine.

Each repair has one plugin-owned notice naming the endpoint changes and an Undo button. Endpoints from one operation share a metadata snapshot, including different fragment spellings for the same heading. A journal groups all rewritten notes; shared editor locks, dirty-buffer saves, compare-and-swap writes and rollback protect concurrent edits. Undo refuses to overwrite a note edited after the repair. The searchable **Automatically repair links** setting is enabled by default and persisted in plugin data.

The Problems side view is implemented in `src/problems-view.ts`, opened from the ribbon or **Open problems** command. It subscribes to the link engine, groups problems by note and source position, shows severity and cause, and opens the selected range. Frontmatter links have a property key rather than a metadata range, so navigation opens the start of that note. Kind and folder filters combine with the persisted **Ignore paths in Problems** setting, supporting literal paths/folders and `*`, `**`, `?` globs. Filtering hides panel rows without suppressing engine evidence or automatic repairs.

`src/problem-fixes.ts` provides explicit candidate selection, note/heading creation, paragraph selection for restoring a block id, unlinking while keeping the caption, and grouped updates to a renamed endpoint. Candidate evidence comes from `obsidian-lib`'s shared finder (git renames on desktop, causal renames, aliases, titles, case changes and same-name paths). Git is loaded only when the user asks for fixes. Body, frontmatter and reference definitions can be repaired together, preserving reference labels and titles. Fixes reuse the repair journal and its concurrency checks and undo. Reference unlinking uses a Markdown AST; it conservatively refuses notes containing `%%` rather than modifying hidden text. Creating a note never fabricates an attachment and undo refuses to trash an edited note.

The sample commands and suggest have been removed. Syntax checks and editor diagnostics described below are not implemented yet. The demo vault demonstrates heading edits, automatic repair and the Problems view. Unit tests run with `npm run test:coverage`; live tests are `src/link-engine.cross-platform.integration.test.ts`, `src/auto-repair.cross-platform.integration.test.ts`, `src/auto-repair-move.desktop.integration.test.ts` and `src/problems.cross-platform.integration.test.ts`. Run these with the matching Vitest integration project and one worker when sharing a bulk processor budget.

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

1. A link to a note, heading, block or attachment that does not exist: pick a candidate (git rename, alias, title, near-miss name), create the target, or remove the link and keep its text.
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

The pure candidate finder for a missing file target lives in `@mnaoumov/obsidian-lib/broken-link-candidates`. Both this plugin and `Consistent Attachments and Links` import it, so there is one copy. Its current evidence kinds are git renames, aliases, titles, case changes, renamed folders and matching file names.
