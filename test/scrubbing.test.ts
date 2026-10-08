import { describe, expect, it } from "vitest";
import {
  FILTERED,
  scrubEvent,
  scrubUrl,
  scrubValue,
  SENSITIVE_KEY_REGEX,
  CREDIT_CARD_REGEX,
} from "../src/domain";
import type { FaultlineEvent } from "../src/domain";
import { assertConforms } from "./contract-schema";
import { makeClient } from "./helpers";

const base = (): FaultlineEvent => ({
  eventId: "6f1c1d1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f",
  timestamp: new Date().toISOString(),
  level: "error",
  platform: "node",
  sdk: { name: "@faultline/node", version: "1" },
});

describe("scrubbing", () => {
  it("uses the exact regexes from CONTRACTS.md", () => {
    expect(SENSITIVE_KEY_REGEX.source).toBe(
      "(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|x-faultline-key)",
    );
    expect(SENSITIVE_KEY_REGEX.flags).toBe("i");
    expect(CREDIT_CARD_REGEX.source).toBe("\\b(?:\\d[ -]*?){13,16}\\b");
  });

  it.each([
    "Authorization",
    "COOKIE",
    "set-cookie",
    "password",
    "user_passwd",
    "clientSecret",
    "accessToken",
    "api_key",
    "apiKey",
    "API-KEY",
    "X-Faultline-Key",
  ])("filters values under sensitive key %s", (key) => {
    expect(scrubValue({ [key]: "s3cr3t", safe: "ok" }, { creditCards: true })).toEqual({
      [key]: FILTERED,
      safe: "ok",
    });
  });

  it("filters nested keys and credit-card values, and masks sensitive URL query params", () => {
    const out = scrubValue(
      {
        a: { b: [{ password: "x" }, "4111 1111 1111 1111"] },
        url: "https://x.io/cb?token=abc&page=2",
        n: 5,
      },
      { creditCards: true },
    );
    expect(out).toEqual({
      a: { b: [{ password: FILTERED }, FILTERED] },
      url: `https://x.io/cb?token=${FILTERED}&page=2`,
      n: 5,
    });
    expect(scrubUrl("/x?api_key=1&q=hello")).toBe(`/x?api_key=${FILTERED}&q=hello`);
  });

  it("scrubs request, user, tags, extra, contexts and breadcrumb data (sendDefaultPii: false)", () => {
    const event: FaultlineEvent = {
      ...base(),
      request: {
        url: "http://api/x?secret=1",
        headers: {
          Authorization: "Bearer t",
          Cookie: "sid=1",
          "X-Forwarded-For": "1.2.3.4",
          "x-custom-token": "t",
          accept: "json",
        },
        query: { card: "5500-0000-0000-0004", q: "ok" },
      },
      user: { id: "u1", ipAddress: "1.2.3.4" },
      tags: { auth_token: "t", region: "eu" },
      extra: { password: "p", nested: { cc: "4111111111111111" } },
      contexts: { db: { password: "p", host: "h" } },
      breadcrumbs: [{ timestamp: "t", type: "http", data: { url: "/?token=1", apiKey: "k" } }],
    };
    const out = scrubEvent(event, false);
    expect(out.request?.headers).toEqual({ "x-custom-token": FILTERED, accept: "json" });
    expect(out.request?.query).toEqual({ card: FILTERED, q: "ok" });
    expect(out.request?.url).toBe(`http://api/x?secret=${FILTERED}`);
    expect(out.user).toEqual({ id: "u1" });
    expect(out.tags).toEqual({ auth_token: FILTERED, region: "eu" });
    expect(out.extra).toEqual({ password: FILTERED, nested: { cc: FILTERED } });
    expect(out.contexts).toEqual({ db: { password: FILTERED, host: "h" } });
    expect(out.breadcrumbs?.[0]?.data).toEqual({ url: `/?token=${FILTERED}`, apiKey: FILTERED });
    // input not mutated
    expect(event.user?.ipAddress).toBe("1.2.3.4");
  });

  it("with sendDefaultPii: true keeps IP and PII headers present, but sensitive values are still filtered", () => {
    const out = scrubEvent(
      {
        ...base(),
        request: { headers: { cookie: "sid=1", "x-forwarded-for": "1.2.3.4" } },
        user: { ipAddress: "1.2.3.4" },
      },
      true,
    );
    expect(out.request?.headers).toEqual({ cookie: FILTERED, "x-forwarded-for": "1.2.3.4" });
    expect(out.user).toEqual({ ipAddress: "1.2.3.4" });
  });

  it("the client scrubs before beforeSend sees the event", async () => {
    let seen: FaultlineEvent | undefined;
    const { hub, client, transport } = makeClient({ beforeSend: (e) => ((seen = e), e) });
    hub.setUser({ id: "1", ipAddress: "9.9.9.9" });
    hub.captureException(new Error("x"), { extra: { password: "hunter2" } });
    await client.flush();
    expect(seen?.extra).toEqual({ password: FILTERED });
    expect(seen?.user).toEqual({ id: "1" });
    assertConforms(transport.events[0]);
  });
});
