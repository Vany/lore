import { expect } from "chai";
import hre from "hardhat";

describe("Vault", function () {
  it("returns a deposit", async function () {
    const [user] = await hre.ethers.getSigners();
    const vault = await hre.ethers.deployContract("Vault");
    await vault.connect(user).deposit({ value: 1000n });
    await vault.connect(user).withdraw();
    expect(await vault.balances(user.address)).to.equal(0n);
  });
});
