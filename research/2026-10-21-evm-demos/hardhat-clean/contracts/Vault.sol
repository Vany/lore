// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";

/// The same vault, fixed: checks-effects-interactions, and sweep() is the owner's alone.
contract Vault is Ownable {
    mapping(address => uint256) public balances;

    event Deposited(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw() external {
        uint256 bal = balances[msg.sender];
        require(bal > 0, "nothing");
        balances[msg.sender] = 0;
        emit Withdrawn(msg.sender, bal);
        (bool ok, ) = msg.sender.call{value: bal}("");
        require(ok, "send failed");
    }

    function sweep(address payable to) external onlyOwner {
        uint256 amount = address(this).balance;
        emit Swept(to, amount);
        to.transfer(amount);
    }
}
