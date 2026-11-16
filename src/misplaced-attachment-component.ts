import type {
  App,
  Reference,
  TFile
} from 'obsidian';

import { ComponentEx } from '@mnaoumov/obsidian-lib/components/component-ex';
import { isNote } from '@mnaoumov/obsidian-lib/file-system';
import {
  ExternalAttachmentLinkMode,
  getAttachmentPlacement,
  MisplacedAttachmentIndex
} from '@mnaoumov/obsidian-lib/misplaced-attachment';
import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';

import type {
  LinkEngine,
  MisplacedAttachmentEntry
} from './link-engine.ts';
import type { LinkRow } from './link-model.ts';

/**
The note-shaped files that travel as attachments, as `Consistent Attachments and Links` treats them by default.
*/
const TREATED_AS_ATTACHMENT_SUFFIXES = ['.excalidraw.md'];

/**
Lifecycle dependencies for misplaced-attachment checks.
*/
export interface MisplacedAttachmentComponentConstructorParams {
  readonly app: App;
  readonly engine: LinkEngine;
  /**
  Read at every publish; {@link MisplacedAttachmentComponent.refresh} applies a change to the whole vault.
  */
  readonly getMode: () => ExternalAttachmentLinkMode;
}

/**
One resolved reference to an attachment, and the verdict on the folder it sits in.
*/
interface Verdict {
  readonly attachmentPath: string;
  readonly isInProperFolder: boolean;
  readonly properAttachmentFolderPath: string;
  readonly row: LinkRow;
}

/**
Feeds the engine misplaced-attachment problems.

A note is judged again whenever the engine recomputes its rows, which covers an edit of the note, its rename, and a
rename or delete of a file it links. Whether a reference is reported can depend on the OTHER notes that use the same
attachment, so every publish rebuilds the index from all the verdicts held, which needs no further question to the
attachment-path seam.
*/
export class MisplacedAttachmentComponent extends ComponentEx {
  private active = false;
  private readonly app: App;
  private readonly engine: LinkEngine;
  private readonly generations = new Map<string, number>();
  private readonly getMode: () => ExternalAttachmentLinkMode;
  private isReady = false;
  private readonly judgedRows = new Map<string, readonly LinkRow[]>();
  private readonly verdicts = new Map<string, readonly Verdict[]>();

  public constructor(params: MisplacedAttachmentComponentConstructorParams) {
    super();
    this.app = params.app;
    this.engine = params.engine;
    this.getMode = params.getMode;
  }

  public override onload(): void {
    this.active = true;
    const ref = this.engine.onChanged((change) => {
      if (!this.isReady || this.getMode() === ExternalAttachmentLinkMode.Ignore) {
        return;
      }
      for (const path of change.sourcePaths) {
        // A publish of this component's own, or of the syntax and HTML checks, leaves the rows as they were.
        if (this.app.vault.getFileByPath(path) && this.judgedRows.get(path) === this.engine.getRows(path)) {
          continue;
        }
        invokeAsyncSafely(() => this.judgeAndPublish(path));
      }
    });
    this.register(() => {
      this.active = false;
      this.engine.offref(ref);
    });
    this.app.workspace.onLayoutReady(() => {
      this.isReady = true;
      this.refresh();
    });
  }

  /**
  Judges every note again, after the mode changed.
  */
  public refresh(): void {
    if (!this.isReady) {
      return;
    }
    this.verdicts.clear();
    this.judgedRows.clear();
    this.engine.clearMisplacedAttachments();
    if (this.getMode() === ExternalAttachmentLinkMode.Ignore) {
      return;
    }
    invokeAsyncSafely(() => this.scan());
  }

  private isAttachment(file: TFile): boolean {
    return !isNote(file) || TREATED_AS_ATTACHMENT_SUFFIXES.some((suffix) => file.path.toLowerCase().endsWith(suffix));
  }

  private async judge(notePath: string): Promise<null | readonly Verdict[]> {
    const generation = (this.generations.get(notePath) ?? 0) + 1;
    this.generations.set(notePath, generation);
    const rows = this.engine.getRows(notePath);
    this.judgedRows.set(notePath, rows);
    const verdicts: Verdict[] = [];
    for (const row of rows) {
      const attachmentFile = row.target?.kind === 'file' ? this.app.vault.getFileByPath(row.target.path) : null;
      if (!attachmentFile || !this.isAttachment(attachmentFile)) {
        continue;
      }
      const placement = await getAttachmentPlacement({ app: this.app, attachmentFile, notePath });
      verdicts.push({ attachmentPath: attachmentFile.path, ...placement, row });
    }
    // A later judgement of the same note has started; its answer is the current one.
    return this.generations.get(notePath) === generation ? verdicts : null;
  }

  private async judgeAndPublish(notePath: string): Promise<void> {
    const previous = this.verdicts.get(notePath) ?? [];
    const verdicts = this.app.vault.getFileByPath(notePath) ? await this.judge(notePath) : [];
    if (verdicts === null || !this.active) {
      return;
    }
    this.setVerdicts(notePath, verdicts);
    this.publish([notePath], [...previous, ...verdicts].map((verdict) => verdict.attachmentPath));
  }

  /**
  Publishes the given notes, and every other note that uses one of the given attachments, since under
  {@link ExternalAttachmentLinkMode.ReportUnowned} one note's verdict decides whether another's reference is reported.
  */
  private publish(notePaths: readonly string[], attachmentPaths: readonly string[]): void {
    const index = new MisplacedAttachmentIndex(this.getMode());
    const rowsByReference = new Map<Reference, LinkRow>();
    for (const [notePath, verdicts] of this.verdicts) {
      for (const verdict of verdicts) {
        if (verdict.isInProperFolder) {
          index.markHomed(verdict.attachmentPath, notePath);
          continue;
        }
        // The index keeps a reference only to hand it back; the row is what the engine reports.
        const reference: Reference = { link: verdict.row.link, original: verdict.row.link };
        rowsByReference.set(reference, verdict.row);
        index.add(notePath, { attachmentPath: verdict.attachmentPath, properAttachmentFolderPath: verdict.properAttachmentFolderPath, reference });
      }
    }
    const affected = new Set(notePaths);
    for (const attachmentPath of new Set(attachmentPaths)) {
      for (const notePath of index.getOtherUserNotePaths(attachmentPath, '')) {
        affected.add(notePath);
      }
    }
    const reported = index.getReported();
    for (const notePath of affected) {
      const entries = (reported.get(notePath) ?? []).map((entry): MisplacedAttachmentEntry => ({
        misplacedAttachment: { attachmentPath: entry.attachmentPath, properAttachmentFolderPath: entry.properAttachmentFolderPath },
        row: ensureNonNullable(rowsByReference.get(entry.reference))
      }));
      this.engine.setMisplacedAttachments(notePath, entries);
    }
  }

  /**
  Judges notes one at a time and publishes once, so a large vault asks the attachment-path seam once per reference.
  */
  private async scan(): Promise<void> {
    const notePaths: string[] = [];
    for (const note of this.app.vault.getMarkdownFiles()) {
      const verdicts = await this.judge(note.path);
      if (!this.active || this.getMode() === ExternalAttachmentLinkMode.Ignore) {
        return;
      }
      if (verdicts === null) {
        continue;
      }

      this.setVerdicts(note.path, verdicts);
      notePaths.push(note.path);
    }
    this.publish(notePaths, []);
  }

  private setVerdicts(notePath: string, verdicts: readonly Verdict[]): void {
    if (verdicts.length === 0) {
      this.verdicts.delete(notePath);
    } else {
      this.verdicts.set(notePath, verdicts);
    }
  }
}
