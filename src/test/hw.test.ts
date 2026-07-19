import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  deployContract,
  submitCallTx,
  type DeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  type EnvironmentConfiguration,
  waitForFunds,
} from '@midnight-ntwrk/testkit-js';
import pino from 'pino';

import { getConfig } from '../config.js';
import {
  MidnightWalletProvider,
  syncWallet,
  type WalletSecret,
} from '../wallet.js';
import { buildProviders, type StatementProviders } from '../providers.js';
import {
  CompiledStatementContract,
  Contract,
  ledger,
  statementStore,
  zkConfigPath,
  type StatementPrivateState,
} from '../../contracts/index.js';

// Required for GraphQL subscriptions in Node.js
// @ts-expect-error WebSocket global assignment for apollo
globalThis.WebSocket = WebSocket;

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const ALICE_LOCAL_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';
const PRIVATE_STATE_ID = 'AlicePrivateStatementState';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';

function resolveSecret(net: string): WalletSecret {
  if (net === 'local') return { kind: 'seed', value: ALICE_LOCAL_SEED };

  const upper = net.toUpperCase();
  const mnemonicEnv = `MIDNIGHT_${upper}_MNEMONIC`;
  const seedEnv = `MIDNIGHT_${upper}_SEED`;
  const mnemonic = process.env[mnemonicEnv]?.trim().replace(/\s+/g, ' ');
  const seedHex = process.env[seedEnv]?.trim();

  if (mnemonic && seedHex) {
    throw new Error(
      `Set only one of ${mnemonicEnv} or ${seedEnv} (both are defined).`,
    );
  }
  if (mnemonic) {
    return { kind: 'mnemonic', value: mnemonic };
  }
  if (seedHex) {
    if (!/^[0-9a-fA-F]+$/.test(seedHex) || seedHex.length % 2 !== 0) {
      throw new Error(
        `${seedEnv} must be a hex string of even length (no 0x prefix).`,
      );
    }
    return { kind: 'seed', value: seedHex };
  }
  throw new Error(
    `Either ${mnemonicEnv} or ${seedEnv} is required for network '${net}'. ` +
      `Set one in .env.${net} or the shell.`,
  );
}

describe(`Statement Contract (${network})`, () => {
  let wallet: MidnightWalletProvider;
  let providers: StatementProviders;
  let contractAddress: ContractAddress;

  const config = getConfig();
  const secret = resolveSecret(network);
  const isRemote = network !== 'local';
  const syncTimeoutMs = Number(
    process.env['MIDNIGHT_SYNC_TIMEOUT_MS'] ??
      (isRemote ? 60 * 60_000 : 10 * 60_000),
  );

  async function queryLedger(p: StatementProviders) {
    const state = await p.publicDataProvider.queryContractState(contractAddress);
    expect(state).not.toBeNull();
    return ledger(state!.data);
  }

  beforeAll(async () => {
    setNetworkId(config.networkId);

    const envConfig: EnvironmentConfiguration = {
      walletNetworkId: config.networkId,
      networkId: config.networkId,
      indexer: config.indexer,
      indexerWS: config.indexerWS,
      node: config.node,
      nodeWS: config.nodeWS,
      faucet: config.faucet,
      proofServer: config.proofServer,
    };

    wallet = await MidnightWalletProvider.build(logger, envConfig, secret);
    await wallet.start();
    await syncWallet(logger, wallet.wallet, syncTimeoutMs);

    if (isRemote) {
      // NIGHT→DUST registration. Seed is pre-funded via the faucet page; idempotent.
      const nightBalance = await waitForFunds(
        wallet.wallet,
        envConfig,
        false,
        wallet.unshieldedKeystore,
      );
      logger.info(`Wallet NIGHT balance on '${network}': ${nightBalance}`);
    }

    providers = buildProviders(wallet, zkConfigPath, config);
    logger.info(`Providers initialized on '${network}'. Ready to test!`);
  });

  afterAll(async () => {
    if (wallet) {
      logger.info('Stopping wallet...');
      await wallet.stop();
    }
  });

  async function deployStatement(
    privateState: StatementPrivateState,
    privateStateId: string,
  ): Promise<ContractAddress> {
    logger.info(`Creating private state...`);
    statementStore.replace(privateState);

    const deployed: DeployedContract<Contract> =
      await (deployContract<Contract>)(providers, {
        compiledContract: CompiledStatementContract,
        privateStateId,
        initialPrivateState: privateState,
      });

    logger.info(`Setting the contract address...`);
    const address = deployed.deployTxData.public.contractAddress;
    logger.info(`Contract deployed at: ${address}`);
    expect(address).toBeDefined();
    expect(address.length).toBeGreaterThan(0);
    return address;
  }

  function samplePrivateState(identityKey = 3): StatementPrivateState {
    return {
      bankKey: new Uint8Array(32).fill(1),
      statement: new Uint8Array(32).fill(2),
      identityKey: new Uint8Array(32).fill(identityKey),
      nonce: new Uint8Array(32).fill(4),
    };
  }

  it('issues a statement and proves ownership with matching witness values', async () => {
    const privateState = samplePrivateState();
    contractAddress = await deployStatement(privateState, PRIVATE_STATE_ID);

    await (submitCallTx<Contract, 'issueStatement'>)(providers, {
      compiledContract: CompiledStatementContract,
      contractAddress,
      privateStateId: PRIVATE_STATE_ID,
      circuitId: 'issueStatement',
      args: [privateState.statement, privateState.identityKey, privateState.nonce],
    });

    await (submitCallTx<Contract, 'proveStatementOwnership'>)(providers, {
      compiledContract: CompiledStatementContract,
      contractAddress,
      privateStateId: PRIVATE_STATE_ID,
      circuitId: 'proveStatementOwnership',
    });

    const state = await queryLedger(providers);
    expect(state.issued).toEqual(true);
    expect(state.ownershipProved).toEqual(true);
  });

  it('rejects a proof from mismatched witness values', async () => {
    const issuedValues = samplePrivateState();
    const mismatchedWitnessValues = samplePrivateState(9);
    const mismatchStateId = 'MismatchedStatementState';
    contractAddress = await deployStatement(mismatchedWitnessValues, mismatchStateId);

    await (submitCallTx<Contract, 'issueStatement'>)(providers, {
      compiledContract: CompiledStatementContract,
      contractAddress,
      privateStateId: mismatchStateId,
      circuitId: 'issueStatement',
      args: [
        issuedValues.statement,
        issuedValues.identityKey,
        issuedValues.nonce,
      ],
    });

    await expect(
      (submitCallTx<Contract, 'proveStatementOwnership'>)(providers, {
        compiledContract: CompiledStatementContract,
        contractAddress,
        privateStateId: mismatchStateId,
        circuitId: 'proveStatementOwnership',
      }),
    ).rejects.toThrow();

    const state = await queryLedger(providers);
    expect(state.issued).toEqual(true);
    expect(state.ownershipProved).toEqual(false);
  });
});
