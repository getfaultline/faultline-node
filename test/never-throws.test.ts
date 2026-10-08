import { afterEach, describe, expect, it } from "vitest";
import * as Faultline from "../src/index";
import { resetGlobalScope, startMockServer } from "./helpers";

const noIntegrations = { process: false, console: false, http: false };

afterEach(async () => {
  await Faultline.close(500);
  resetGlobalScope();
});

describe("the SDK never throws into the host app", () => {
  it("public API is safe before init", async () => {
    expect(Faultline.isEnabled()).toBe(false);
    expect(Faultline.captureException(new Error("x"))).toBeUndefined();
    expect(Faultline.captureMessage("x")).toBeUndefined();
    Faultline.setUser({ id: "1" });
    Faultline.setTag("a", "b");
    Faultline.setTags({ a: "b" });
    Faultline.setContext("c", { a: 1 });
    Faultline.addBreadcrumb({ message: "m" });
    expect(Faultline.withScope(() => 42)).toBe(42);
    await expect(Faultline.flush(10)).resolves.toBe(true);
    await expect(Faultline.close(10)).resolves.toBe(true);
    Faultline.setUser(null);
  });

  it.each([
    undefined,
    null,
    42,
    "flt_ingest_x",
    {},
    { apiKey: 123 },
    { apiKey: "k", endpoint: "not a url" },
    { apiKey: "k", endpoint: "ftp://x" },
    {
      apiKey: "k",
      sampleRate: "1",
      maxBreadcrumbs: -1,
      beforeSend: "nope",
      ignoreErrors: "x",
      integrations: "all",
      debug: "yes",
    },
    { apiKey: "k", ignoreErrors: [1, null, /ok/], integrations: { process: "yes" } },
  ])("init(%j) does not throw", (options) => {
    expect(() => Faultline.init(options as never)).not.toThrow();
    expect(() => Faultline.captureException(new Error("after bad init"))).not.toThrow();
  });

  it("invalid fatal options disable the SDK; invalid optional ones fall back to defaults", () => {
    Faultline.init({ apiKey: "k", endpoint: "nope", integrations: noIntegrations });
    expect(Faultline.isEnabled()).toBe(false);
    Faultline.init({ apiKey: "k", sampleRate: 7, integrations: noIntegrations });
    expect(Faultline.isEnabled()).toBe(true);
    Faultline.init({ enabled: false });
    expect(Faultline.isEnabled()).toBe(false);
  });

  it("bad arguments to every public function are tolerated", () => {
    Faultline.init({ apiKey: "k", endpoint: "http://127.0.0.1:1", integrations: noIntegrations });
    const bad = [undefined, null, 1, "s", Symbol("s"), () => 1, [], {}] as never[];
    for (const v of bad) {
      expect(() => Faultline.setUser(v)).not.toThrow();
      expect(() => Faultline.setTag(v, v)).not.toThrow();
      expect(() => Faultline.setTags(v)).not.toThrow();
      expect(() => Faultline.setContext(v, v)).not.toThrow();
      expect(() => Faultline.setExtra(v, v)).not.toThrow();
      expect(() => Faultline.addBreadcrumb(v)).not.toThrow();
      expect(() => Faultline.captureMessage(v, v)).not.toThrow();
      expect(() => Faultline.captureException(v, v)).not.toThrow();
      expect(() => Faultline.withScope(v)).not.toThrow();
    }
  });

  it("hostile throwables (throwing getters, proxies) do not throw", () => {
    Faultline.init({ apiKey: "k", endpoint: "http://127.0.0.1:1", integrations: noIntegrations });
    const evilError = new Error("evil");
    Object.defineProperty(evilError, "stack", {
      get() {
        throw new Error("stack getter");
      },
    });
    Object.defineProperty(evilError, "name", {
      get() {
        throw new Error("name getter");
      },
    });
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
        ownKeys() {
          throw new Error("trap");
        },
        getPrototypeOf() {
          throw new Error("trap");
        },
      },
    );
    expect(() => Faultline.captureException(evilError)).not.toThrow();
    expect(() => Faultline.captureException(proxy)).not.toThrow();
    expect(() => Faultline.captureException(new Error("x"), { extra: { proxy } })).not.toThrow();
  });

  it("a throwing beforeSend drops the event without throwing", async () => {
    const server = await startMockServer();
    try {
      Faultline.init({
        apiKey: "k",
        endpoint: server.url,
        integrations: noIntegrations,
        beforeSend: () => {
          throw new Error("user bug");
        },
      });
      expect(() => Faultline.captureException(new Error("x"))).not.toThrow();
      await expect(Faultline.flush(1000)).resolves.toBe(true);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("transport failures (unreachable endpoint, 500s) never surface", async () => {
    Faultline.init({ apiKey: "k", endpoint: "http://127.0.0.1:1", integrations: noIntegrations });
    Faultline.captureException(new Error("lost"));
    await expect(Faultline.flush(300)).resolves.toBeTypeOf("boolean");

    const server = await startMockServer(() => ({ status: 500 }));
    try {
      Faultline.init({ apiKey: "k", endpoint: server.url, integrations: noIntegrations });
      Faultline.captureException(new Error("lost too"));
      await expect(Faultline.flush(300)).resolves.toBeTypeOf("boolean");
    } finally {
      await server.close();
    }
  });

  it("express Handlers work (as pass-through) even when the SDK is not initialized", () => {
    let nextCalledWith: unknown = "not called";
    Faultline.Handlers.requestHandler()({}, {}, () => (nextCalledWith = undefined));
    expect(nextCalledWith).toBeUndefined();
    const err = new Error("e");
    Faultline.Handlers.errorHandler()(err, {}, {}, (e) => (nextCalledWith = e));
    expect(nextCalledWith).toBe(err);
    expect(Faultline.Handlers.errorHandler().length).toBe(4); // express detects error middleware by arity
  });

  it("errors thrown by the app inside withScope still propagate (the SDK does not swallow them)", () => {
    expect(() =>
      Faultline.withScope(() => {
        throw new Error("app error");
      }),
    ).toThrow("app error");
  });
});
