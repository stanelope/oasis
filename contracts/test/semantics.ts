// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'hardhat';
import { expect } from 'chai';
import { SemanticTests } from '../typechain-types/contracts/tests/SemanticTests';
import { SemanticTests__factory } from '../typechain-types/factories/contracts/tests';

const ERROR_NUM =
  '0x1023456789abcdef1023456789abcdef1023456789abcdef1023456789abcdef';

describe('EVM Semantics', () => {
  let c: SemanticTests;
  let chainId: number;

  before(async () => {
    const f = (await ethers.getContractFactory(
      'SemanticTests',
    )) as SemanticTests__factory;
    c = await f.deploy();
    await c.deployed();
    chainId = (await c.provider.getNetwork()).chainId;
  });

  it('eth_call maximum return length vs gas limit', async () => {
    if (chainId != 31337) {
      const i = 1787872;
      const respHex = await c.testViewLength(i);
      const respBytes = ethers.utils.arrayify(respHex);
      expect(respBytes.length).eq(i);
      expect(c.testViewLength(i + 1)).reverted;
    }
  });

  it('Error string in view call', async () => {
    try {
      await c.testViewRevert();
    } catch (x: any) {
      expect(x.errorArgs[0]).to.eq('ThisIsAnError');
      expect(x.errorName).to.eq('Error');
    }
  });

  it('Custom revert in view call', async () => {
    // Perform view call, which is expected to revert
    try {
      await c.testCustomViewRevert();
      expect(false).to.be.true;
    } catch (x: any) {
      expect(x.errorArgs[0]).to.eq(ERROR_NUM);
      expect(x.errorName).to.eq('CustomError');
    }
  });
});
