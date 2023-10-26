import { expect } from 'chai';
import { randomBytes, createHash } from 'crypto';
import { ethers } from 'hardhat';
import { HashTests } from '../typechain-types/contracts/tests/HashTests';
import { HashTests__factory } from '../typechain-types/factories/contracts/tests';
import { PromiseOrValue } from '../typechain-types/common';
import { BytesLike, CallOverrides } from 'ethers';

type HasherTestT = (
  data: PromiseOrValue<BytesLike>,
  overrides?: CallOverrides | undefined,
) => Promise<string>;

describe('Hashes', () => {
  let contract: HashTests;

  before(async () => {
    const factory = (await ethers.getContractFactory(
      'HashTests',
    )) as HashTests__factory;
    contract = await factory.deploy();
    await contract.deployed();
  });

  async function testHashes(algname: string, method: HasherTestT) {
    for (let i = 0; i < 512; i += 64) {
      const data = randomBytes(i);
      const hash = createHash(algname).update(data).digest('hex');
      const result = await method(data);
      expect(result).eq('0x' + hash);
    }
  }

  it('SHA512-256', async () => {
    testHashes('SHA512-256', contract.testSHA512_256.bind(contract));
  });

  it('SHA512', async () => {
    testHashes('SHA512', contract.testSHA512.bind(contract));
  });

  it('SHA384', async () => {
    testHashes('SHA384', contract.testSHA384.bind(contract));
  });
});
