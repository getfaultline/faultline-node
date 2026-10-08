# Architecture decision log: `@faultline/node`

## Layers

```
src/
  domain/          pure TS: event contract types, Scope, options validation, limits,
                   scrubbing, JSON normalization, event sanitization, dedupe key
  application/     FaultlineClient, Hub, Integration interface
    ports/         ITransport, IStackParser, ISourceContextReader, IClock, IIdGenerator,
                   IRandom, ILogger, IAsyncContext, IRuntimeInfo
  infrastructure/  HttpTransport, V8StackParser, FsSourceContextReader, Node adapters
                   (AsyncLocalStorage, crypto.randomUUID, os, console logger)
  integrations/    process, express, console, http (+fetch)
  index.ts         public API + composition root
```

Dependency rule: `domain ← application ← infrastructure / integrations ← index`.
`infrastructure` and `integrations` are siblings and may not import each other. They meet only
in `index.ts`.

---

### ADR-001: Enforce boundaries with `no-restricted-imports`, not a plugin

- **Status:** accepted
- **Decision:** Each layer gets a flat-config block with `no-restricted-imports` regex
  patterns:
  - `domain` may not import `application`, `infrastructure`, `integrations`, the root
    `index`, or any `node:` built-in.
  - `application` may not import `infrastructure`, `integrations` or `index`.
  - `infrastructure` may not import `integrations` or `index`.
  - `integrations` may not import `infrastructure` or `index`.
- **Why:** The spec allows eslint-plugin-boundaries or dependency-cruiser. ESLint 10 and
  typescript-eslint 8 are new enough that adding a plugin plus a TS import resolver is
  dependency churn for a ~20-file package. The built-in rule needs no extra dependencies and
  gives clear messages.
- **Verification:** We added deliberate violation files and confirmed that each one fails lint.

### ADR-002: Zero runtime dependencies; hand-written options validator instead of zod

- **Status:** accepted (documented deviation from "zod at every boundary")
- **Decision:** `resolveOptions()` in `src/domain/options.ts` validates `init()` options by
  hand.
- **Why:** The SDK spec asks for zero runtime dependencies "where possible". Options are the
  SDK's only input boundary, and they are small and flat. zod would add about 50 KB and a
  peer-version risk for every consumer.
- **Behavior:** Unlike `zod.parse`, the validator never throws:
  - An invalid optional value falls back to its default with a warning.
  - Only a missing `apiKey` or an unusable `endpoint` disables the SDK.
- **Where zod is used:** As a devDependency. The test suite validates every produced event
  against a strict zod schema that mirrors CONTRACTS.md (`test/contract-schema.ts`).

### ADR-003: AsyncLocalStorage behind a port

- **Decision:** The `Hub` (application layer) depends on `IAsyncContext<Scope>`, a two-method
  interface (`getStore`, `run`). The composition root injects a real `AsyncLocalStorage`.
  `withScope` and the Express `requestHandler` fork the current scope with `clone()` and run
  the callback inside `storage.run`.
- **Why:** This keeps the application layer free of Node imports and lets tests run fully
  isolated hubs.

### ADR-004: Event processing is split into a sync phase and an async phase

- **Sync phase** (inside `captureException`): build the exception, take a snapshot of the
  scope, then apply `sampleRate`, `ignoreErrors` and dedupe. The `eventId` is returned
  synchronously. The scope snapshot is taken at capture time, so later scope changes do not
  affect the event.
- **Async phase:**
  1. Read source context (`fs.promises`, so the event loop is never blocked).
  2. Sanitize the event against the contract limits.
  3. Scrub sensitive data.
  4. Run `beforeSend`, then sanitize its result again.
  5. Enqueue the event.
- `flush()` waits for in-flight async phases before flushing the transport.
- **Consequence:** Events can reach the server in a different order than they were captured.
  The server orders events by `timestamp`, so this is harmless.

### ADR-005: `beforeSend` receives scrubbed events; a throwing `beforeSend` drops the event

- **Decision:** Scrubbing runs before `beforeSend`. If `beforeSend` throws, or returns
  something that is not an event, the event is dropped and the SDK logs this in debug mode.
- **Why:** Sending the unmodified event could leak data the user meant to strip, so dropping
  is the privacy-safe choice. Whatever `beforeSend` returns is re-sanitized, so a buggy hook
  cannot produce a payload that violates the contract.

### ADR-006: `sendDefaultPii` semantics

- **When `false` (default):**
  - `user.ipAddress` is removed.
  - The `cookie`, `set-cookie`, `authorization`, `proxy-authorization`, `x-forwarded-for`,
    `x-real-ip` and `forwarded` headers are removed entirely.
  - The Express handler does not collect the client IP.
- **When `true`:**
  - The IP is collected (`req.ip` or `socket.remoteAddress`) and those headers are kept.
  - Values under sensitive keys are still replaced with `"[Filtered]"`, because the shared
    scrubbing rules always apply. The server applies them as well.

### ADR-007: Cause-chain depth counts the root exception

- **Decision:** CONTRACTS.md says "`exception.cause` depth ≤ 5". We interpret this as at most
  5 exception objects in total: the root plus up to 4 causes.
- **Why:** This is the conservative reading. It is valid under both possible server
  interpretations, whereas root plus 5 causes could be rejected by a server that counts the
  root.
- **Cycles:** A `seen` set breaks cycles such as `a.cause = b; b.cause = a`.
- **Non-Error causes:** These become `{ type: "NonErrorCause", value: <description> }`.

### ADR-008: Non-Error throwables

- **Shape:** A thrown value that is not an `Error` (string, number, object, null, …) becomes a
  synthetic `Error` exception whose `value` describes it. For example, a thrown string becomes
  its text, and an object becomes "Non-Error object thrown with keys: …" with a truncated JSON
  preview.
- **Stack:** `captureException` captures a synthetic stack with
  `Error.captureStackTrace(holder, captureException)`, so frames start at the caller and not
  inside the SDK. Values thrown inside the process integration have no call site, so they get
  no frames.
- **Error-like objects:** An object with string `message` and `stack` properties is treated as
  an Error. This covers errors from other realms, such as `vm` contexts.

### ADR-009: Dedupe

- **Rule:** Only consecutive events are compared. An event is dropped when its key equals the
  key of the last _sent_ event and less than 1000 ms have passed.
- **Key:**
  - With a custom `fingerprint`: the fingerprint.
  - Otherwise, for exceptions: type + message + the top 5 frames (file:function:line:col).
  - Otherwise, for messages: level + message.
- **Window:** The window is measured from the last event that was actually sent, so a
  duplicate that keeps firing is still reported about once per second.

### ADR-010: Transport

- **Queue:** At most 100 events. On overflow the oldest event is dropped.
- **Serialization:** Events are serialized when they are queued. This takes a snapshot and
  measures the size up front. An event that cannot fit in 1 MB is trimmed in this order:
  breadcrumbs → source context → extra. If it still does not fit, it is dropped.
- **Batches:** At most 50 events and at most 1 MB uncompressed (`{"events":[…]}`), always
  gzip-compressed.
- **Flush triggers:** An `unref`'d 2 s interval, or `flushAt` = 20 queued events.
- **Retries:**
  - **Network error, timeout (AbortController, 5 s), 5xx or 408:** retried inline with equal
    jitter, `min(30s, 1s·2^n)/2 + rand·min(30s, 1s·2^n)/2`, for up to 3 retries.
  - **429:** the transport is paused until `Retry-After` (seconds or HTTP date, capped at
    10 min). The batch goes back to the front of the queue, and an event is dropped after 3
    rate-limited attempts.
  - **401, 413 and other 4xx:** dropped, with a debug log.
- **fetch reference:** The transport keeps the global `fetch` it saw at construction. It is
  constructed before the http integration patches `fetch`. The http integration also skips any
  request that goes to `{endpoint}/api/v1/ingest/events` or carries `X-Faultline-Key`.

### ADR-011: Passive http instrumentation

- **Approach:** We patch `http.request`, `http.get`, `https.request`, `https.get` and
  `globalThis.fetch`. `syncBuiltinESMExports()` keeps ESM named imports in sync.
- **Recording:** For `ClientRequest`s we listen only to `'close'` and read `req.res.statusCode`.
  We deliberately avoid adding `'response'` or `'error'` listeners:
  - An `'error'` listener would swallow errors that would otherwise crash the app.
  - A `'response'` listener disables Node's automatic dumping of unconsumed bodies.
- **Scope:** The scope is captured when the request starts. Pooled keep-alive sockets can emit
  `'close'` in another request's async context, and capturing early prevents the breadcrumb
  from landing in the wrong scope.

### ADR-012: Process integration preserves default exit behavior

- **Why this is needed:** Adding an `uncaughtException` listener disables Node's default
  print-and-exit.
- **Our handler:**
  1. Captures the error as `fatal`.
  2. Flushes for up to 2 s.
  3. Writes the stack to stderr.
  4. Calls `process.exit(1)`.
- **App listeners:** If the app has its own listeners, we only capture and flush, and the app
  keeps control of whether to exit.
- **unhandledRejection:** The handler reads `--unhandled-rejections` from `execArgv` and
  `NODE_OPTIONS`:
  - `throw` (default): exit 1 after the flush.
  - `warn` / `none`: no exit.
  - `warn-with-error-code`: sets `exitCode = 1`.
  - `strict`: the rejection already arrived through `uncaughtException`, so it is not captured
    a second time.

### ADR-013: One hub per process

- **Decision:** The singleton `Hub` lives on `globalThis[Symbol.for("@faultline/node.hub")]`.
- **Why:** If an app loads both the ESM and the CJS build (the dual-package hazard), they still
  share one scope stack and one client.

### ADR-014: Toolchain versions

- **Runtime:** The published package supports Node ≥ 18, and only standard APIs are used.
- **Dev tooling:** vitest 5, ESLint 10 and Changesets 3 require Node ≥ 22. CI therefore runs
  lint, typecheck, test and build on Node 22 and 24. A separate job runs the dependency-free
  `scripts/smoke.mjs` against the built `dist/` on Node 18 and 20.
- **TypeScript:** Pinned to 6.0 because typescript-eslint 8 does not yet support TS 7. tsup's
  DTS step sets `ignoreDeprecations: "6.0"` because tsup injects `baseUrl`.

### Suggestions (not implemented, outside spec)

- Raise `Error.stackTraceLimit` (default 10) on `init`. This would improve stacks, but it
  mutates a global, so it is left to the app.
- Offline persistence of the queue across restarts.
- A `transport` option for custom transports, for example in serverless environments.
