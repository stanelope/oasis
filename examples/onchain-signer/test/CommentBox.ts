import { expect } from 'chai';
import { ethers, config } from 'hardhat';
import { CommentBox, Gasless } from '../typechain-types';
import { EthereumKeypairStruct } from "../typechain-types/contracts/Gasless"
import { parseEther } from 'ethers/lib/utils';
import { HDAccountsUserConfig } from 'hardhat/types';

describe('CommentBox', function () {
  let commentBox: CommentBox;
  let gasless: Gasless;

  before(async () => {
    // Derive the private key of the 1st (counting from 0) builtin hardhat test account.
    const accounts = config.networks.hardhat
      .accounts as unknown as HDAccountsUserConfig;
    const wallet1 = ethers.Wallet.fromMnemonic(
      accounts.mnemonic,
      accounts.path + `/1`,
    );

    // Use it as the relayer private key.
    // NOTE can be done by the contract with EthereumUtils.generateKeypair()
    const keypair : EthereumKeypairStruct = {
      addr: wallet1.address,
      secret: wallet1.privateKey,
      nonce: ethers.provider.getTransactionCount(wallet1.address),
    };

    const CommentBoxFactory = await ethers.getContractFactory('CommentBox');
    commentBox = await CommentBoxFactory.deploy();
    await commentBox.deployed();

    const GaslessFactory = await ethers.getContractFactory('Gasless');
    gasless = await GaslessFactory.deploy(keypair, {value: parseEther('0.1')});
    await gasless.deployed();
  });

  it('Should comment', async function () {
    const prevCommentCount = await commentBox.commentCount();

    const tx = await commentBox.comment('Hello, world!');
    await tx.wait();

    // Sapphire Mainnet/Testnet: Wait a few moments for nodes to catch up.
    if (
      (await gasless.provider.getNetwork()).chainId == 23294 ||
      (await gasless.provider.getNetwork()).chainId == 23295
    ) {
      await new Promise((r) => setTimeout(r, 6_000));
    }

    expect(await commentBox.commentCount()).eq(prevCommentCount.add(1));
  });

  it('Should comment gasless', async function () {
    // You can set up sapphire-dev image and run the test like this:
    // docker run -it -p8545:8545 -p8546:8546 ghcr.io/oasisprotocol/sapphire-dev -to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
    // npx hardhat test --grep proxy --network sapphire-localnet
    if ((await gasless.provider.getNetwork()).chainId == 1337) {
      this.skip();
    }

    const innercall = commentBox.interface.encodeFunctionData('comment', [
      'Hello, free world!',
    ]);

    // Sapphire Mainnet/Testnet: Wait a few moments for nodes to catch up.
    if (
      (await gasless.provider.getNetwork()).chainId == 23294 ||
      (await gasless.provider.getNetwork()).chainId == 23295
    ) {
      await new Promise((r) => setTimeout(r, 6_000));
    }

    const tx = await gasless.makeProxyTx(commentBox.address, innercall);

    // TODO: https://github.com/oasisprotocol/sapphire-paratime/issues/179
    const response = await gasless.provider.sendTransaction(tx);
    const receipt = await gasless.provider.waitForTransaction(response.hash);
    if (!receipt || receipt.status != 1) throw new Error('tx failed');
  });
});
