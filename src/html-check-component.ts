import type { App } from 'obsidian';

import { watchPluginApi } from '@mnaoumov/obsidian-lib/plugin/plugin-api';
import {
  invokeAsyncSafely,
  sleep
} from '@mnaoumov/typescript-lib/async';
import { Component } from 'obsidian';

import type { AdvancedMetadataCacheHtmlApi } from './advanced-metadata-cache.ts';
import type { LinkEngine } from './link-engine.ts';

import {
  ADVANCED_METADATA_CACHE_HTML_API_VERSION_RANGE,
  ADVANCED_METADATA_CACHE_PLUGIN_ID
} from './advanced-metadata-cache.ts';

/**
How long the first re-query of an edited note waits; each later one waits twice as long.
*/
const PENDING_EDIT_FIRST_DELAY_IN_MILLISECONDS = 250;

/**
How much longer each re-query of an edited note waits than the one before.
*/
const PENDING_EDIT_BACKOFF_FACTOR = 2;

/**
How many times an edited note is re-queried while the provider still answers `null` for it.
*/
const PENDING_EDIT_MAX_RETRIES = 5;

/**
Lifecycle dependencies for HTML checks.
*/
export interface HtmlCheckComponentConstructorParams {
  readonly app: App;
  readonly engine: LinkEngine;
  readonly onStatusChanged: () => void;
}

/**
Feeds the engine HTML problems from `Advanced Metadata Cache`'s shared HTML index.

Nothing here parses Markdown or HTML: the provider keeps one persisted index of each note's HTML candidates and judges
them through Obsidian's own sanitizer. One query per note at layout ready, then one per metadata change. While the
provider is missing, or answers `null` because its opt-in `HTML` module is off, the status says the vault was not
checked, so an empty list never reads as a clean vault.
*/
export class HtmlCheckComponent extends Component {
  /**
  A sentence for the Problems view while HTML is not fully checked, or `null` once it is.
  */
  public get statusMessage(): null | string {
    if (!this.api) {
      return 'HTML is not checked: it needs the Advanced Metadata Cache plugin, 2.5.0 or later, with its HTML module turned on.';
    }
    if (this.isScanning) {
      return 'Checking HTML in the vault…';
    }
    if (this.uncheckedPaths.size > 0) {
      return `HTML is not checked in ${String(this.uncheckedPaths.size)} note(s): turn on the HTML module in Advanced Metadata Cache, or wait for it to index them.`;
    }
    return null;
  }

  private abortController = new AbortController();
  private api: AdvancedMetadataCacheHtmlApi | null = null;
  private readonly app: App;
  private readonly changedDuringScan = new Set<string>();
  private readonly engine: LinkEngine;
  private isScanning = false;
  private readonly onStatusChanged: () => void;
  private readonly uncheckedPaths = new Set<string>();

  public constructor(params: HtmlCheckComponentConstructorParams) {
    super();
    this.app = params.app;
    this.engine = params.engine;
    this.onStatusChanged = params.onStatusChanged;
  }

  public override onload(): void {
    const ref = watchPluginApi<AdvancedMetadataCacheHtmlApi>({
      apiVersionRange: ADVANCED_METADATA_CACHE_HTML_API_VERSION_RANGE,
      app: this.app,
      component: this,
      pluginId: ADVANCED_METADATA_CACHE_PLUGIN_ID
    });
    const connect = (): void => {
      this.connect(ref.value);
    };
    ref.on('change', connect);
    this.register(() => {
      ref.off('change', connect);
      this.abortController.abort();
    });
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      if (this.isScanning) {
        this.changedDuringScan.add(file.path);
      }
      invokeAsyncSafely(() => this.refresh(file.path, this.abortController.signal));
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (this.uncheckedPaths.delete(file.path)) {
        this.onStatusChanged();
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.uncheckedPaths.delete(oldPath)) {
        this.uncheckedPaths.add(file.path);
      }
    }));
    connect();
  }

  private connect(api: AdvancedMetadataCacheHtmlApi | null): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.api = api;
    this.uncheckedPaths.clear();
    this.changedDuringScan.clear();
    this.isScanning = api !== null;
    this.engine.clearHtmlDiagnostics();
    this.onStatusChanged();
    if (!api) {
      return;
    }
    this.app.workspace.onLayoutReady(() => {
      invokeAsyncSafely(() => this.scan(api, signal));
    });
  }

  private publish(path: string, diagnostics: Awaited<ReturnType<AdvancedMetadataCacheHtmlApi['getHtmlDiagnosticsSafe']>>): void {
    if (diagnostics === null) {
      this.uncheckedPaths.add(path);
      return;
    }
    this.uncheckedPaths.delete(path);
    this.engine.setHtmlDiagnostics(path, diagnostics);
  }

  /**
  Re-queries an edited note, waiting out the provider's own metadata event, which may run after this one.
  */
  private async refresh(path: string, signal: AbortSignal): Promise<void> {
    const api = this.api;
    if (!api) {
      return;
    }
    const wasUnchecked = this.uncheckedPaths.has(path);
    // A function, so the check after each await reads the signal anew rather than a narrowed earlier value.
    function isAborted(): boolean {
      return signal.aborted;
    }
    let delay = PENDING_EDIT_FIRST_DELAY_IN_MILLISECONDS;
    for (let attempt = 0;; attempt++) {
      if (attempt > 0) {
        await sleep({ abortSignal: signal, milliseconds: delay });
        delay *= PENDING_EDIT_BACKOFF_FACTOR;
      }
      if (isAborted()) {
        return;
      }
      const diagnostics = await api.getHtmlDiagnosticsSafe(path);
      if (isAborted()) {
        return;
      }
      if (diagnostics !== null || attempt === PENDING_EDIT_MAX_RETRIES) {
        this.publish(path, diagnostics);
        break;
      }
    }
    if (!this.isScanning && wasUnchecked !== this.uncheckedPaths.has(path)) {
      this.onStatusChanged();
    }
  }

  /**
  Queries notes one at a time; the provider reads no note for an unchanged index record.
  */
  private async scan(api: AdvancedMetadataCacheHtmlApi, signal: AbortSignal): Promise<void> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.changedDuringScan.has(file.path)) {
        continue;
      }
      const diagnostics = await api.getHtmlDiagnosticsSafe(file.path);
      if (signal.aborted) {
        return;
      }
      // A change while the query was in flight publishes fresher diagnostics itself.
      if (!this.changedDuringScan.has(file.path) && this.app.vault.getFileByPath(file.path)) {
        this.publish(file.path, diagnostics);
      }
    }
    this.isScanning = false;
    this.changedDuringScan.clear();
    this.onStatusChanged();
  }
}
