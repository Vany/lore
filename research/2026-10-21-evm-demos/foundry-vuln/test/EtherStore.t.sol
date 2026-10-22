// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EtherStore} from "../src/EtherStore.sol";

contract EtherStoreTest is Test {
    EtherStore store;

    function setUp() public {
        store = new EtherStore();
    }

    function test_depositThenWithdraw() public {
        vm.deal(address(this), 1 ether);
        store.deposit{value: 1 ether}();
        store.withdraw();
        assertEq(store.balances(address(this)), 0);
    }

    receive() external payable {}
}
