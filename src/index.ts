#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Scaffold only. It throws rather than returning a plausible result, because the
 * one thing this tool must never do is let "did not run" read as "found nothing"
 * (SPEC INV-1). A stub that exited 0 would be exactly that failure, shipped on
 * day one.
 *
 * Implementation order is TODO.md T5→T8: pure core first, then the git and
 * opencode boundaries, then this file.
 */

export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet — see TODO.md`);
    this.name = "NotImplemented";
  }
}

export function main(_argv: readonly string[]): never {
  throw new NotImplemented("lore");
}

// import.meta.main is node >=24; true only when this file is the entry point,
// so importing it from a test does not run the CLI.
if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(70); // EX_SOFTWARE — "did not run", distinct from any verdict.
  }
}
