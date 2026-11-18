/** What both legs of the demo transfer share. */
import type { AccountRef } from '@vindu/grid-core';

import type { ChainWatch } from './chain-watch';
import type { Log, Transfer } from './transfer';
import type { DemoWorld } from './world';

export interface LegContext {
  readonly world: DemoWorld;
  readonly transfer: Transfer;
  /** The client's registered Stellar account. */
  readonly account: AccountRef;
  readonly customerId: string;
  readonly watch: ChainWatch;
  readonly log: Log;
  readonly now: () => number;
}
