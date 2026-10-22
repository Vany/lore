// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Checks-effects-interactions: the balance is cleared BEFORE the external call.
contract EtherStore {
    mapping(address => uint256) public balances;

    event Deposited(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw() external {
        uint256 bal = balances[msg.sender];
        require(bal > 0, "nothing");
        balances[msg.sender] = 0;
        emit Withdrawn(msg.sender, bal);
        (bool sent, ) = msg.sender.call{value: bal}("");
        require(sent, "send failed");
    }
}
