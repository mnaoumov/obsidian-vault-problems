import type { App } from 'obsidian';

import {
  Component,
  TFile
} from 'obsidian';

import type { LinkChange } from './link-model.ts';

import { LinkEngine } from './link-engine.ts';

/**
Lifecycle dependencies for metadata observation.
*/
export interface LinkEngineComponentConstructorParams {
  readonly app: App;
  readonly engine: LinkEngine;
}

/**
Owns subscriptions; file operations wait for the resolver to settle.
*/
export class LinkEngineComponent extends Component {
  private active = false;
  private readonly app: App;
  private readonly engine: LinkEngine;
  private readonly pending: LinkChange[] = [];

  public constructor(params: LinkEngineComponentConstructorParams) {
    super();
    this.app = params.app;
    this.engine = params.engine;
  }

  public override onload(): void {
    this.active = true;
    this.register(() => {
      this.active = false;
      this.pending.length = 0;
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.active) {
        this.engine.initialize();
      }
    });
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      this.changed({ kind: 'changed', path: file.path });
    }));
    this.registerEvent(this.app.metadataCache.on('resolve', (file) => {
      this.changed({ kind: 'resolved', path: file.path });
    }));
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      this.engine.updateMany(this.pending.splice(0));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile) {
        this.pending.push({ kind: 'rename', oldPath, path: file.path });
      }
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file instanceof TFile) {
        this.pending.push({ kind: 'delete', path: file.path });
      }
    }));
  }

  private changed(change: LinkChange): void {
    if (this.pending.length > 0) {
      this.pending.push(change);
    } else {
      this.engine.update(change);
    }
  }
}
