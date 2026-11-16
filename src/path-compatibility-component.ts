import type { PathCompatibilityPlatform } from '@mnaoumov/obsidian-lib/path-compatibility';
import type {
  App,
  TAbstractFile
} from 'obsidian';

import { ComponentEx } from '@mnaoumov/obsidian-lib/components/component-ex';
import { isFolder } from '@mnaoumov/obsidian-lib/file-system';
import { findPathCompatibilityViolations } from '@mnaoumov/obsidian-lib/path-compatibility';

import type { LinkEngine } from './link-engine.ts';

/**
Lifecycle dependencies for path checks.
*/
export interface PathCompatibilityComponentConstructorParams {
  readonly app: App;
  readonly engine: LinkEngine;
  /**
  Read for every check, so a settings change applies from the next one; {@link PathCompatibilityComponent.refresh} applies it
  to the whole vault.
  */
  readonly getScope: () => PathCompatibilityScope;
}

/**
The rules every name is held to.
*/
export interface PathCompatibilityScope {
  /**
  The length of the longest vault root path the vault is expected to live under, in characters.
  */
  readonly maxVaultRootPathLength: number;
  /**
  The platforms whose naming rules are enforced; empty turns the check off.
  */
  readonly platforms: readonly PathCompatibilityPlatform[];
}

/**
Feeds the engine path problems: every file and folder name at layout ready, then each name a create or rename brings.
*/
export class PathCompatibilityComponent extends ComponentEx {
  private readonly app: App;
  private readonly engine: LinkEngine;
  private readonly getScope: () => PathCompatibilityScope;
  private isReady = false;

  public constructor(params: PathCompatibilityComponentConstructorParams) {
    super();
    this.app = params.app;
    this.engine = params.engine;
    this.getScope = params.getScope;
  }

  public override onload(): void {
    this.app.workspace.onLayoutReady(() => {
      // Obsidian replays a create event for every file while it loads the vault; the scan below covers those.
      this.registerEvent(this.app.vault.on('create', (file) => {
        this.check(file);
      }));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        this.engine.clearPathViolations(oldPath);
        this.checkTree(file);
      }));
      this.registerEvent(this.app.vault.on('delete', (file) => {
        this.engine.clearPathViolations(file.path);
      }));
      this.isReady = true;
      this.refresh();
    });
  }

  /**
  Checks every name again, after a setting changed.
  */
  public refresh(): void {
    if (!this.isReady) {
      return;
    }
    this.engine.clearPathViolations(null);
    this.checkTree(this.app.vault.getRoot());
  }

  private check(file: TAbstractFile): void {
    // The vault root has no name of its own.
    if (file.path === '/') {
      return;
    }
    const scope = this.getScope();
    this.engine.setPathViolations(
      file.path,
      findPathCompatibilityViolations({ isFolder: isFolder(file), maxVaultRootPathLength: scope.maxVaultRootPathLength, path: file.path, platforms: scope.platforms })
    );
  }

  /**
  A folder's path is a prefix of every path under it, so a rename of the folder changes them all.
  */
  private checkTree(file: TAbstractFile): void {
    this.check(file);
    if (!isFolder(file)) {
      return;
    }
    for (const child of file.children) {
      this.checkTree(child);
    }
  }
}
