import type { EditorState } from '@codemirror/state';
import type {
  DecorationSet,
  TooltipView,
  ViewUpdate
} from '@codemirror/view';
import type { Pos } from 'obsidian';

import { StateEffect } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  hoverTooltip,
  ViewPlugin
} from '@codemirror/view';

import type {
  LinkProblem,
  LinkRow
} from './link-model.ts';

export interface RangedLinkProblem extends LinkProblem {
  readonly row: RangedLinkRow;
}

interface EditorProblemsConstructorParams {
  readonly getPath: (state: EditorState) => string | undefined;
  readonly getProblems: (path: string) => readonly LinkProblem[];
  readonly showFixes: (problem: RangedLinkProblem, view: EditorView) => void;
  readonly subscribe: (refresh: (path?: string) => void) => () => void;
}

interface RangedLinkRow extends LinkRow {
  readonly position: Pos;
}

const refreshProblems = StateEffect.define();

/**
Projects metadata diagnostics without parsing or checking editor content.
*/
export class EditorProblems {
  public readonly extension;
  private readonly projection;

  public constructor(params: EditorProblemsConstructorParams) {
    this.projection = ViewPlugin.define((view) => {
      let isAlive = true;
      const projection = {
        decorations: Decoration.none,
        destroy: (): void => {
          isAlive = false;
          unsubscribe();
        },
        path: params.getPath(view.state),
        problems: [] as readonly RangedLinkProblem[],
        update: (update: ViewUpdate): void => {
          const path = params.getPath(update.state);
          if (path !== projection.path || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshProblems)))) {
            projection.path = path;
            rebuild();
          } else if (update.docChanged) {
            // Metadata positions are stale until the engine publishes a new snapshot.
            projection.problems = [];
            projection.decorations = Decoration.none;
          }
        }
      };
      function rebuild(): void {
        projection.problems = projection.path
          ? params.getProblems(projection.path).filter((problem): problem is RangedLinkProblem => {
            const position = problem.row.position;
            return problem.row.sourcePath === projection.path && position !== null && position.start.offset >= 0 && position.end.offset > position.start.offset && position.end.offset <= view.state.doc.length;
          })
          : [];
        projection.decorations = Decoration.set(projection.problems.map((problem) => Decoration.mark({ class: 'vault-problems-underline' }).range(problem.row.position.start.offset, problem.row.position.end.offset)), true);
      }
      const unsubscribe = params.subscribe((path) => {
        if (path !== undefined && path !== params.getPath(view.state)) {
          return;
        }
        const snapshot = view.state.doc;
        // Engine notifications can arrive inside an editor update; defer dispatch.
        queueMicrotask(() => {
          if (isAlive && view.state.doc === snapshot) {
            view.dispatch({ effects: refreshProblems.of(null) });
          }
        });
      });
      rebuild();
      return projection;
    }, { decorations: (projection): DecorationSet => projection.decorations });
    this.extension = [
      this.projection,
      hoverTooltip((view, pos) => {
        const problem = this.findProblem(view, pos);
        if (!problem) {
          return null;
        }
        const position = problem.row.position;
        return {
          above: true,
          create: (): TooltipView => {
            const dom = view.dom.ownerDocument.win.createDiv();
            dom.className = 'vault-problems-tooltip';
            const message = dom.createDiv();
            message.textContent = problem.message;
            const button = dom.createEl('button');
            button.textContent = 'Quick fixes';
            button.addEventListener('click', (): void => {
              if (this.findProblem(view, pos) === problem) {
                params.showFixes(problem, view);
              }
            });
            return { dom };
          },
          end: position.end.offset,
          pos: position.start.offset
        };
      })
    ];
  }

  public getProblemAtCursor(view: EditorView): RangedLinkProblem | undefined {
    return this.findProblem(view, view.state.selection.main.head);
  }

  private findProblem(view: EditorView, offset: number): RangedLinkProblem | undefined {
    return view.plugin(this.projection)?.problems.find((problem) => problem.row.position.start.offset <= offset && offset < problem.row.position.end.offset);
  }
}
