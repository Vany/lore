# EVM sandbox demos — 2026-10-20/21 (SPEC D-160, D-161)

The exact trees lore's EVM sandbox was demonstrated on. **The `*-vuln` contracts are
vulnerable ON PURPOSE** (reentrant withdraw; an unguarded sweep): they are fixtures, not code.

| tree | git tree hash of the demo repo | what it is |
|---|---|---|
| hardhat-vuln | `1ebd76f38c69ab5d3c612e6efedd1b9e2988ae05` | hardhat's public sample project (Lock + its TS tests), hardhat 2.22.19, OZ 4.9.6, solc 0.8.19 + 0.8.28, yarn v1 — plus `Vault` (reentrant `withdraw`, unguarded `sweep`) |
| hardhat-clean | `08e21699d8872b83c5d8dd98ff349706d352ae8a` | the same, `Vault` fixed (checks-effects-interactions, `onlyOwner` sweep) |
| foundry-vuln | `b3081a4f677f4ef7b80f9e60091ada499c889934` | the classic EtherStore reentrancy, forge-std as a submodule |
| foundry-clean | `c5d53e346029c4c5c54effd4111067bcab85db99` | its checks-effects-interactions twin |

The foundry trees pinned `lib/forge-std` as a submodule at `8e40513d678f392f398620b3ef2b418648b33e89`; to replay, `git init`, add
`https://github.com/foundry-rs/forge-std` at `lib/forge-std` and check that commit out. The hardhat
trees replay as they are (`yarn install --frozen-lockfile`). The tree hashes are `git write-tree` of
the demo repos as committed, so a rebuilt repo with these files at those paths reproduces them.

`poc/` holds the proofs: `Sweep.ts` (hardhat, TypeScript) and `Reenter.t.sol` (forge, against the
hardhat layout) — each CONFIRMED on hardhat-vuln and REFUTED on hardhat-clean; `Foundry-Reenter.t.sol`
did the same on the foundry pair.
