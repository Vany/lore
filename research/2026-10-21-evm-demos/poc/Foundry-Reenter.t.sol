// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EtherStore} from "../src/EtherStore.sol";

contract Attacker {
    EtherStore immutable store;
    constructor(EtherStore s) { store = s; }
    function attack() external payable {
        store.deposit{value: msg.value}();
        store.withdraw();
    }
    receive() external payable {
        if (address(store).balance >= 1 ether) store.withdraw();
    }
}

/// Asserts the SAFE behaviour: an attacker who deposits 1 ether leaves the other
/// depositors' 2 ether in the store. Fails exactly when withdraw() can be re-entered.
contract ReentrancyPoc is Test {
    function test_attackerCannotDrainOthers() public {
        EtherStore store = new EtherStore();
        vm.deal(address(0xA11CE), 2 ether);
        vm.prank(address(0xA11CE));
        store.deposit{value: 2 ether}();
        Attacker a = new Attacker(store);
        vm.deal(address(this), 1 ether);
        try a.attack{value: 1 ether}() {} catch {}
        assertEq(address(store).balance, 2 ether, "other depositors' funds were drained");
    }
}
