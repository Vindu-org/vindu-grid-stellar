/**
 * The transfer as the application would store it: its state, moved only
 * through core's transition table, with one printed line per move.
 */
import { type Route, type TransferState, type TransitionReason, transition } from '@vindu/grid-core';

export type Log = (line: string) => void;

export class Transfer {
  private current: TransferState = 'quoted';
  private readonly path: TransferState[] = ['quoted'];

  constructor(
    readonly id: string,
    readonly route: Route,
    private readonly log: Log,
  ) {}

  get state(): TransferState {
    return this.current;
  }

  /** Every state the transfer went through, in order. */
  get history(): readonly TransferState[] {
    return this.path;
  }

  /**
   * Moves to `to` through core's `transition`, which throws
   * `InvalidTransitionError` for any pair the table does not allow. `reason`
   * picks the rule when the pair has several.
   */
  move(to: TransferState, detail?: string, reason?: TransitionReason): void {
    const rule = transition(this.current, to, reason);
    this.log(`  ${rule.from} -> ${rule.to} (${rule.label})${detail === undefined ? '' : `: ${detail}`}`);
    this.current = to;
    this.path.push(to);
  }
}
