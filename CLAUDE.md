# ucap-whatsapp-api

NestJS on Bun with the `@kingsleyweb/*` packages. See README.md for the architecture.

- **Bun only.** `bun install`, `bun test`, `bun check` (type check), `bun lint`, `bun fmt` (or `bun format`).
  `bun run verify` is the full gate. Don't name package.json scripts `check` or `lint`: they shadow Bun's built-ins.
- **Dependencies:** any package outside `@kingsleyweb/*` needs the user's approval before it is added.
- **Layout:** each module keeps its zod DTOs in `<name>.dto.ts` (schemas are named `…Dto`) and its
  TypeScript types in `<name>.interface.ts` (the inferred types keep the plain names). The `.dto.ts`
  files the UIs import (`src/dev/dev.dto.ts`, `src/admin/admin.dto.ts`) must stay browser-safe: zod and
  `src/shared/*` only.
- **Typed client:** `ui/src/api.gen.ts` is generated. Never edit it by hand: run `bun run ui:types:generate`
  (or keep `bun run ui:types` running), and commit it. CI's `ui:types:check` fails when it is stale.
- **Run from the project root:** Bun reads `emitDecoratorMetadata` from the working directory's tsconfig.json.
- **Database schema:** model-driven. Edit `src/database/schema.ts`, run `bun run db:generate -- --name <what>`,
  commit the migration it writes. Never edit an applied migration (it shows as `modified`); `bun run db:check`
  fails on model changes with no migration.
- **Webhook:** never throttle `/webhook`; it is protected by signature and origin checks (WebhookOriginService).
- **Git:** default branch `develop`; every change goes branch → commit → PR → merge, and every commit is
  signed (`develop` requires verified signatures).
