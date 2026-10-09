import express from "express";
import * as Faultline from "@getfaultline/node";

const apiKey = process.env.FAULTLINE_API_KEY;
const endpoint = process.env.FAULTLINE_ENDPOINT ?? "http://localhost:4000";
const port = Number(process.env.PORT ?? 3001);

if (!apiKey) {
  console.warn("FAULTLINE_API_KEY is not set; the SDK stays disabled and no events are sent.");
}

// 1. Initialize as early as possible.
Faultline.init({
  apiKey,
  endpoint,
  environment: process.env.NODE_ENV ?? "development",
  release: "example-express-app@1.0.0",
  debug: process.env.FAULTLINE_DEBUG === "1",
  enabled: Boolean(apiKey),
});

const app = express();

// 2. First middleware: per-request scope + request data + breadcrumb.
app.use(Faultline.Handlers.requestHandler());

app.get("/", (_req, res) => {
  res.json({ ok: true, routes: ["/boom", "/async-boom", "/message"] });
});

// Synchronous TypeError → captured by errorHandler (status 500).
app.get("/boom", () => {
  Faultline.setTag("route", "boom");
  const user = undefined;
  return user.profile.name; // TypeError: Cannot read properties of undefined
});

// Rejected promise with an Error.cause chain (Express 5 forwards async errors to next()).
app.get("/async-boom", async () => {
  Faultline.setUser({ id: "user-123", email: "jane@example.com" });
  Faultline.addBreadcrumb({
    category: "db",
    message: "SELECT * FROM orders WHERE id = 42",
    type: "query",
  });
  try {
    await Promise.reject(new Error("ECONNREFUSED 127.0.0.1:5432"));
  } catch (cause) {
    throw new Error("Failed to load order 42", { cause });
  }
});

// captureMessage at "warning" level.
app.get("/message", (_req, res) => {
  const eventId = Faultline.captureMessage("Payment webhook retried", "warning");
  res.json({ captured: true, eventId });
});

// 3. After all routes, before your own error handler.
app.use(Faultline.Handlers.errorHandler());

// Your own error handler still runs and decides the response.
app.use((err, _req, res, _next) => {
  res.status(err.status ?? 500).json({ error: err.message, eventId: res.locals.faultlineEventId });
});

const server = app.listen(port, () => {
  console.log(`example app on http://localhost:${port} → sending events to ${endpoint}`);
});

// Flush buffered events on graceful shutdown.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await Faultline.close(2000);
    process.exit(0);
  });
}
