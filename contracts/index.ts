import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import path from 'node:path';
import {
  createStatementWitnesses,
  InMemoryStatementStore,
  type StatementPrivateState,
} from '../src/statement-witnesses.js';

export {
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
  type ImpureCircuits,
  type PureCircuits,
} from './managed/statement/contract/index.js';
import { Contract } from './managed/statement/contract/index.js';

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');
export const zkConfigPath = path.resolve(currentDir, 'managed', 'statement');

export { type StatementPrivateState } from '../src/statement-witnesses.js';

// Test/default store. A frontend should construct its own store with the
// authenticated user's private values before creating its contract binding.
export const statementStore = new InMemoryStatementStore({
  bankKey: new Uint8Array(32),
  statement: new Uint8Array(32),
  identityKey: new Uint8Array(32),
  nonce: new Uint8Array(32),
});

export function createCompiledStatementContract(store: InMemoryStatementStore) {
  return CompiledContract.make('StatementContract', Contract).pipe(
    CompiledContract.withWitnesses(createStatementWitnesses(store)),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );
}

export const CompiledStatementContract =
  createCompiledStatementContract(statementStore);
