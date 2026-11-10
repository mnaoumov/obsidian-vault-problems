import type { App } from 'obsidian';

import { watchPluginApi } from '@mnaoumov/obsidian-lib/plugin/plugin-api';
import { Component } from 'obsidian';

import type {
  AdvancedRenameAndDeleteHandlerApi,
  BulkOperationEvent
} from './advanced-rename-and-delete-handler/api.d.ts';
import type { LinkEngine } from './link-engine.ts';

import { ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT } from './advanced-rename-and-delete-handler/api-contract.ts';

/**
The plugin whose bulk moves are observed.
*/
export const ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID = 'advanced-rename-and-delete-handler';

/**
Collaborators for observing another plugin's bulk operations.
*/
export interface RenameHandlerBatchComponentConstructorParams {
  readonly app: App;
  readonly engine: LinkEngine;
}

/**
Holds the link snapshot across a rename handler's `moveMany` or `runInBatch`, so the whole operation is compared once.

The handler's published lifecycle notifications open an engine batch at start and close it at end, which arrives
after its handler queue and metadata parsing settle, including when the operation fails. A subscription made during
an operation receives a replayed start, so the snapshot held from then on is partial, which is the best available.
A batch still open when the provider goes away or this component unloads is closed, so the engine never stays deferred.
*/
export class RenameHandlerBatchComponent extends Component {
  private readonly app: App;
  private endBatch: (() => void) | null = null;
  private readonly engine: LinkEngine;
  private unsubscribe: (() => void) | null = null;

  public constructor(params: RenameHandlerBatchComponentConstructorParams) {
    super();
    this.app = params.app;
    this.engine = params.engine;
  }

  public override onload(): void {
    const ref = watchPluginApi<AdvancedRenameAndDeleteHandlerApi>({
      apiVersionRange: '^1.4.0',
      app: this.app,
      component: this,
      contract: ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT,
      pluginId: ADVANCED_RENAME_AND_DELETE_HANDLER_PLUGIN_ID
    });
    const connect = (): void => {
      this.disconnect();
      this.unsubscribe = ref.value?.subscribeBulkOperations((notification) => {
        this.handle(notification);
      }) ?? null;
    };
    ref.on('change', connect);
    this.register(() => {
      ref.off('change', connect);
      this.disconnect();
    });
    connect();
  }

  private disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.finish();
  }

  private finish(): void {
    this.endBatch?.();
    this.endBatch = null;
  }

  private handle(notification: BulkOperationEvent): void {
    if (notification.phase === 'start') {
      // Only one bulk operation runs at a time; a repeated start must not open a batch nobody ends.
      this.endBatch ??= this.engine.beginBatch();
      return;
    }
    // Partial moves are not rolled back, so a failed operation is compared like a successful one.
    this.finish();
  }
}
