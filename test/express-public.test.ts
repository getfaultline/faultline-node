import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import * as Faultline from "../src/index";
import type { FaultlineEvent } from "../src/domain";
import { assertConforms, batchSchema } from "./contract-schema";
import { resetGlobalScope, startMockServer } from "./helpers";

afterEach(async () => {
  await Faultline.close(500);
  resetGlobalScope();
});

describe("Faultline.Handlers with a real Express app", () => {
  it("type-checks against @types/express and reports 5xx errors with request data", async () => {
    const server = await startMockServer();
    try {
      Faultline.init({
        apiKey: "flt_ingest_express",
        endpoint: server.url,
        integrations: { process: false, console: false, http: false },
      });
      const app = express();
      // These lines are also a compile-time check: no casts needed for Express's types.
      app.use(Faultline.Handlers.requestHandler());
      app.get("/boom", () => {
        throw new TypeError("boom");
      });
      app.get("/async-boom", async () => {
        await Promise.resolve();
        throw new Error("async boom", { cause: new Error("root cause") });
      });
      app.use(Faultline.Handlers.errorHandler());

      await request(app).get("/boom").expect(500);
      await request(app).get("/async-boom").expect(500);
      expect(await Faultline.flush(2000)).toBe(true);

      const events = server.requests.flatMap(
        (r) => batchSchema.parse(r.body).events as unknown as FaultlineEvent[],
      );
      expect(events).toHaveLength(2);
      events.forEach(assertConforms);
      const boom = events.find((e) => e.message === "boom");
      const asyncBoom = events.find((e) => e.message === "async boom");
      expect(boom?.exception?.type).toBe("TypeError");
      expect(boom?.request).toMatchObject({ method: "GET" });
      expect(boom?.request?.url).toMatch(/\/boom$/);
      expect(asyncBoom?.exception?.cause?.value).toBe("root cause");
    } finally {
      await server.close();
    }
  });
});
