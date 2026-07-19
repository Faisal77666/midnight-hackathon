import { createHash, randomUUID } from 'node:crypto';
import pino from 'pino';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

import { getConfig } from '../src/config.js';
import { buildProviders, type StatementProviders } from '../src/providers.js';
import { MidnightWalletProvider, syncWallet } from '../src/wallet.js';
import {
  createCompiledStatementContract,
  ledger,
  zkConfigPath,
  type Contract,
} from '../contracts/index.js';
import {
  InMemoryStatementStore,
  type StatementPrivateState,
} from '../src/statement-witnesses.js';

type IssueInput = {
  statement: string;
  identityKey: string;
  bankKey: string;
  nonce: string;
};

type ProofInput = Pick<IssueInput, 'statement' | 'identityKey' | 'nonce'>;

type IssuedStatement = {
  contractAddress: ContractAddress;
  privateStateId: string;
  bankKey: Uint8Array;
};

type GatewayRuntime = { providers: StatementProviders };

const LOCAL_DEMO_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

function privateBytes(value: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value).digest());
}

function statementState(input: IssueInput): StatementPrivateState {
  return {
    bankKey: privateBytes(input.bankKey),
    statement: privateBytes(input.statement),
    identityKey: privateBytes(input.identityKey),
    nonce: privateBytes(input.nonce),
  };
}

export function createMidnightGateway() {
  const logger = pino({ level: 'warn' });
  const issued = new Map<string, IssuedStatement>();
  let runtime: Promise<GatewayRuntime> | undefined;

  async function getRuntime(): Promise<GatewayRuntime> {
    if (runtime) return runtime;
    runtime = (async () => {
      const config = getConfig();
      if ((process.env.MIDNIGHT_NETWORK ?? 'local') !== 'local') {
        throw new Error('The hackathon verifier gateway is configured for the local Midnight devnet only.');
      }
      setNetworkId(config.networkId);
      const environment: EnvironmentConfiguration = {
        walletNetworkId: config.networkId,
        networkId: config.networkId,
        indexer: config.indexer,
        indexerWS: config.indexerWS,
        node: config.node,
        nodeWS: config.nodeWS,
        faucet: config.faucet,
        proofServer: config.proofServer,
      };
      const wallet = await MidnightWalletProvider.build(logger, environment, { kind: 'seed', value: LOCAL_DEMO_SEED });
      await wallet.start();
      await syncWallet(logger, wallet.wallet, 10 * 60_000);
      return { providers: buildProviders(wallet, zkConfigPath, config) };
    })();
    return runtime;
  }

  async function issue(input: IssueInput) {
    const { providers } = await getRuntime();
    const state = statementState(input);
    const store = new InMemoryStatementStore(state);
    const privateStateId = `statement-${randomUUID()}`;
    const compiledContract = createCompiledStatementContract(store);
    const deployed = await deployContract<Contract>(providers, {
      compiledContract,
      privateStateId,
      initialPrivateState: state,
    });
    const contractAddress = deployed.deployTxData.public.contractAddress;
    await submitCallTx<Contract, 'issueStatement'>(providers, {
      compiledContract,
      contractAddress,
      privateStateId,
      circuitId: 'issueStatement',
      args: [state.statement, state.identityKey, state.nonce],
    });
    const reference = randomUUID();
    issued.set(reference, { contractAddress, privateStateId, bankKey: state.bankKey });
    return { reference, contractAddress };
  }

  async function prove(reference: string, input: ProofInput) {
    const issuedStatement = issued.get(reference);
    if (!issuedStatement) throw new Error('This verification link is unknown or the demo server was restarted. Ask the bank to issue a new statement.');
    const { providers } = await getRuntime();
    const store = new InMemoryStatementStore({
      bankKey: issuedStatement.bankKey,
      statement: privateBytes(input.statement),
      identityKey: privateBytes(input.identityKey),
      nonce: privateBytes(input.nonce),
    });
    const compiledContract = createCompiledStatementContract(store);
    await submitCallTx<Contract, 'proveStatementOwnership'>(providers, {
      compiledContract,
      contractAddress: issuedStatement.contractAddress,
      privateStateId: issuedStatement.privateStateId,
      circuitId: 'proveStatementOwnership',
    });
    const publicState = await providers.publicDataProvider.queryContractState(issuedStatement.contractAddress);
    return ledger(publicState!.data).ownershipProved;
  }

  return { issue, prove };
}
