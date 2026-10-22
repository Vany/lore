// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The classic reentrancy: the balance is cleared AFTER the external call.
contract EtherStore {
    mapping(address => uint256) public balances;

    function deposit() public payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() public {
        uint256 bal = balances[msg.sender];
        require(bal > 0, "nothing");
        (bool sent, ) = msg.sender.call{value: bal}("");
        require(sent, "send failed");
        balances[msg.sender] = 0;
    }
}
