/**
 * One answer to "the caller meant nothing here", for every optional field we parse.
 *
 * Zod's `.optional()` short-circuits on `undefined` and nothing else, so a `null`
 * falls through to the inner type and fails it. That matters because almost every
 * caller here is a language model — the reviewer tiers writing findings, and the
 * client driving the review over MCP — and a model with nothing to put in a field
 * writes `null` at least as readily as it omits the key. `null` is the natural JSON
 * for absent.
 *
 * The cost of getting it wrong is not one bad field. `FindingSchema` is `.strict()`
 * inside a batch parse, so a single `null` discards every finding in a reply that has
 * already been paid for; on the MCP surface it is a hard validation error handed back
 * to an agent that did nothing wrong.
 *
 * This exists as a shared helper rather than as a fix at each site because it was
 * once fixed at a site: `cwe` got a preprocess and the reasoning was written down
 * beside it, and `symbol`, `line`, and every optional argument on the MCP tools kept
 * the defect. It went off — `symbol: null`, twice, and a whole review failed.
 *
 * Blank is forgiven; WRONG is still rejected. `symbol: 42` and `line: "top"` fail as
 * before, because those are our prompt and the caller disagreeing about the shape,
 * which is drift worth failing on.
 */

import * as z from "zod";

export const absent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
    inner.optional(),
  );
