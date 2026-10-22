import { expect } from "chai";
import hre from "hardhat";

describe("LorePoc sweep access control", function () {
  it("a stranger cannot sweep depositors' funds", async function () {
    const [owner, alice, stranger] = await hre.ethers.getSigners();
    const vault = await hre.ethers.deployContract("Vault", [], owner);
    await vault.connect(alice).deposit({ value: 10n ** 18n });
    try {
      await vault.connect(stranger).sweep(stranger.address);
    } catch {
      // reverting is the safe outcome
    }
    expect(await hre.ethers.provider.getBalance(await vault.getAddress())).to.equal(10n ** 18n);
  });
});
