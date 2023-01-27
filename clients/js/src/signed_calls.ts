import { BlockTag, Provider } from '@ethersproject/abstract-provider';
import {
  Signer as EthersSigner,
  TypedDataDomain,
  TypedDataField,
  TypedDataSigner,
} from '@ethersproject/abstract-signer';
import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { BytesLike, arrayify, hexlify } from '@ethersproject/bytes';
import * as cbor from 'cborg';
import type { CamelCasedProperties, RequireExactlyOne } from 'type-fest';
import { _TypedDataEncoder } from '@ethersproject/hash';

import { Cipher, Envelope } from './cipher.js';

const DEFAULT_GAS_PRICE = 1; // Default gas params are assigned in the web3 gateway.
const DEFAULT_GAS_LIMIT = 30_000_000;
const DEFAULT_VALUE = 0;
const DEFAULT_NONCE_RANGE = 20;
const DEFAULT_BLOCK_RANGE = 4000;
const DEFAULT_DATA = '0x';
const zeroAddress = () => `0x${'0'.repeat(40)}`;

class SignedCallCacheManager {
  // for each signer, we cache the signature of the hash of each SignableCall
  private cachedSignatures = new Map<string, Map<string, Uint8Array>>();
  // for each ChainId, we cache the base block number to make the same leash
  private cachedLeashes = new Map<number, Leash>();

  public clear() {
    cachedSignatures.clear();
    cachedBlockNumbers.clear();
  }

  public cache(
    address: string,
    chainId: number,
    call: SignableEthCall,
    hash: string,
    signature: Uint8Array,
  ) {
    if (!this.cachedSignatures.has(address))
      this.cachedSignatures.set(address, new Map<string, Uint8Array>());
    this.cachedSignatures.get(address)!.set(hash, signature);
    this.cachedLeashes.set(chainId, {
      nonce: call.leash.nonce,
      block_number: call.leash.blockNumber,
      block_hash: call.leash.blockHash,
      block_range: call.leash.blockRange,
    });
  }

  public getSignatureCache(
    address: string,
    hash: string,
  ): Uint8Array | undefined {
    return this.cachedSignatures.get(address)?.get(hash);
  }

  public getLeash(chainId: number): Leash | undefined {
    return this.cachedLeashes.get(chainId);
  }
}

const _cacheManager = new SignedCallCacheManager();

export function enableSignedCallCaches() {
  _cacheManager.enable();
}

export function disableSignedCallCaches() {
  _cacheManager.disable();
}

export type Signer = Pick<
  EthersSigner,
  'getTransactionCount' | 'getChainId' | 'getAddress'
> &
  TypedDataSigner & {
    provider?: Pick<Provider, 'getBlock'>;
    _checkProvider?: EthersSigner['_checkProvider'];
  };

export function signedCallEIP712Params(chainId: number): {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
} {
  return {
    domain: {
      name: 'oasis-runtime-sdk/evm: signed query',
      version: '1.0.0',
      chainId,
    },
    types: {
      Call: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'gasLimit', type: 'uint64' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'leash', type: 'Leash' },
      ],
      Leash: [
        { name: 'nonce', type: 'uint64' },
        { name: 'blockNumber', type: 'uint64' },
        { name: 'blockHash', type: 'bytes32' },
        { name: 'blockRange', type: 'uint64' },
      ],
    },
  };
}

/**
 * Parameters that define a signed call that shall be
 * CBOR-encoded and sent as the call's `data` field.
 */
export class SignedCallDataPack {
  static async make<C extends EthCall>(
    call: C,
    signer: Signer & TypedDataSigner,
    overrides?: PrepareSignedCallOverrides,
  ): Promise<SignedCallDataPack> {
    const leash = await makeLeash(signer, overrides?.leash);
    return new SignedCallDataPack(
      leash,
      await signCall(makeSignableCall(call, leash), signer, {
        chainId: overrides?.chainId,
      }),
      call.data ? arrayify(call.data, { allowMissingPrefix: true }) : undefined,
    );
  }

  private constructor(
    public readonly leash: Leash,
    /** A signature over the call and leash as generated by `signCall`. */
    public readonly signature: Uint8Array,
    /**
     * An oasis-sdk `Call` without the optional fields.
     *
     * After encryption, `body` would be encrypted and this field would contain a
     * `format` field. The runtime would decode the data as a `types::transaction::Call`.
     **/
    public readonly data?: Uint8Array,
  ) {}

  public encode(): string {
    return this.#encode(this.data ? { body: this.data } : undefined);
  }

  /** Encodes the data pack after encrypting the signed call data. */
  public async encryptEncode(cipher: Cipher): Promise<string> {
    if (this.data) return this.#encode(await cipher.encryptEnvelope(this.data));
    return this.encode();
  }

  #encode(data?: Envelope | { body: Uint8Array }): string {
    return hexlify(
      cbor.encode({
        data: data ? data : undefined,
        leash: this.leash,
        signature: this.signature,
      }),
    );
  }
}

async function makeLeash(
  signer: Signer & TypedDataSigner,
  overrides?: LeashOverrides,
): Promise<Leash> {
  // simply invalidate signedCall caches if overrided nonce or block are provided
  if (overrides?.nonce !== undefined || overrides?.block !== undefined) {
    _cacheManager.clear();
  }

  const pendingNonceP = signer.getTransactionCount('pending');
  let blockP: Promisable<BlockId>;
  if (overrides?.block !== undefined) {
    blockP = overrides.block;
  } else {
    if (signer._checkProvider) signer._checkProvider('getBlock');
    const latestBlock = await signer.provider!.getBlock('latest');
    blockP = signer.provider!.getBlock(latestBlock.number - 2);
  }
  const [pendingNonce, block] = await Promise.all([pendingNonceP, blockP]);

  // check wether we should use cached leashes
  const chainId = await signer.getChainId();
  const cachedLeash = _cacheManager.getLeash(chainId);
  const blockRange = overrides?.blockRange ?? DEFAULT_BLOCK_RANGE;

  if (cachedLeash !== undefined) {
    // this happens only if neither overried nonce nor block are provided
    // so the pendingNonce and latestBlock are compared with the cachedLeash
    if (
      cachedLeash.nonce > pendingNonce &&
      cachedLeash.block_number + blockRange > block.number + 2
    ) {
      // the cached leash can be still re-usable
      return cachedLeash;
    } else {
      // the cached leash has been outdated
      _cachedManager.clear();
    }
  }

  return {
    nonce: overrides?.nonce ? overrides.nonce : nonce + DEFAULT_NONCE_RANGE,
    block_number: block.number,
    bock_hash: arrayify(block.hash),
    block_range: blockRange,
  };
}

export function makeSignableCall(call: EthCall, leash: Leash): SignableEthCall {
  return {
    from: call.from,
    to: call.to ?? zeroAddress(),
    gasLimit: BigNumber.from(
      call.gas ?? call.gasLimit ?? DEFAULT_GAS_LIMIT,
    ).toNumber(),
    gasPrice: BigNumber.from(call.gasPrice ?? DEFAULT_GAS_PRICE),
    value: BigNumber.from(call.value ?? DEFAULT_VALUE),
    data: call.data
      ? hexlify(call.data, { allowMissingPrefix: true })
      : DEFAULT_DATA,
    leash: {
      nonce: leash.nonce,
      blockNumber: leash.block_number,
      blockHash: leash.block_hash,
      blockRange: leash.block_range,
    },
  };
}

async function signCall(
  call: SignableEthCall,
  signer: Signer & TypedDataSigner,
  overrides?: Partial<{ chainId: number }>,
): Promise<Uint8Array> {
  const address = await signer.getAddress();
  const chainId = overrides?.chainId ?? (await signer.getChainId());
  const { domain, types } = signedCallEIP712Params(chainId);
  const hash = _TypedDataEncoder.hash(domain, types, call);
  let signature = _cacheManager.getSignatureCache(address, hash);
  if (signature !== undefined) return signature;
  signature = arrayify(await signer._signTypedData(domain, types, call));
  _cacheManager.cache(address, chainId, call, hash, signature);
  return signature;
}

export type PrepareSignedCallOverrides = Partial<{
  leash: LeashOverrides;
  chainId: number;
}>;

export type LeashOverrides = Partial<
  {
    nonce: number;
    blockRange: number;
  } & RequireExactlyOne<{
    block: BlockId;
    blockTag: BlockTag;
  }>
>;

export type EthCall = {
  /** 0x-prefixed hex-encoded address. */
  from: string;
  /** Optional 0x-prefixed hex-encoded address. */
  to?: string;
  value?: BigNumberish;
  gasPrice?: BigNumberish;
  data?: BytesLike;
} & Partial<
  RequireExactlyOne<{
    gas: number | string; // web3.js
    gasLimit: BigNumberish; // ethers
  }>
>;

/**
 * The structure passed to eth_signTypedData_v4.
 *
 * `uint256`, `address`, and `bytes` are required to be hex-stringified.
 */
export type SignableEthCall = {
  from: string;
  to: string;
  gasLimit?: number;
  gasPrice?: BigNumber;
  value?: BigNumber;
  data?: string;
  leash: CamelCasedProperties<Leash>;
};

export type Leash = {
  /** The largest sender account nonce whence the call will be valid. */
  nonce: number;
  /** The block number whence the call will be valid. */
  block_number: number; // uint64
  /** The expected block hash to be found at `block_number`. */
  block_hash: Uint8Array;
  /** The number of blocks past the block at `block_number` whence the call will be valid. */
  block_range: number; // uint64
};

export type BlockId = { hash: string; number: number };
