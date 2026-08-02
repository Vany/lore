#!/usr/bin/env node
/**
 * Entry point.
 *
 * The exit code is the API (SPEC §2.1). Every failure path lands here and exits
 * non-zero with a message, because a review that did not run is not a review that
 * found nothing — and this is the last place that distinction can be lost.
 */

import { main } from "./cli.ts";
import { EXIT, LoreError } from "./core/errors.ts";

export { main };

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      if (error instanceof LoreError) {
        console.error(`lore: ${error.message}`);
        process.exit(error.exitCode);
      }
      // Anything unexpected is still "did not run". Never a clean result.
      console.error(`lore: unexpected failure — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exit(EXIT.DID_NOT_RUN);
    });
}
