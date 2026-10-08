# Faultline example: Express app

A minimal Express 5 app wired with `@faultline/node`.

| Route         | What happens                                                                  |
| ------------- | ----------------------------------------------------------------------------- |
| `/`           | 200 OK, nothing captured                                                      |
| `/boom`       | synchronous `TypeError` → captured by `Handlers.errorHandler()`               |
| `/async-boom` | rejected promise, re-thrown with an `Error.cause` chain → captured with cause |
| `/message`    | `captureMessage("Payment webhook retried", "warning")`                        |

## Run it

```bash
# 1. build the SDK (the example links to ../.. — it uses the built dist/)
cd ../.. && pnpm install && pnpm build && cd examples/express-app

# 2. install the example's own deps
pnpm install --ignore-workspace   # the example is not part of the SDK workspace

# 3. point it at your Faultline server (faultline-server listens on :4000 by default)
export FAULTLINE_API_KEY=flt_ingest_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # an ingest key from the dashboard
export FAULTLINE_ENDPOINT=http://localhost:4000                         # default
FAULTLINE_DEBUG=1 pnpm start

# 4. trigger events
curl localhost:3001/boom
curl localhost:3001/async-boom
curl localhost:3001/message
```

Events are batched and flushed every 2 seconds, so they show up in the dashboard within a
few seconds. Without `FAULTLINE_API_KEY` the app still runs but the SDK is disabled.

Environment variables:

| Variable             | Default                 | Purpose                       |
| -------------------- | ----------------------- | ----------------------------- |
| `FAULTLINE_API_KEY`  | —                       | ingest key (`flt_ingest_...`) |
| `FAULTLINE_ENDPOINT` | `http://localhost:4000` | Faultline server base URL     |
| `FAULTLINE_DEBUG`    | unset                   | `1` prints SDK debug logs     |
| `PORT`               | `3001`                  | port of this example app      |
