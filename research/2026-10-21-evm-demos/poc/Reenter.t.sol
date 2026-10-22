// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../contracts/Vault.sol";

contract Attacker {
    Vault immutable vault;
    constructor(Vault v) { vault = v; }
    function attack() external payable {
        vault.deposit{value: msg.value}();
        vault.withdraw();
    }
    receive() external payable {
        if (address(vault).balance >= 1 ether) vault.withdraw();
    }
}

contract ReentrancyPoc is Test {
    function test_attackerCannotDrainOthers() public {
        Vault vault = new Vault();
        vm.deal(address(0xA11CE), 2 ether);
        vm.prank(address(0xA11CE));
        vault.deposit{value: 2 ether}();
        Attacker a = new Attacker(vault);
        vm.deal(address(this), 1 ether);
        try a.attack{value: 1 ether}() {} catch {}
        assertEq(address(vault).balance, 2 ether, "other depositors' funds were drained");
    }
}
