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

  /**
   * Compare-and-set: moves from `expected` to `to` only if the transfer is
   * still in `expected`, in one step, and returns the state now stored. A
   * database does the same with
   * `UPDATE transfers SET state = :to WHERE id = :id AND state = :expected`
   * and a check that one row changed. When the transfer is elsewhere, another
   * run moved it first: this throws {@link StateConflictError} and moves
   * nothing. The payout flow's `onAuthorized` must work this way, so two
   * runs for one transfer cannot both sign.
   */
  compareAndMove(expected: TransferState, to: TransferState, detail?: string, reason?: TransitionReason): TransferState {
    if (this.current !== expected) throw new StateConflictError(this.id, expected, this.current);
    this.move(to, detail, reason);
    return this.current;
  }
}

/** A compare-and-set found the transfer in another state than it expected. */
export class StateConflictError extends Error {
  constructor(
    readonly transferId: string,
    readonly expected: TransferState,
    readonly found: TransferState,
  ) {
    super(`Transfer ${transferId} is in ${found}, not ${expected}: another run moved it first; nothing changed`);
    this.name = 'StateConflictError';
  }
}
