/**
 * Credentials reach a running opencode v2 only through its API — and the two ways that can
 * go silently wrong are the ones pinned here: a forbidden provider arriving (D-1), and a
 * stale host login overwriting a token the deployment has already renewed.
 */

import { describe, expect, it } from "vitest";
import type { OpenCodeClient } from "@opencode/client";
import { apply, parseHostCredentials, plan, type Credential } from "./creds-sync.ts";

const key = (integrationID: string, k: string, extra: Partial<Credential> = {}): Credential => ({
  id: `cred_${integrationID}_${k}`,
  integrationID,
  label: integrationID,
  active: true,
  value: { type: "key", key: k },
  ...extra,
});
const oauth = (integrationID: string, expires: number, refresh = "r"): Credential => ({
  id: `cred_${integrationID}_${String(expires)}`,
  integrationID,
  label: integrationID,
  active: true,
  value: { type: "oauth", methodID: "chatgpt-browser", refresh, access: "a", expires },
});

describe("planning a credential sync", () => {
  it("pushes what differs and leaves what is identical", () => {
    const p = plan([key("zai", "new"), key("openrouter", "same")], [key("zai", "old"), key("openrouter", "same")]);
    expect(p.push.map((c) => c.integrationID)).toStrictEqual(["zai"]);
    expect(p.unchanged).toStrictEqual(["openrouter"]);
  });

  // D-1, enforced by absence: no credential, no way for a typo in a tiers file to reach it.
  it("never pushes an Anthropic credential", () => {
    const p = plan([key("anthropic", "x")], []);
    expect(p.push).toStrictEqual([]);
    expect(p.forbidden).toStrictEqual(["anthropic"]);
  });

  // opencode answers with the active credential; an inactive one is history.
  it("ignores inactive credentials on both sides", () => {
    const p = plan([key("zai", "old", { active: false })], [key("zai", "x", { active: false })]);
    expect(p.push).toStrictEqual([]);
  });

  // The going-backwards case: the deployment renewed the login itself, and with refresh
  // rotation the host's older copy may already be revoked.
  it("refuses to replace a login the deployment renewed past the host's", () => {
    const p = plan([oauth("openai", 1_000)], [oauth("openai", 2_000, "rotated")]);
    expect(p.push).toStrictEqual([]);
    expect(p.behind).toStrictEqual([{ integrationID: "openai", host: 1_000, container: 2_000 }]);
  });

  it("pushes it anyway when forced", () => {
    const p = plan([oauth("openai", 1_000)], [oauth("openai", 2_000, "rotated")], true);
    expect(p.push.map((c) => c.integrationID)).toStrictEqual(["openai"]);
  });

  it("pushes a fresh host login over an expired one", () => {
    const p = plan([oauth("openai", 3_000, "fresh")], [oauth("openai", 1_000)]);
    expect(p.push.map((c) => c.integrationID)).toStrictEqual(["openai"]);
  });
});

describe("applying it", () => {
  /** A client that records calls — create answers with a new id, as opencode does. */
  const recording = () => {
    const calls: string[] = [];
    let n = 0;
    const client = {
      credential: {
        create: async (input: { integrationID: string; activate?: boolean }) => {
          calls.push(`create ${input.integrationID} activate=${String(input.activate)}`);
          return { id: `cred_new_${String(++n)}` };
        },
        remove: async (input: { credentialID: string }) => {
          calls.push(`remove ${input.credentialID}`);
        },
      },
    } as unknown as OpenCodeClient;
    return { client, calls };
  };

  // Removal only after a successful create, so a failure part-way leaves the old login.
  it("creates the new login, then removes the old ones for that integration only", async () => {
    const { client, calls } = recording();
    const container = [key("zai", "old"), key("openrouter", "keep")];
    const changed = await apply(client, plan([key("zai", "new")], container), container);
    expect(changed).toStrictEqual(["zai"]);
    expect(calls).toStrictEqual(["create zai activate=true", "remove cred_zai_old"]);
  });

  it("leaves the old login in place when the create fails", async () => {
    const calls: string[] = [];
    const client = {
      credential: {
        create: async () => {
          throw new Error("opencode said no");
        },
        remove: async (input: { credentialID: string }) => {
          calls.push(`remove ${input.credentialID}`);
        },
      },
    } as unknown as OpenCodeClient;
    const container = [key("zai", "old")];
    await expect(apply(client, plan([key("zai", "new")], container), container)).rejects.toThrow(/said no/);
    expect(calls).toStrictEqual([]);
  });
});

describe("reading the host's list", () => {
  it("accepts opencode's response body or its bare list", () => {
    expect(parseHostCredentials(JSON.stringify({ data: [key("zai", "k")] }))).toHaveLength(1);
    expect(parseHostCredentials(JSON.stringify([key("zai", "k")]))).toHaveLength(1);
  });

  // Whatever arrived was not a credential list — an error page, an empty pipe — and
  // reading it as "no credentials" would report everything unchanged.
  it("refuses anything else rather than reading it as no credentials", () => {
    expect(() => parseHostCredentials(JSON.stringify({ error: "nope" }))).toThrow(/credential list/);
    expect(() => parseHostCredentials(JSON.stringify([{ label: "x" }]))).toThrow(/no integrationID/);
    expect(() => parseHostCredentials("")).toThrow();
  });
});
