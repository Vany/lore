/**
 * What a `yarn.lock` pins, for the SBOM when cdxgen is not available.
 *
 * WHY IT EXISTS: the deployment has no cdxgen, and the fallback read `package-lock.json`
 * only — so a yarn project's dependency tree was "could not be enumerated", and its
 * OpenZeppelin and hardhat-upgrades advisories were never queried. Ethereum projects are
 * very often yarn projects, and the first real target is one.
 *
 * Both formats: classic v1 (`version "4.9.6"`) and berry (`version: 4.9.6`, with a
 * `__metadata` block and `@npm:` descriptors). Workspace and link entries are the project's
 * own packages, not dependencies, and are skipped. Pure, so each shape has a test.
 */

export interface LockedPackage {
  readonly name: string;
  readonly version: string;
}

/** `name@range` (or `name@npm:range`) → `name`, scoped names included. */
function nameOf(descriptor: string): string | undefined {
  const d = descriptor.trim().replace(/^"|"$/g, "");
  const at = d.lastIndexOf("@");
  if (at <= 0) return undefined;
  return d.slice(0, at);
}

/** Every pinned package, once per name@version. `undefined` when the text is not a yarn lockfile. */
export function parseYarnLock(text: string): readonly LockedPackage[] | undefined {
  const berry = /^__metadata:\s*$/m.test(text);
  if (!berry && !/^# yarn lockfile v1\s*$/m.test(text)) return undefined;
  const out: LockedPackage[] = [];
  const seen = new Set<string>();
  let name: string | undefined;
  let skip = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      // A new entry: `"a@^1", "a@^1.2":` — every descriptor names the same package.
      const first = line.replace(/:\s*$/, "").split(/,\s*/)[0] ?? "";
      name = first === "__metadata" ? undefined : nameOf(first);
      skip = /@(?:workspace|link|portal|file):/.test(line);
      continue;
    }
    if (name === undefined || skip) continue;
    const v = berry ? /^ {2}version: "?([^"\s]+)"?\s*$/.exec(line)?.[1] : /^ {2}version "([^"]+)"\s*$/.exec(line)?.[1];
    if (v === undefined) continue;
    const key = `${name}@${v}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ name, version: v });
    }
    name = undefined;
  }
  return out;
}
