import type {
  App,
  TFile
} from 'obsidian';

import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { Component } from 'obsidian';

import type { LinkEngine } from './link-engine.ts';

import { findSyntaxIssues } from './syntax-checks.ts';

/**
Lifecycle dependencies for syntax checks.
*/
export interface SyntaxCheckComponentConstructorParams {
  readonly app: App;
  readonly engine: LinkEngine;
}

/**
Feeds the engine syntax problems: one read of every note at layout ready, then the text of each metadata change.
*/
export class SyntaxCheckComponent extends Component {
  private active = false;
  private readonly app: App;
  private readonly changedDuringScan = new Set<string>();
  private readonly engine: LinkEngine;
  private isScanning = false;

  public constructor(params: SyntaxCheckComponentConstructorParams) {
    super();
    this.app = params.app;
    this.engine = params.engine;
  }

  public override onload(): void {
    this.active = true;
    this.register(() => {
      this.active = false;
    });
    // The changed event carries the text it was parsed from, so no read is needed after the initial scan.
    this.registerEvent(this.app.metadataCache.on('changed', (file, data) => {
      if (this.isScanning) {
        this.changedDuringScan.add(file.path);
      }
      this.engine.setSyntaxIssues(file.path, findSyntaxIssues(data));
    }));
    this.app.workspace.onLayoutReady(() => {
      invokeAsyncSafely(() => this.scan());
    });
  }

  /**
  Reads notes one at a time, so a large vault never holds more than one note's text.
  */
  private async scan(): Promise<void> {
    this.isScanning = true;
    try {
      await this.scanFiles();
    } finally {
      this.isScanning = false;
      this.changedDuringScan.clear();
    }
  }

  private async scanFiles(): Promise<void> {
    const files: TFile[] = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      if (this.changedDuringScan.has(file.path) || !this.app.vault.getFileByPath(file.path)) {
        continue;
      }
      const content = await this.app.vault.cachedRead(file);
      if (!this.active) {
        return;
      }
      // A change while the read was in flight has already published fresher issues.
      if (!this.changedDuringScan.has(file.path)) {
        this.engine.setSyntaxIssues(file.path, findSyntaxIssues(content));
      }
    }
  }
}
