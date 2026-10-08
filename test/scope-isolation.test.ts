import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createExpressHandlers } from "../src/integrations/express";
import { assertConforms } from "./contract-schema";
import { makeClient } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scope isolation", () => {
  it("withScope changes do not leak, including across awaits", async () => {
    const { hub, client, transport } = makeClient();
    hub.setTag("global", "1");
    await Promise.all(
      [1, 2, 3].map((n) =>
        hub.withScope(async (scope) => {
          scope.setTag("n", String(n));
          await sleep(30 - n * 10);
          hub.setUser({ id: `user-${n}` }); // current scope = this fork
          await sleep(5);
          hub.captureMessage(`msg-${n}`);
        }),
      ),
    );
    hub.captureMessage("outside");
    await client.flush();
    const byMsg = Object.fromEntries(transport.events.map((e) => [e.message, e]));
    for (const n of [1, 2, 3]) {
      expect(byMsg[`msg-${n}`]?.tags).toEqual({ global: "1", n: String(n) });
      expect(byMsg[`msg-${n}`]?.user).toEqual({ id: `user-${n}` });
    }
    expect(byMsg.outside?.tags).toEqual({ global: "1" });
    expect(byMsg.outside?.user).toBeUndefined();
  });

  it("isolates scopes across concurrent express requests", async () => {
    const { hub, client, transport } = makeClient();
    const handlers = createExpressHandlers(hub);
    const app = express();
    app.use(handlers.requestHandler());
    app.get("/users/:id/fail", async (req, _res) => {
      const id = req.params.id;
      hub.setUser({ id });
      hub.setTag("route", "fail");
      hub.addBreadcrumb({ message: `loading ${id}` });
      await sleep(Math.floor(Math.random() * 40));
      throw new Error(`failed for ${id}`);
    });
    app.get("/ok", (_req, res) => {
      res.send("ok");
    });
    app.use(handlers.errorHandler());
    app.use(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).send("error");
      },
    );

    const ids = Array.from({ length: 25 }, (_, i) => `u${i}`);
    const responses = await Promise.all([
      ...ids.map((id) => request(app).get(`/users/${id}/fail?x=1`)),
      request(app).get("/ok"),
    ]);
    expect(responses.slice(0, 25).every((r) => r.status === 500)).toBe(true);
    await client.flush();

    expect(transport.events).toHaveLength(25);
    for (const event of transport.events) {
      assertConforms(event);
      const id = event.user?.id;
      expect(event.message).toBe(`failed for ${id}`);
      expect(event.request?.url).toMatch(new RegExp(`/users/${id}/fail\\?x=1$`));
      expect(event.request?.method).toBe("GET");
      expect(event.request?.query).toEqual({ x: "1" });
      const crumbs = (event.breadcrumbs ?? []).map((b) => b.message);
      expect(crumbs).toContain(`loading ${id}`);
      expect(crumbs.filter((m) => m?.startsWith("loading"))).toHaveLength(1);
      expect(crumbs).toContain(`GET /users/${id}/fail?x=1`);
      expect(event.tags).toMatchObject({ route: "fail", mechanism: "express" });
    }
    // nothing leaked into the global scope
    expect(hub.getRootScope().getData().user).toBeUndefined();
    expect(hub.getRootScope().getData().breadcrumbs).toHaveLength(0);
  });

  it("errorHandler captures only status >= 500 by default, configurable", async () => {
    const { hub, client, transport } = makeClient();
    const handlers = createExpressHandlers(hub);
    const app = express();
    app.use(handlers.requestHandler());
    app.get("/404", () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    app.get("/502", () => {
      throw Object.assign(new Error("bad gateway"), { statusCode: 502 });
    });
    app.use(handlers.errorHandler());
    app.use(
      (
        err: { status?: number; statusCode?: number },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(err.status ?? err.statusCode ?? 500).send("x");
      },
    );
    await request(app).get("/404");
    await request(app).get("/502");
    await client.flush();
    expect(transport.events.map((e) => e.message)).toEqual(["bad gateway"]);

    const custom = makeClient();
    const app2 = express();
    const h2 = createExpressHandlers(custom.hub);
    app2.get("/404", () => {
      throw Object.assign(new Error("nf"), { status: 404 });
    });
    app2.use(h2.errorHandler({ shouldHandleError: () => true }));
    await request(app2).get("/404");
    await custom.client.flush();
    expect(custom.transport.events).toHaveLength(1);
    // errorHandler without requestHandler still attaches request data
    expect(custom.transport.events[0]?.request?.url).toContain("/404");
  });

  it("strips cookies/auth headers by default and adds the IP only with sendDefaultPii", async () => {
    for (const sendDefaultPii of [false, true]) {
      const { hub, client, transport } = makeClient({ sendDefaultPii });
      const h = createExpressHandlers(hub);
      const app = express();
      app.use(h.requestHandler());
      app.get("/", () => {
        throw new Error("x");
      });
      app.use(h.errorHandler());
      await request(app)
        .get("/")
        .set("Cookie", "sid=abc")
        .set("Authorization", "Bearer abc")
        .set("X-Trace", "t1");
      await client.flush();
      const e = transport.events[0]!;
      if (sendDefaultPii) {
        expect(e.user?.ipAddress).toBeDefined();
        expect(e.request?.headers?.cookie).toBe("[Filtered]");
      } else {
        expect(e.user).toBeUndefined();
        expect(e.request?.headers?.cookie).toBeUndefined();
        expect(e.request?.headers?.authorization).toBeUndefined();
      }
      expect(e.request?.headers?.["x-trace"]).toBe("t1");
    }
  });
});
