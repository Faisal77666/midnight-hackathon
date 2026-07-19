import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger, Witnesses } from '../contracts/managed/statement/contract/index.js';

export type StatementPrivateState = {
  bankKey: Uint8Array;
  statement: Uint8Array;
  identityKey: Uint8Array;
  nonce: Uint8Array;
};

/**
 * Minimal in-memory store for a single account's private statement data.
 * Keep this object in the browser session, or hydrate it from encrypted local
 * storage before submitting a contract transaction.
 */
export class InMemoryStatementStore {
  #state: StatementPrivateState;

  constructor(initialState: StatementPrivateState) {
    this.#state = initialState;
  }

  read(): StatementPrivateState {
    return this.#state;
  }

  replace(nextState: StatementPrivateState): void {
    this.#state = nextState;
  }
}

/**
 * Creates the Compact witness implementation. Values returned by these
 * functions are private inputs to the ZK circuit and are never ledger writes.
 */
export function createStatementWitnesses(
  store: InMemoryStatementStore,
): Witnesses<StatementPrivateState> {
  const withState = <T>(
    context: WitnessContext<Ledger, StatementPrivateState>,
    value: (state: StatementPrivateState) => T,
  ): [StatementPrivateState, T] => [context.privateState, value(store.read())];

  return {
    localBankKey: (context) => withState(context, (state) => state.bankKey),
    localStatement: (context) => withState(context, (state) => state.statement),
    localIdentityKey: (context) => withState(context, (state) => state.identityKey),
    localNonce: (context) => withState(context, (state) => state.nonce),
  };
}
