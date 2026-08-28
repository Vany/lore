/**
 * A review with no base (D-130): everything at a path, shown as a diff against
 * nothing, rather than against another ref.
 *
 * Real git, same reason `base-pin.test.ts` uses it: the claim is about what
 * `git diff` against the empty tree actually produces, and a fixture that models
 * git has already assumed the answer.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDiff, filesInDiff, renderDiff, wholeTreeDiff } from "./diff.ts";

let root: string;
let repo: string;

const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString().trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-wholetree-"));
  repo = join(root, "r");
  mkdirSync(repo, { recursive: true });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("wholeTreeDiff", () => {
  it("shows every tracked file as added, for the whole tree", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "src", "b.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "initial");

    const d = await wholeTreeDiff(repo, ".");
    expect([...d.changedFiles].sort()).toStrictEqual(["a.txt", "src/b.txt"]);
    expect(d.patch).toContain("+a");
    expect(d.patch).toContain("+b");
    expect(d.scopePath).toBe(".");
  });

  it("scopes to a subdirectory, leaving files outside it out of the diff", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "src", "in-scope.ts"), "x\n");
    writeFileSync(join(repo, "docs", "out-of-scope.md"), "y\n");
    g("add", "-A");
    g("commit", "-qm", "two directories");

    const d = await wholeTreeDiff(repo, "src");
    expect(d.changedFiles).toStrictEqual(["src/in-scope.ts"]);
    expect(d.patch).not.toContain("out-of-scope");
  });

  it("is empty for a path with nothing tracked at it", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "initial");

    const d = await wholeTreeDiff(repo, "nowhere");
    expect(d.changedFiles).toStrictEqual([]);
    expect(d.untracked).toStrictEqual([]);
    expect(d.patch.trim()).toBe("");
  });

  // D-132: file extension/path only, not diff content — the classifier a
  // documentation-only round is judged by.
  it("is docsOnly when every changed file is a doc", async () => {
    mkdirSync(join(repo, "spec"), { recursive: true });
    writeFileSync(join(repo, "SPEC.md"), "x\n");
    writeFileSync(join(repo, "spec", "notes.txt"), "y\n");
    g("add", "-A");
    g("commit", "-qm", "docs only");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.changedDocs).toBe(2);
    expect(d.docsOnly).toBe(true);
  });

  it("is not docsOnly when a source file is also changed", async () => {
    writeFileSync(join(repo, "SPEC.md"), "x\n");
    writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");
    g("add", "-A");
    g("commit", "-qm", "mixed");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.changedDocs).toBe(1);
    expect(d.docsOnly).toBe(false);
  });

  it("does not classify a test file as a doc", async () => {
    writeFileSync(join(repo, "a.test.ts"), "export const x = 1;\n");
    g("add", "-A");
    g("commit", "-qm", "test only");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.changedDocs).toBe(0);
    expect(d.changedTests).toBe(1);
    expect(d.docsOnly).toBe(false);
  });

  // INV-3: the diff includes uncommitted work in the review worktree. A single-ref
  // `git diff <empty-tree>` diffs against the WORKING TREE, not HEAD — same mechanism
  // computeDiff already relies on, exercised here for the empty-tree side specifically.
  it("includes uncommitted work, same as computeDiff (INV-3)", async () => {
    writeFileSync(join(repo, "committed.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "initial");
    writeFileSync(join(repo, "committed.txt"), "a\nb\n");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.patch).toContain("+b");
  });

  // INV-4: untracked files are invisible to `git diff` and must be named explicitly
  // rather than silently absent from what the reviewer is told exists.
  it("names untracked files by name, not by content (INV-4)", async () => {
    writeFileSync(join(repo, "tracked.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "initial");
    writeFileSync(join(repo, "new-file.txt"), "brand new\n");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.untracked).toStrictEqual(["new-file.txt"]);
    expect(d.changedFiles).toContain("new-file.txt");
    expect(d.patch).not.toContain("brand new");
  });

  // Found by lore's own review of D-130: `ls-files` C-quotes a control character,
  // backslash or literal quote in a filename unconditionally too — the same rule
  // already fixed for the patch (filesInDiff/unquoteGitPath) — but `untracked` had
  // no decoding applied at all, so an untracked file with a tab in its name would
  // have shown up as git's raw quoted string, quote marks included, both in the
  // list itself and (merged in) in changedFiles.
  it("names an untracked file containing a tab by its real name", async () => {
    writeFileSync(join(repo, "tracked.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "initial");
    writeFileSync(join(repo, "a\tb.txt"), "y\n");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.untracked).toContain("a\tb.txt");
    expect(d.changedFiles).toContain("a\tb.txt");
  });

  it("truncates a diff over the size ceiling and says so", async () => {
    writeFileSync(join(repo, "big.txt"), "x".repeat(700_000));
    g("add", "-A");
    g("commit", "-qm", "a very large file");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.truncated).toBe(true);
    expect(d.patch).toContain("DIFF TRUNCATED");
    expect(d.totalChars).toBeGreaterThan(700_000);
  });

  // Branch-only facts get an honest empty value, not an invented one — there is no
  // base for any of these to be measured against.
  it("carries honest empty values for everything a base would answer", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "initial");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.behindBy).toBe(0);
    expect(d.commits).toStrictEqual([]);
    expect(d.mergesClean).toBeUndefined();
    expect(d.overlap).toStrictEqual([]);
  });

  // Found by lore's own review of D-130: `git diff --name-only` lists a submodule as
  // its gitlink name only ("inner"), never the files inside it, even with
  // --submodule=diff — the workgroup's own stated shape (spec/review-ladder.md §6.1:
  // submodules, not monorepos), so this is not a hypothetical. A pattern-engine hit
  // inside a submodule used to read as outside `changedFiles`, get marked
  // `preexisting` (D-68) and demoted — a first-class finding silently buried as
  // inherited repository debt.
  it("lists files inside a submodule, not only its gitlink name", async () => {
    const innerRoot = join(root, "inner");
    mkdirSync(innerRoot, { recursive: true });
    const gInner = (...a: string[]) => execFileSync("git", a, { cwd: innerRoot, stdio: "pipe" }).toString().trim();
    gInner("init", "-q", "-b", "main");
    gInner("config", "user.email", "t@e.com");
    gInner("config", "user.name", "t");
    writeFileSync(join(innerRoot, "deep.txt"), "deep\n");
    gInner("add", "-A");
    gInner("commit", "-qm", "inner");

    writeFileSync(join(repo, "README.md"), "readme\n");
    g("-c", "protocol.file.allow=always", "submodule", "add", "-q", innerRoot, "inner");
    g("add", "-A");
    g("commit", "-qm", "outer, with a submodule");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.changedFiles).toContain("inner/deep.txt");
    expect(d.patch).toContain("inner/deep.txt");
  });

  // Found by lore's own review of src/git: `addWorktree` swallows a failed `git
  // submodule update --init` under a comment claiming the loss is "announced by the
  // diff layer" — nothing was. When a submodule's objects are missing (no credentials
  // for a private remote, D-65), `--submodule=diff` cannot expand it and git says so
  // INSIDE the patch: `Submodule <path> ...:` / `error: ...` / `(diff failed)`,
  // verified directly. That text reached every tier already, unamplified.
  it("names a submodule whose objects are missing, rather than silently showing a bare gitlink", async () => {
    const innerRoot = join(root, "inner-missing");
    mkdirSync(innerRoot, { recursive: true });
    const gInner = (...a: string[]) => execFileSync("git", a, { cwd: innerRoot, stdio: "pipe" }).toString().trim();
    gInner("init", "-q", "-b", "main");
    gInner("config", "user.email", "t@e.com");
    gInner("config", "user.name", "t");
    writeFileSync(join(innerRoot, "deep.txt"), "deep\n");
    gInner("add", "-A");
    gInner("commit", "-qm", "inner");

    g("-c", "protocol.file.allow=always", "submodule", "add", "-q", innerRoot, "inner");
    g("add", "-A");
    g("commit", "-qm", "outer, with a submodule");
    g("submodule", "deinit", "-f", "inner");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.submoduleExpansionFailed).toContain("inner");
    expect(renderDiff(d)).toContain("could not be expanded");
  });

  // Found by lore's own review of D-130: git C-style-quotes a path needing it, which
  // by default is any non-ASCII name — `+++ "b/src/caf\303\251.ts"`, verified
  // directly — and filesInDiff's plain `+++ b/<path>` match does not un-quote it.
  // A tracked AND an untracked non-ASCII filename both exercise this: the tracked
  // one through the patch, the untracked one through `ls-files`.
  it("lists a non-ASCII filename by its real name, not git's quoted form", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "café.ts"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "a file with a non-ASCII name");
    writeFileSync(join(repo, "naïve.txt"), "y\n");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.changedFiles).toContain("src/café.ts");
    expect(d.changedFiles).toContain("naïve.txt");
    expect(d.untracked).toContain("naïve.txt");
    expect(d.patch).not.toContain("\\303");
  });

  // Found by lore's own review of D-130, HIGH severity, a second time on this same
  // shape: core.quotePath=false only turns off quoting for a NON-ASCII path — a
  // control character, a backslash or a literal quote in a filename is quoted
  // UNCONDITIONALLY, config or not (`+++ "b/src/a\tb.ts"`, verified directly), and
  // the config flag alone does not touch that. filesInDiff now decodes git's C-style
  // quoting itself rather than relying only on asking git not to use it.
  it("lists a filename containing a tab, which git quotes unconditionally", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a\tb.ts"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "a file with a tab in its name");

    const d = await wholeTreeDiff(repo, ".");
    expect(d.changedFiles).toContain("src/a\tb.ts");
  });

  // Found by lore's own review of D-130: filesInDiff is not only fed wholeTreeDiff's
  // own output (always unquoted for non-ASCII, by the flag above) — review_submit
  // also runs it on a CLIENT-SUPPLIED diff, generated under whatever git config the
  // client has, which is core.quotePath=true (git's own default) unless they set it
  // otherwise. A first version of the decoder converted one \NNN escape to one JS
  // code unit, correct only for a single-byte escape — but a non-ASCII character is
  // SEVERAL octal-escaped bytes together ("café.ts" as \303\251 is two bytes making
  // one codepoint, not two characters), and decoding them one at a time produced
  // mojibake ("Ã©") instead of the real name. Real git output, default config —
  // deliberately NOT passing core.quotePath=false, to get exactly what a client's
  // own git would send.
  it("decodes a client-supplied diff's octal-quoted non-ASCII name correctly, not byte-by-byte", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "café.ts"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "a file with a non-ASCII name");

    const clientDiff = execFileSync(
      "git",
      ["diff", "--no-color", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "--", "."],
      { cwd: repo, stdio: "pipe" },
    ).toString();
    expect(clientDiff, "this test means to exercise the quoted form").toContain('\\303\\251');

    expect(filesInDiff(clientDiff)).toContain("src/café.ts");
  });
});

// Found by lore's own review of src/git (D-130 folder mode): computeDiff, wholeTreeDiff's
// older sibling in this same file, never got the D-130 quoting fix ported back to it —
// `ls-files` and `diff --name-only` ran with no `-c core.quotePath=false` and no
// `unquoteGitPath`, so `untracked` and `changedFiles` would have carried git's literal
// C-quoted, octal-escaped string instead of the real name for exactly the cases pinned
// above for wholeTreeDiff.
describe("computeDiff carries the same quoting fix wholeTreeDiff does", () => {
  it("names an untracked non-ASCII file by its real name, not git's quoted form", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "initial");
    writeFileSync(join(repo, "naïve.txt"), "y\n");

    const d = await computeDiff(repo, "main");
    expect(d.untracked).toContain("naïve.txt");
    expect(d.changedFiles).toContain("naïve.txt");
  });

  it("names a tracked, modified non-ASCII file by its real name in changedFiles", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "café.ts"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "a file with a non-ASCII name");
    writeFileSync(join(repo, "src", "café.ts"), "x\ny\n");

    const d = await computeDiff(repo, "main");
    expect(d.changedFiles).toContain("src/café.ts");
  });

  // Found by lore's own review of src/git: the first pass of this fix decoded
  // changedFilesFrom but left baseTouched (the OTHER side of the overlap comparison,
  // `diff --name-only liveBase resolved`) raw — so a non-ASCII name touched by both
  // sides decoded on one side only, `.has()` failed, and the overlap this field exists
  // to flag went silently missing for exactly the names the fix was about.
  it("finds a non-ASCII file both sides touched, in overlap", async () => {
    writeFileSync(join(repo, "café.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "base");
    g("checkout", "-qb", "feature");
    writeFileSync(join(repo, "café.txt"), "a\nbranch\n");
    g("add", "-A");
    g("commit", "-qm", "branch touches café.txt");
    g("checkout", "-q", "main");
    writeFileSync(join(repo, "café.txt"), "a\nmain-side\n");
    g("add", "-A");
    g("commit", "-qm", "main also touches café.txt");
    g("checkout", "-q", "feature");

    const d = await computeDiff(repo, "main");
    expect(d.overlap.map((o) => o.file)).toContain("café.txt");
  });

  // Sibling of wholeTreeDiff's identical test above: computeDiff shares the same
  // `submodulesThatFailedToExpand` detection, wired in separately since it is a
  // separate function with its own `rawPatch`. Two commits directly on `main`, HEAD
  // left at the second — the exact shape verified manually before writing the fix.
  it("names a submodule bump whose objects are missing, rather than silently showing a bare gitlink", async () => {
    const innerRoot = join(root, "inner-bump-missing");
    mkdirSync(innerRoot, { recursive: true });
    const gInner = (...a: string[]) => execFileSync("git", a, { cwd: innerRoot, stdio: "pipe" }).toString().trim();
    gInner("init", "-q", "-b", "main");
    gInner("config", "user.email", "t@e.com");
    gInner("config", "user.name", "t");
    writeFileSync(join(innerRoot, "f.txt"), "a\n");
    gInner("add", "-A");
    gInner("commit", "-qm", "commit A");
    const commitA = gInner("rev-parse", "HEAD");
    writeFileSync(join(innerRoot, "f.txt"), "a\nb\n");
    gInner("add", "-A");
    gInner("commit", "-qm", "commit B");
    const commitB = gInner("rev-parse", "HEAD");

    g("-c", "protocol.file.allow=always", "submodule", "add", "-q", innerRoot, "inner");
    execFileSync("git", ["checkout", "-q", commitA], { cwd: join(repo, "inner"), stdio: "pipe" });
    g("add", "-A");
    g("commit", "-qm", "add submodule, pinned at A");

    execFileSync("git", ["checkout", "-q", commitB], { cwd: join(repo, "inner"), stdio: "pipe" });
    g("add", "-A");
    g("commit", "-qm", "bump submodule to B");
    g("submodule", "deinit", "-f", "inner");

    const d = await computeDiff(repo, "main~1");
    expect(d.submoduleExpansionFailed).toContain("inner");
    expect(renderDiff(d)).toContain("could not be expanded");
  });

  // Found by lore's own review of src/git: `--name-only` lists a submodule bump as its
  // bare gitlink name only, never the files inside it, even though `--submodule=diff`
  // expands the inner content into the patch — the exact gap wholeTreeDiff was already
  // fixed for. Swapping outright would have lost every deletion (filesInDiff only
  // matches `+++ b/<path>`, never `/dev/null`), so both are checked together.
  it("names files inside a bumped submodule in changedFiles, and still names a deleted file", async () => {
    const innerRoot = join(root, "inner-changedfiles");
    mkdirSync(innerRoot, { recursive: true });
    const gInner = (...a: string[]) => execFileSync("git", a, { cwd: innerRoot, stdio: "pipe" }).toString().trim();
    gInner("init", "-q", "-b", "main");
    gInner("config", "user.email", "t@e.com");
    gInner("config", "user.name", "t");
    writeFileSync(join(innerRoot, "f.txt"), "a\n");
    gInner("add", "-A");
    gInner("commit", "-qm", "commit A");
    const commitA = gInner("rev-parse", "HEAD");
    writeFileSync(join(innerRoot, "f.txt"), "a\nb\n");
    gInner("add", "-A");
    gInner("commit", "-qm", "commit B");
    const commitB = gInner("rev-parse", "HEAD");

    writeFileSync(join(repo, "remove.txt"), "gone soon\n");
    g("-c", "protocol.file.allow=always", "submodule", "add", "-q", innerRoot, "inner");
    execFileSync("git", ["checkout", "-q", commitA], { cwd: join(repo, "inner"), stdio: "pipe" });
    g("add", "-A");
    g("commit", "-qm", "add submodule at A, and a file to remove later");

    execFileSync("git", ["checkout", "-q", commitB], { cwd: join(repo, "inner"), stdio: "pipe" });
    g("rm", "-q", "remove.txt");
    g("add", "-A");
    g("commit", "-qm", "bump submodule to B, remove a file");

    const d = await computeDiff(repo, "main~1");
    expect(d.changedFiles).toContain("inner/f.txt");
    expect(d.changedFiles).toContain("remove.txt");
  });
});

describe("renderDiff in folder mode", () => {
  it("frames this as a full read, not a diff against a prior version", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "initial");

    const rendered = renderDiff(await wholeTreeDiff(repo, "."));
    expect(rendered).toContain("FULL READ");
    expect(rendered).not.toContain("THIS DIFF IS THE CHANGE THE BRANCH INTRODUCES");
    expect(rendered).not.toContain("THIS BRANCH IS");
    expect(rendered).not.toContain("fork point");
  });

  // Found by lore's own review of D-130: the header used to run the whole sentence
  // through .toUpperCase(), which corrupted the interpolated path itself
  // ("src/PayRoll" printed as "SRC/PAYROLL") — a nonexistent path on a case-sensitive
  // filesystem, in the one sentence whose job is telling a tier what to (re-)read.
  // A mixed-case path and the HEADER LINE specifically, not the whole render: the
  // original test asserted only rendered.toContain("src"), which the patch body
  // ("+++ b/src/a.txt") satisfies regardless of what the header itself says.
  it("names the scoped path in the header, in its real case", async () => {
    mkdirSync(join(repo, "src", "PayRoll"), { recursive: true });
    writeFileSync(join(repo, "src", "PayRoll", "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "initial");

    const rendered = renderDiff(await wholeTreeDiff(repo, "src/PayRoll"));
    const header = rendered.split("\n")[0] ?? "";
    expect(header).toContain("src/PayRoll");
    expect(header).not.toContain("SRC/PAYROLL");
  });

  // The untracked list, the truncation notice and the patch itself are shared
  // rendering, exercised already for branch mode (base-pin.test.ts's siblings) —
  // checked here only for the one thing that differs: they still appear at all.
  it("still lists untracked files and the patch itself", async () => {
    writeFileSync(join(repo, "tracked.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "initial");
    writeFileSync(join(repo, "untracked.txt"), "b\n");

    const rendered = renderDiff(await wholeTreeDiff(repo, "."));
    expect(rendered).toContain("UNTRACKED");
    expect(rendered).toContain("untracked.txt");
    expect(rendered).toContain("--- DIFF ---");
  });
});
