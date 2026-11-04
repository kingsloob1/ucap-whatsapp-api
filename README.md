# ucap-whatsapp-api

**InvestNow on WhatsApp**: a NestJS service on Bun that receives WhatsApp Business
(Cloud API) webhooks and answers them through a conversation state machine.
Onboarding, wallet funding, balances, withdrawals and product purchases all run
on dummy data for now.

Built on the `@kingsleyweb` Bun packages:

| Package                    | Used for                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@kingsleyweb/bun-nest`    | Nest's HTTP adapter on `Bun.serve`, `@Validate` with zod schemas, the cache and jobs modules, the dev type sync |
| `@kingsleyweb/bun-cache`   | Conversation sessions (SQLite driver, idle TTL), admin sessions, rate-limit counters                            |
| `@kingsleyweb/bun-jobs`    | The inbound and outbound message queues (SQLite), and their management API                                      |
| `@kingsleyweb/bun-jobs-ui` | The queues dashboard at `/admin/jobs`                                                                           |
| `@kingsleyweb/bun-client`  | The UIs' typed HTTP client, regenerated live from the API in development                                        |

## How a message flows

```
Meta ──POST /webhook──▶ signature + origin checks ──▶ inbound queue (job id = WhatsApp message id)
                                                          │
                                          worker: state machine (bun-cache session, SQLite data)
                                                          │
                                                  outbound queue ──▶ Graph API /messages (or dry-run log)
```

- **The webhook acknowledges at once** and never blocks on the bot. Meta's
  redeliveries are dropped, because the job id is the message id.
- **Inbound jobs run once.** A retry after the session has moved on would
  answer the wrong step. **Outbound jobs retry** with backoff, and the job's
  progress records which messages already went out, so a retry never sends one twice.
- Messages from one user are handled one at a time and in order. Different
  users are handled concurrently.

### The conversation

1. **Welcome.** A user who hasn't onboarded gets **Proceed** and **Close** buttons. An onboarded user gets the menu.
2. **Onboarding:** BVN (11 digits, not already registered), then date of birth
   (DD/MM/YYYY, 18 or older), then products (several at once, e.g. `1,3,5` or `all`), then a 4-digit PIN
   and its confirmation. Easy PINs like `1111` or `1234` are refused. The user is then saved to `investnow.db`.
3. **Menu** (an interactive list): Fund wallet, Check balance, Withdraw, Buy
   products, Close. Each money action asks for the PIN. Three wrong PINs cancel it.
4. `MENU` returns to the menu at any point. `CANCEL` (or `exit`, `stop`, …) ends the session, and so does 24 hours of
   inactivity (`SESSION_TTL_MS`).

The PIN is stored only as an argon2id hash (`Bun.password`), including while it is
being confirmed. The admin views mask BVNs, and PINs never appear in the message log.

## Running it

```bash
bun install
cp .env.example .env          # fill in what you need; everything is optional in development
bun run dev:all               # API (watch) + UI dev server (HMR) + live typed-client sync
```

- Chat simulator: <http://127.0.0.1:3001/> (enter any valid mobile number and chat as that user)
- Admin: <http://127.0.0.1:3001/admin/>, with the jobs dashboard at `/admin/jobs/`
- API: <http://127.0.0.1:3000> (`/webhook`, `/health`, `/dev/*`, `/admin/api/*`)

Or run the parts on their own: `bun run dev` (API), `bun run ui:dev` (UIs),
`bun run ui:types` (typed-client sync).

Without `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` the service runs
**dry**: replies are logged, not sent (and listed at `GET /dev/outbox`).

### Admin accounts

Set `ADMIN_EMAIL`, `ADMIN_USERNAME` and `ADMIN_PASSWORD` to create (or reset) an
admin at startup, or run:

```bash
bun run admin:create --email ops@example.com --username ops   # asks for the password
```

Passwords need 12 or more characters mixing at least three of: lower case,
upper case, digits, symbols. Admins sign in with their email or username. The
session is an HttpOnly, SameSite=Strict cookie scoped to `/admin` (`Secure` in
production) that lasts 8 hours.

### The typed client, live

The chat and admin UIs call the API through `@kingsleyweb/bun-client`, typed by
`ui/src/api.gen.ts`. In development, bun-nest's `DevTypesModule` serves the
API's OpenAPI document and announces every change. `bun-client watch`
(part of `dev:all`) rewrites the file about 100 ms after a route or schema
changes, so the UIs' types follow the server as you edit it. The UIs
validate requests with the **server's own zod DTOs** (`src/dev/dev.dto.ts`,
`src/admin/admin.dto.ts`), the mobile-number check included.

`bun run ui:types:generate` builds the same file without a running server, and
`bun run ui:types:check` fails if it is stale (it runs in `bun run verify`).

## Security

- **Webhook: proof of origin, not throttling.** Meta's traffic is never rate-limited. Instead, every delivery must:
  - carry a valid `X-Hub-Signature-256`, an HMAC of the raw body keyed with `WHATSAPP_APP_SECRET`;
  - name our business account (`WHATSAPP_BUSINESS_ACCOUNT_ID`) and our phone number
    (`WHATSAPP_PHONE_NUMBER_ID`); signed deliveries for anything else are acknowledged and ignored;
  - carry fresh messages: older than `WEBHOOK_MAX_MESSAGE_AGE_SECONDS` (24 h) or
    from the future are dropped, and replays within the window are already de-duplicated.

  An address that fails the signature or verify-token check 10 times in 10 minutes
  is blocked for an hour, before its body is even hashed.

- **Everything else is throttled** with `@nestjs/throttler`, on a bun-cache
  storage (`security.db`, shared across restarts):
  - default 120 requests/min per address;
  - sign-in 10/min, then a 15-minute block, on top of a 5-failure lockout per account;
  - the simulator 60/min;
  - the jobs API (300/min) and dashboard (120/min), which are mounted below Nest, get the same limits as middleware.
- Client addresses come from the socket peer unless `TRUSTED_PROXIES` says how
  many proxy hops to trust. bun-nest always parses `X-Forwarded-For`, so this
  setting is what stops clients choosing their own address.
- Bodies are capped at 1 MB. In production the service refuses to start
  without its WhatsApp settings, and refuses `ENABLE_DEV_ROUTES`.

## Storage

All state is SQLite under `DATA_DIR` (`./data`, or `/data` in Docker):

| File           | What                                                   | Through   |
| -------------- | ------------------------------------------------------ | --------- |
| `investnow.db` | users, products, transactions, admins, the session log | `Bun.SQL` |
| `sessions.db`  | the live conversation state (expiring)                 | bun-cache |
| `jobs.db`      | the inbound and outbound queues                        | bun-jobs  |
| `admin.db`     | admin sign-in sessions                                 | bun-cache |
| `security.db`  | rate limits and origin blocks                          | bun-cache |

## Docker

```bash
docker build -t ucap-whatsapp-api .
docker run -p 3000:3000 -v investnow-data:/data --env-file .env ucap-whatsapp-api
```

The image runs in production mode: the admin UI is built in and served at
`/admin`, while the simulator and the dev type sync are left out. It includes a
healthcheck on `/health`.

## Project layout

Each module keeps its zod DTOs in `<name>.dto.ts` and its types in `<name>.interface.ts`.

```
src/
  main.ts, app.module.ts, config.ts       bootstrap and settings
  whatsapp/                               webhook controller, origin checks, Graph API client, message builders
  queue/                                  the bun-jobs context and the inbound/outbound queues
  conversation/                           the state machine, its parsers and the product catalogue
  database/                               Bun.SQL schema, users and session-log repositories
  admin/                                  sign-in, admin API, jobs API and dashboard mounts
  security/                               throttler storage, client address
  dev/                                    the simulator API and the UI-facing OpenAPI document
  shared/                                 phone validation (`phone` package), shared by the API and the UIs
ui/                                       React UIs (Bun bundles TSX and nested CSS) and their dev server
scripts/                                  dev runner, admin creation, OpenAPI export
test/                                     bun test: parsers, state machine, webhook, admin
```

## Checks

```bash
bun run verify     # bun check, bun lint, bun fmt --check, ui:types:check, bun test
bun format         # bun fmt
```
