/**
 * Reading a repo's own documents into rules.
 *
 * A team's `CLAUDE.md` and `PROG.md` already state what it enforces. Making a model
 * rediscover that by watching reviews fail would be slow, expensive, and worse —
 * the docs say it outright.
 *
 * **The hazard was accepted knowingly, so the mitigation is mandatory.** A stale
 * document becomes a confidently wrong rule, injected into every future session and
 * every future review. So each rule records the blob it came from, and when that
 * blob changes the rules are **re-derived, never retained** (D-20). A rule must not
 * outlive the text that justified it.
 *
 * Extraction is deterministic on purpose. A model would extract better rules, but
 * this runs on every document change, must be free, and must give the same answer
 * twice — and D-8 says not to pay a model for what a rule can decide.
 *
 * SPEC: spec/knowledge.md §2
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { blobSha, readAtRef } from "../git/diff.ts";
import type { KnowledgeItem, Store } from "../store/store.ts";

/** Documents that state a project's rules, in the order a reader would trust them. */
const RULE_DOCS = [
  "CLAUDE.md",
  "AGENTS.md",
  "PROG.md",
  "SPEC.md",
  "CONTRIBUTING.md",
  ".cursorrules",
] as const;

export const RULE_DIRS = ["docs/adr", "docs/decisions", "spec", "adr"] as const;

/**
 * Words that turn a sentence into an instruction.
 *
 * Deliberately narrow. Sweeping up every declarative sentence would fill the
 * knowledge base with prose, and a knowledge base nobody trusts is one nobody
 * reads.
 */
const MODAL = /\b(must not|must|never|always|do not|don't|shall|required|forbidden|prefer|avoid)\b/i;

/** Prose that looks like a rule but is about the document, not the code. */
const NOT_A_RULE = /^(see |read |this (file|document|section)|table of contents)/i;

/**
 * A statement that cannot stand alone is not a rule — it is a piece of one.
 *
 * Every row here is shown to a model under *"WHAT THIS CODEBASE ALREADY KNOWS ABOUT
 * ITSELF — treat these as this team's decisions"*, with nothing around it. So the test
 * is exactly that: read alone, does it say something?
 *
 * Two shapes fail, and both were in the live store:
 *
 *   * **A dangling referent.** "It has to be, because the secret is shown once", "This
 *     retires the refusal in D-55", "A required field is therefore free money". The
 *     subject was in the sentence before, which was not captured, so the model is free
 *     to bind it to whatever it happens to be reading.
 *   * **A mid-sentence start.** "matching the line refused the corrected file",
 *     "dropping any line containing a negation let the original through" — a clause
 *     lifted out of a sentence whose beginning is gone.
 *
 * Deliberately not a grammar check. These two catch what was actually there, and a
 * cleverer test would start rejecting real rules, which costs more than it saves: a
 * rule that never arrives is invisible, while a fragment is at least legible as noise.
 *
 * They are asked DIFFERENT questions of different text, which is not an accident.
 * A dangling referent is about meaning, so it reads the stripped text — `**It** has
 * to be` is the same fault as `It has to be`. A mid-sentence start is about how the
 * author wrote it, so it reads the text as written: a rule opening on a code span is
 * the author starting a statement, and judging it after the backticks are gone
 * refused a real rule for beginning with a lowercase `f`.
 */
const NOT_SELF_CONTAINED = /^(it|its|this|that|these|those|they|their|then|so|therefore|and|but|which|hence|thus)\b/i;
const STARTS_MID_SENTENCE = /^[a-z]/;

/**
 * The EXTRACTOR's version — the deterministic half of what a row's reader was.
 *
 * BUMP THIS whenever `extractRules` changes what it accepts. Rules carrying an older
 * stamp are retired on the next ingest and re-extracted, exactly as a rule is retired
 * when its document changes (D-20) — because a rule must not outlive the reader that
 * produced it any more than it may outlive the text.
 *
 * `2` is the narrowing that stopped mining narrative paragraphs: measured 2026-08-06,
 * SPEC.md produced 111 rules and 108 of them came from prose, arriving as fragments
 * whose subjects were in sentences that were never captured. Under `2` the same document
 * gave 15 — a hundredfold-smaller share of narrative, which is the point, and NOT a
 * standing figure: SPEC.md is edited most sessions, so a bare "it yields N" here is
 * wrong within a day. It was 8 in one comment and 15 in three others by the time a
 * review noticed, and the true answer that morning was 18. Dates, not counts.
 *
 * `4` makes a BULLET ONE STATEMENT — first sentence the rule, the rest its `why` — and
 * adds the lead-in, label and gerund-head refusals. Before it, a bullet was taken whole
 * and then split back into sentences, so every multi-sentence bullet shed its tail as a
 * free-standing "team decision" and the reason a rule exists was discarded in the same
 * motion. Measured on this repository: `why` coverage 5 of 66 -> 30 of 58.
 *
 * `3` asks the mid-sentence guard about the text as WRITTEN rather than about the
 * markup-stripped text, which `2` had been silently refusing real rules over — a
 * statement opening on a code span reduced to a lowercase word and was thrown away as a
 * lifted clause. The bump is what brings those back: the rows `2` never wrote are not
 * recoverable by editing a document, only by the reader changing and saying so.
 */
const EXTRACT_VERSION = "4";

/**
 * The SCREEN's version, and it is half of what decides which rules live (D-81).
 *
 * BUMP THIS whenever `screenPrompt`, the refusal contract, or which tier is asked
 * changes what the screen throws away.
 *
 * It needs its own number because the reader that produces a row is now two readers, and
 * versioning only the first recreates the exact trap the first version was built to close.
 * `extractRules` could change and retire what it wrote; the screen could change and
 * nothing happened — unchanged documents would keep an old screen's vetoes for ever, a
 * wrongly-refused rule staying invisible in precisely the way the decontextualised
 * fragments did before any stamp existed. And the next planned change to this code is
 * "measure the screen, then improve the prompt", which walks straight into it.
 *
 * `1` is the first screen: refuse-by-number, one batched call per document, cheapest
 * model tier.
 */
const SCREEN_VERSION = "1";

/**
 * What is written to `knowledge.extractor`, and what retirement compares.
 *
 * Both halves, so a change to either retires what the pair produced. Read as one opaque
 * token everywhere else — nothing outside this file should be parsing it apart, because
 * the moment something does, the two versions have to agree about a format as well.
 *
 * lore-ok[666e3353]: this is that fix. The screen was unversioned and the finding was
 * right that it recreated D-20's trap one layer up — a prompt or tier change would have
 * left every stored veto in place for ever. `SCREEN_VERSION` above is the second half
 * and this is what retirement now compares, so a change to either reader retires what
 * the pair produced.
 */
export const EXTRACTOR_VERSION = `${EXTRACT_VERSION}.${SCREEN_VERSION}`;

const MIN_LENGTH = 20;
const MAX_LENGTH = 280;

/**
 * The stamp for rows written when the screen COULD NOT RUN.
 *
 * A distinct value rather than a flag column, so it heals through machinery that already
 * exists: `retireForChangedBlob` is called with `EXTRACTOR_VERSION`, sees a row that does
 * not carry it, and retires it — so the next ingest re-extracts and re-screens. Keeping
 * the unscreened rows is deliberate (a repository with no memory is worse than one with
 * some fragments in it), and this is what stops "deliberate" from turning into "for ever".
 */
export const UNSCREENED = `${EXTRACTOR_VERSION}-unscreened`;

export interface Candidate {
  readonly statement: string;
  readonly why: string | undefined;
}

/** A candidate the screen threw away, and the reason it gave for it. */
export interface Refusal {
  readonly statement: string;
  readonly because: string;
}

export interface Screened {
  readonly kept: readonly Candidate[];
  readonly refused: readonly Refusal[];
  /**
   * False when the screen could not run at all.
   *
   * NOT the same as "refused nothing", and conflating them is how a broken classifier
   * would read as an approving one. The caller stamps the rows differently so the next
   * ingest tries again.
   */
  readonly ran: boolean;
  /**
   * When the provider said its limit lifts, ISO — present only when it said so (D-91).
   *
   * Carried out of the screen rather than logged, because the caller is the only thing
   * that can act on it: it decides when to ask again, and a guess there costs either a
   * 45-minute hang or hours of a working tier left unused. Absent means nobody told us,
   * and the caller falls back to its own backoff.
   */
  readonly retryAfter?: string;
  /**
   * True when the TIER could not answer, false when this DOCUMENT was the problem.
   *
   * `ran: false` said only "nothing was screened" and meant both, which is a real
   * difference: D-87 stops the pass for a tier fault and deliberately does not for a
   * `TooLargeForTier`, because the next document may be a tenth the size. Without this
   * flag, one oversized document ended the pass AND marked a perfectly healthy tier
   * unavailable for an hour.
   */
  readonly tierFault?: boolean;
}

/**
 * A veto over what was mined, applied per document.
 *
 * Injected rather than imported, so `ingestDocs` stays free and deterministic wherever
 * no model is configured — the CLI's pure paths, the tests, and any deployment that
 * would rather have the fragments than the spend. Absent, every candidate is kept and
 * stamped `UNSCREENED`.
 */
export type Screen = (doc: string, candidates: readonly Candidate[]) => Promise<Screened>;

/**
 * A LEAD-IN IS NOT A RULE. "Two things a client must get right, both of which fail
 * silently:" announces what follows and arrives without it; `Arguments: branch
 * (required), into (required)` is a label line whose `required` trips the modal test.
 * Both were live, and both are shapes a regex can name — unlike the residue the model
 * screen exists for (D-81), which differs by what the words MEAN.
 */
const LEAD_IN = /:$/;
const LABEL = /^[A-Z][a-z]+:\s/;

/**
 * A bullet whose first sentence NAMES AN APPROACH rather than states a rule.
 *
 * "Counting the reply's own step-start parts reads one however far the agent went",
 * "Watching opencode's event stream … degrades in silence" — both are accounts of a
 * tried-and-rejected implementation, and both arrived as confident team decisions.
 */
const GERUND_HEAD = /^[A-Z][a-z]+ing\b/;

/**
 * Pull rule-shaped statements out of markdown.
 *
 * **A BULLET IS ONE STATEMENT: the first sentence is the rule, the rest is the WHY.**
 * This used to take a bullet whole and then split it back into sentences, offering each
 * one alone — so every multi-sentence bullet shed its tail as a free-standing "team
 * decision": *"The audit half of that design could never have fired"*, *"The easy
 * defects are gone; look at design, seams…"*. The reason a rule exists was thrown away
 * in the same motion, because it is almost always the NEXT sentence and `splitReason`
 * only looks inside one.
 *
 * Measured over this repository's own documents: `why` coverage goes from 5 of 66 to
 * **29 of 56**, with real reasons — *"The moment ids are guessable, every log line that
 * contains one becomes a credential"* — and the tail-fragment class disappears at
 * source rather than being filtered later.
 *
 * The modal may appear ANYWHERE in the bullet, not only in its first sentence. Requiring
 * it in the first sentence is stricter and measures better on paper (40 rules, ~9% junk)
 * and drops `CLAUDE.md` entirely, because its bullets lead with an unmodalised summary —
 * the repository's own top-level rule document contributing nothing is the wrong answer
 * whatever the precision.
 *
 * Headings, code fences and quotes are skipped: a rule inside a code block is an example
 * of a rule, not one.
 */
export function extractRules(markdown: string): readonly Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const { block, isBullet } of blocks(markdown)) {
    const parts = sentences(block);
    // A bullet is ONE unit; a paragraph is judged sentence by sentence as before.
    for (const unit of isBullet ? [parts] : parts.map((p) => [p])) {
      const whole = stripMarkup(unit.join(" "));
      const cleaned = stripMarkup(unit[0] ?? "");
      const sentence = unit[0] ?? "";
      if (!MODAL.test(whole)) continue;
      if (cleaned.length < MIN_LENGTH || cleaned.length > MAX_LENGTH) continue;
      if (NOT_A_RULE.test(cleaned) || LEAD_IN.test(cleaned) || LABEL.test(cleaned)) continue;
      if (GERUND_HEAD.test(cleaned)) continue;
      // Asked of the text as WRITTEN, not of the stripped text, and the difference is
      // a whole class of rule. A statement opening on a code span — `` `fast_clean`,
      // `failed` and `expired` are distinct states, never blended into "not passed" ``
      // (spec/operations.md) — survives markup-stripping as a lowercase `f` and was
      // refused as a lifted clause. It is a bulleted rule with a modal, and it was
      // silently gone. Backticks are the author saying "a statement starts here";
      // emphasis is not, so leading `*` and `_` come off before the question is asked
      // or `*matching* the line refused…` walks straight through the guard.
      const opener = sentence.replace(/^[*_]+/, "");
      if (NOT_SELF_CONTAINED.test(cleaned) || STARTS_MID_SENTENCE.test(opener)) continue;

      // The rest of the bullet is the reason, unless the first sentence already carries
      // one of its own — `because`/`since`/`so that` inside it wins, being the author
      // saying so explicitly rather than us inferring from position.
      const split = splitReason(cleaned);
      const rest = unit.slice(1).join(" ");
      const why = split.why ?? (rest.length > 0 ? tidy(stripMarkup(rest)).slice(0, MAX_LENGTH) : undefined);
      const key = split.statement.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ statement: split.statement, why });
    }
  }
  return out;
}

/**
 * Markdown reflowed into logical blocks: a paragraph or one bullet, wrapped lines
 * joined back together.
 *
 * This is the whole difference between a knowledge base and a pile of fragments.
 * Reading PHYSICAL lines means every rule in a hard-wrapped document is cut at the
 * wrap — and these documents are wrapped at eighty characters, so most were. The
 * store filled with things like "change — I do not let code and spec drift apart
 * quietly": true, unattributable, and starting mid-sentence because the clause
 * before it lived on the previous line.
 *
 * Headings, code fences, quotes and TABLE ROWS are skipped. A table row matches a
 * modal as readily as prose does — `| D-2 | lore never commits or pushes |` — and
 * arrives as pipes and alignment rather than as a sentence anyone can act on.
 */
function blocks(markdown: string): { block: string; isBullet: boolean }[] {
  const out: { block: string; isBullet: boolean }[] = [];
  let current: string[] = [];
  let inFence = false;
  let isBullet = false;

  const flush = () => {
    // THE SHAPE DECIDES, NOT THE WORDS.
    //
    // A bullet is written as a discrete statement — someone chose to give it its own
    // line, and it is the whole rule. A PARAGRAPH is prose, and a modal inside prose is
    // usually the story of a decision rather than the decision: "it must never have
    // happened", "we always assumed". Measured on this repository: 111 rules came out
    // of SPEC.md and 108 of them were paragraphs, from a document that is 1,700 lines
    // of incident narrative. They arrived as fragments — "It has to be, because the
    // secret is shown once", "A required field is therefore free money" — with the
    // subject in a sentence that was never captured, and were then injected into every
    // review prompt under "treat these as this team's decisions".
    //
    // A HEADING CANNOT RESCUE A PARAGRAPH, and the first attempt at this tried. Taking
    // paragraphs under a rule-ish heading changed nothing here: SPEC.md's `## 5.
    // Decisions` spans 1,800 lines, so the entire narrative sat under a decision
    // heading. Prose is prose wherever it is filed.
    //
    // The known loss is an ADR's `## Decision` paragraph, which really is the rule. It
    // is recorded rather than worked around: a heuristic that reads it would have to
    // distinguish it from `## Context` by something other than the heading, and nothing
    // measured here does. `knowledge_teach` states such a rule in one call.
    const block = current.join(" ");
    // A BULLET, OR A PARAGRAPH THAT IS ONE SENTENCE.
    //
    // A rule is one statement. A narrative paragraph is several — it sets something up,
    // says what happened, and draws a conclusion — and it is the middle sentences,
    // lifted out alone, that arrive with their subjects missing. A document that states
    // its rules as one-line paragraphs (which plenty do) still works; SPEC.md's
    // multi-sentence incident narrative does not.
    if (block.length > 0 && (isBullet || sentences(block).length === 1)) out.push({ block, isBullet });
    current = [];
  };

  for (const raw of markdown.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("```")) {
      flush();
      inFence = !inFence;
      continue;
    }
    // A rule inside a code block is an example of a rule, not one.
    if (inFence) continue;

    // A blank line, a heading, a quote or a table row all end whatever came before.
    if (line.length === 0 || line.startsWith("#") || line.startsWith(">") || line.startsWith("|")) {
      flush();
      isBullet = false;
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line) ?? /^\d+\.\s+(.*)$/.exec(line);
    if (bullet !== null) {
      // A new bullet ends the previous one; its own continuation lines follow.
      flush();
      isBullet = true;
      current.push(bullet[1] ?? "");
      continue;
    }
    // A continuation line belongs to whatever it continues; a fresh paragraph does not.
    if (current.length === 0) isBullet = false;
    current.push(line);
  }
  flush();
  return out;
}

/**
 * One block into whole sentences.
 *
 * Split on sentence-ending punctuation followed by a capital, which leaves
 * abbreviations and version numbers intact. A block with no terminator is one
 * sentence — bullets frequently have no full stop.
 */
function sentences(block: string): string[] {
  return block
    .split(/(?<=[.!?])\s+(?=[A-Z"`*])/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Separate the rule from its reason.
 *
 * The *why* is the part that survives disagreement: a rule without one gets deleted
 * by the next reader who thinks they know better, which is precisely how a codebase
 * forgets why it does things.
 */
function splitReason(text: string): Candidate {
  const m = /^(.*?)[,—-]?\s*\b(because|since|so that|otherwise)\b\s+(.*)$/i.exec(text);
  if (m === null || (m[1] ?? "").trim().length < MIN_LENGTH) {
    return { statement: tidy(text), why: undefined };
  }
  return { statement: tidy(m[1] ?? ""), why: tidy(m[3] ?? "") };
}

/**
 * Trim the sentence punctuation a document uses and a rule does not need.
 *
 * Without this, the same rule written with and without a full stop is two rules —
 * and since a document is re-ingested on every change, an editor adding a period
 * would quietly double an entry.
 */
function tidy(s: string): string {
  return s.trim().replace(/[.,;:!]+$/, "").trim();
}

function stripMarkup(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export interface IngestResult {
  readonly documents: number;
  readonly added: number;
  readonly retired: number;
  /** Candidates the screen threw away, recorded so "why is that rule gone" is answerable. */
  readonly screenedOut: number;
  /**
   * Documents whose candidates were kept WITHOUT being screened.
   *
   * Reported rather than logged, because a caller that wanted a screen and silently got
   * none has a knowledge base a fifth of which is fragments and no way to know it — the
   * exact shape INV-1 refuses, one layer in from a review.
   */
  readonly unscreened: number;
}

export interface IngestOptions {
  /** Restrict to these documents; otherwise everything discoverable. */
  readonly files?: readonly string[];
  readonly screen?: Screen;
  /**
   * Read documents as `into` has them, not as the worktree does — a resolved commit
   * (`resolveInto`/`baseCommitFor`, `git/diff.ts`), never a raw ref string (D-61).
   *
   * lore-ok[53969ab8,c5df90ef]: the gap this closes — found by lore's own review — is
   * that a review reads its OWN worktree, which for `review.ts`'s caller IS the branch
   * under review: a branch could edit its own CLAUDE.md and have the SAME review trust
   * the new rule as a team decision while judging that branch's code, with none of the
   * "the tier decides" ceremony D-10 requires of a `knowledge_teach`'d policy cited in
   * an appeal — the screen (`screen.ts`) only judges rule SHAPE, never provenance.
   * `bootstrap.ts`'s one-shot survey has the SAME hole: it runs from the first
   * review's own worktree too, so a repo's very first review from an untrusted branch
   * bootstrapped its entire initial knowledge base from that branch (c5df90ef —
   * `worker.ts` has `review.intoRef` in hand at the bootstrap call site and now passes
   * it through). Omitted entirely (no review to defend against — folder mode, or a
   * caller with no base at all), this reads the worktree exactly as before.
   */
  readonly ref?: string;
}

/**
 * Ingest every rule document in a worktree.
 *
 * Re-derivation is the whole point of the shape here: retire first, then re-extract.
 * Merging into what is already there would let a rule that was *deleted* from the
 * document live on forever, which is the same rot in a different coat.
 */
export async function ingestDocs(
  store: Store,
  repoId: string,
  worktree: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  let added = 0;
  let retired = 0;
  let documents = 0;
  let screenedOut = 0;
  let unscreened = 0;

  // `discovered` is the TRUE, uncapped inventory — needed whole by the deletion sweep
  // below (lore-ok[1774135c]). `candidates` is what this pass actually reads, capped
  // for cost the same way it always was; the two coincide exactly when the caller
  // restricted `opts.files` (never capped) or the repo is under the cap.
  const discovered = opts.files ?? (await discoverable(worktree));
  const candidates = opts.files === undefined ? capped(discovered) : discovered;
  for (const rel of candidates) {
    const read =
      opts.ref === undefined
        ? await readFile(join(worktree, rel), "utf8")
            .then((content) => ({ content, blob: undefined }))
            .catch(() => undefined)
        : await readAtRef(worktree, opts.ref, rel);
    if (read === undefined) continue;
    const source = read.content;
    documents++;

    // `readAtRef` already resolved the blob AT `ref` directly (`git rev-parse
    // <ref>:<path>`), which must be used as-is — re-hashing the WORKTREE's version
    // of a file the branch has also edited would record the branch's blob against
    // content read from `into`, the two halves of one fact disagreeing with each
    // other from the moment they are written.
    const blob = read.blob ?? (await blobSha(worktree, rel)) ?? hashOf(source);

    // RETIRE AND RE-EXTRACT AS ONE WRITE. These are two halves of one fact — *this
    // document changed, so what it used to say is no longer true and here is what it
    // says now* — and between them the repository believes the document says NOTHING.
    // A crash there is not a lost update: it is a codebase that has silently forgotten
    // its own rules, and the next review runs against an empty knowledge base and
    // learns nothing from it. Re-ingestion triggers on the blob changing, so it does
    // not heal on the next pass either — the blob is already recorded as seen.
    //
    // The file read stays outside: I/O in a transaction holds a write lock across a
    // disk wait, and every other writer queues behind it. So does the screen, and there
    // the stakes are higher — it is a model call, so a transaction around it would hold
    // a write lock for half a minute and queue every other writer behind a provider.
    //
    // ASKED BEFORE ANYTHING IS SPENT. `ingestDocs` runs on every single review, and
    // almost always finds every document unchanged; without this the screen would buy a
    // model call per document per review for ever, to write nothing. This is the same
    // question the transaction asks below, asked early and for free.
    if (store.hasKnowledgeBlob(repoId, rel, blob, EXTRACTOR_VERSION)) continue;

    const rules = extractRules(source);
    // Absent screen: everything is kept and STAMPED AS UNSCREENED, never stamped as
    // though a screen had passed it. The two are different facts and the stamp is what
    // makes the next ingest come back and do the work.
    const screened: Screened =
      opts.screen === undefined ? { kept: rules, refused: [], ran: false } : await opts.screen(rel, rules);
    const extractor = screened.ran ? EXTRACTOR_VERSION : UNSCREENED;
    if (!screened.ran) unscreened++;

    // STILL DOWN, AND NOTHING WOULD CHANGE — so change nothing, and this is the whole
    // difference between degrading and thrashing.
    //
    // The cheap check above compares against `EXTRACTOR_VERSION`, which an unscreened row
    // can never carry, and that is deliberate: it is what brings us back to retry. But
    // when the retry fails too, the rows this pass would write are byte-for-byte the rows
    // already there — and without this the transaction below retires every one of them
    // (`extractor IS NOT ?` matches `-unscreened`) with the reason "extracted by an older
    // reader", which is false because the reader never changed, and then re-inserts the
    // identical set with fresh ids. Once per review, per document, for the whole length
    // of an outage: a full dead copy of the rule base each time, and an audit trail of
    // retirements nobody earned. The fail-open path exists to survive a provider being
    // down, so it must not be the path that corrupts the record while it is.
    //
    // The retry itself is kept. It is one attempt per document per review and it is the
    // only thing that heals the base when the provider comes back.
    if (!screened.ran && store.hasKnowledgeBlob(repoId, rel, blob, UNSCREENED)) continue;

    store.tx(() => {
      retired += store.retireForChangedBlob(repoId, rel, blob, EXTRACTOR_VERSION);
      // RE-ASKED INSIDE THE TRANSACTION. The cheap check above raced the screen: two
      // reviews of one repository can reach here together, and the second would insert a
      // duplicate set of every rule in the document. Cheap, and it is the only thing
      // standing between a concurrent deploy and a doubled knowledge base.
      if (store.hasKnowledgeBlob(repoId, rel, blob, extractor)) return;
      // AND A FAILED SCREEN NEVER OVERWRITES A SUCCESSFUL ONE. The check above asks only
      // about the stamp THIS pass would write, so with two concurrent reviews of one
      // changed document — A screening cleanly, B's provider call failing — B found no
      // unscreened row, retired nothing of A's (A's rows carry the current blob and
      // reader), and inserted every candidate live and unscreened. Including the ones the
      // model had just rejected, which then went back into every reviewer prompt until
      // some later ingest happened to heal it.
      //
      // A degraded reader must never undo a good one's work. There is no uniqueness
      // constraint on `knowledge` to catch this, and no ordering between the two reviews
      // to rely on — only this question, asked while the write lock is held.
      if (!screened.ran && store.hasKnowledgeBlob(repoId, rel, blob, EXTRACTOR_VERSION)) return;
      for (const c of screened.kept) {
        store.addKnowledge({
          repoId,
          kind: "rule",
          source: "ingested",
          statement: c.statement,
          why: c.why,
          // lore-ok[38025817]: was `pathScopeFor(rel)`, scoping a rule mined from a
          // document under `docs/adr` (etc.) to that document's OWN directory — found
          // wrong by lore's own review: `relevantTo`'s scope check asks whether a
          // CHANGED FILE falls under a rule's path, and no path under `src/` can ever
          // fall under `docs/adr` or `spec` — they share no prefix at all. So a rule
          // mined from `docs/adr/0026-holds.md`, about `src/pay/hold.ts`, could never
          // reach a review of `src/pay/hold.ts` — the one thing reading ADRs at all
          // exists for (`discoverable`'s own docs: "the reasoning a reviewer most
          // needs and can least infer"). Repo-wide, same as a root CLAUDE.md rule.
          path: undefined,
          cwe: undefined,
          provenance: rel,
          sourceBlob: blob,
          extractor,
          // Below taught (1.0) and above a single derived observation: the document
          // says so, but nobody has confirmed the extraction understood it.
          confidence: 0.8,
        });
        added++;
      }
      // In the SAME write as the rules it was chosen against, so the record of what was
      // refused cannot survive a crash that lost what was kept, or the other way round.
      for (const r of screened.refused) {
        store.recordScreenedOut(
          {
            repoId,
            kind: "rule",
            source: "ingested",
            statement: r.statement,
            why: undefined,
            path: undefined, // lore-ok[38025817]: same fix as the `kept` branch above
            cwe: undefined,
            provenance: rel,
            sourceBlob: blob,
            extractor,
            confidence: 0.8,
          },
          r.because,
        );
        screenedOut++;
      }
    });
  }

  // lore-ok[a2f4d4f9]: a document DELETED, or RENAMED, is never in `discovered` —
  // found by lore's own review, and real: `retireForChangedBlob` above is only ever
  // called for a document this loop actually reads, so a document that vanished
  // entirely left its rules live for ever, with no blob to invalidate them and
  // nothing that ever revisits the question. Anything this repo has ever ingested a
  // live rule from, that this pass did not even attempt to read, is gone.
  //
  // A NARROW GAP REMAINS, named rather than silently left: `discovered` is always the
  // WORKTREE's own listing (`discoverable`, unchanged), even when `opts.ref` is set
  // (`lore-ok[53969ab8]`) — so a document the reviewed branch deleted but `into` still
  // has is indistinguishable here from one genuinely gone, and this sweep retires its
  // rules early rather than the next `into`-only ingest of an unrelated review
  // reviving them. Narrower than the hole `53969ab8` closed (an addition trusted
  // immediately) — this is a document going briefly unread, not a false rule
  // believed — and closing it needs `discoverable` itself to become ref-aware, which
  // is its own change.
  //
  // lore-ok[1774135c]: this compares against `discovered` (uncapped), NOT `candidates`
  // (capped at MAX_RULE_DOCS) — see `capped`'s docs. Comparing against the capped list
  // would have retired every live rule from every document past the cap, on every
  // review, reading "still exists past position 400" as "gone".
  if (opts.files === undefined) {
    const stillPresent = new Set(discovered);
    for (const provenance of store.liveDocumentProvenances(repoId)) {
      if (stillPresent.has(provenance)) continue;
      retired += store.retireForMissingDoc(repoId, provenance, "document no longer exists");
    }
  }
  return { documents, added, retired, screenedOut, unscreened };
}

/**
 * Every rule document in the tree: the root files, and the decision records.
 *
 * **The directories were missing, and the spec said they were not.**
 * `spec/knowledge.md` promised rules parsed from "`CLAUDE.md`, `PROG.md`, `SPEC.md`,
 * ADRs"; this returned `RULE_DOCS` alone, so no ADR was ever read. `RULE_DIRS` existed
 * only to *scope* a rule found under one — a branch nothing could reach, which is
 * what made the gap invisible to a reader: the constant is right there and looks used.
 *
 * The cost was the product. `rigid-monorepo` carries 37 ADRs and had **eight** rules,
 * all from two root files, while its entire decision record — the reasoning a reviewer
 * most needs and least can infer — was not read at all. That is the memory this
 * service exists to keep, missing for the one repository with a real user.
 *
 * Recursive, because ADRs get filed into subdirectories once there are enough of them.
 *
 * Returns EVERY path found, uncapped — this is a directory walk, never a file read, so
 * enumerating all of them costs nothing a cap would need to protect against. The read
 * cap lives in `ingestDocs`, at the one place that actually opens and extracts from
 * these files; see `MAX_RULE_DOCS`.
 */
async function discoverable(worktree: string): Promise<readonly string[]> {
  const out: string[] = [...RULE_DOCS];

  for (const dir of RULE_DIRS) {
    const found: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      const entries = await readdir(join(worktree, rel), { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(child);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) found.push(child);
      }
    };
    await walk(dir);
    out.push(...found);
  }

  return out;
}

/**
 * The cap is per repository and announced when hit (`ingest: …`) rather than silently
 * truncating: a knowledge base that quietly stopped reading at some arbitrary file is
 * exactly the confident incompleteness this project refuses.
 *
 * lore-ok[1774135c]: found real by lore's own review — the cap used to live INSIDE
 * `discoverable`, so its truncated output was also what the a2f4d4f9 deletion sweep
 * compared live rules against: past document #400, a document that plainly still
 * exists read as "no longer exists" and every rule ingested from it was retired,
 * permanently, on every review, with no path back (the sweep's own retirement means
 * the document is never re-read to notice it is still there). Enumeration
 * (`discoverable`) is now always uncapped and always cheap (a directory walk, not a
 * read); only the READ list this function returns is capped, and the sweep in
 * `ingestDocs` now compares against the uncapped enumeration instead.
 */
function capped(paths: readonly string[]): readonly string[] {
  if (paths.length <= MAX_RULE_DOCS) return paths;
  console.error(
    `[lore:log] ingest: ${paths.length} rule documents found, reading the first ${MAX_RULE_DOCS}. ` +
      `The rest were NOT read — this repository's memory is incomplete and knows it.`,
  );
  return paths.slice(0, MAX_RULE_DOCS);
}

const MAX_RULE_DOCS = 400;

function hashOf(s: string): string {
  // Fallback when the file is untracked and git cannot hash it for us. Any stable
  // function will do; it only has to change when the content does.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `nogit-${(h >>> 0).toString(16)}`;
}

/** Ranked view for prompts and `knowledge.query`. */
export function rank(items: readonly KnowledgeItem[]): readonly KnowledgeItem[] {
  const weight = (k: KnowledgeItem): number =>
    k.source === "taught" ? 0 : k.source === "ingested" ? 1 : 2;
  return [...items].sort(
    (a, b) => weight(a) - weight(b) || (b.confidence ?? 0) - (a.confidence ?? 0) || b.verifiedAt.localeCompare(a.verifiedAt),
  );
}
