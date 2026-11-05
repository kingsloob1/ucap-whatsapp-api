/**
 * Sets up InvestNow's WhatsApp Flows on Meta (Graph API), from the Flow JSON
 * in src/flows/definitions.ts. Reads the WhatsApp settings from the
 * environment (.env), like the service.
 *
 *   bun run flows keys [dir]              new RSA key pair in dir (default .flow-keys/, git-ignored)
 *   bun run flows upload-key              registers the public key of WHATSAPP_FLOW_PRIVATE_KEY on the phone number
 *   bun run flows sync <endpoint> [--app <app id>] [--publish]
 *                                         creates the Flows without a WHATSAPP_FLOW_ID_*, uploads the Flow JSON
 *                                         of the others, sets the endpoint (https://<host>/flows) and the app
 *   bun run flows status                  each Flow's status, validation errors and health
 *
 * A published Flow can't be changed: `sync` then creates a new one, and its id
 * replaces the old one in WHATSAPP_FLOW_ID_*.
 */
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { FLOW_DEFINITIONS } from "../src/flows/definitions";
import { loadPrivateKey } from "../src/flows/flow-crypto";
import type { FlowName } from "../src/flows/flows.interface";

const NAMES: Record<FlowName, { name: string; categories: string[] }> = {
  onboarding: { name: "InvestNow onboarding", categories: ["SIGN_UP"] },
  pin: { name: "InvestNow PIN approval", categories: ["OTHER"] },
  transaction: {
    name: "InvestNow fund, withdraw, buy",
    categories: ["OTHER"],
  },
};
const ENV: Record<FlowName, string> = {
  onboarding: "WHATSAPP_FLOW_ID_ONBOARDING",
  pin: "WHATSAPP_FLOW_ID_PIN",
  transaction: "WHATSAPP_FLOW_ID_TRANSACTION",
};

const config = loadConfig();
const { accessToken, businessAccountId, phoneNumberId, graphApiVersion } =
  config.whatsapp;
const GRAPH = `https://graph.facebook.com/${graphApiVersion}`;

function need(value: string, name: string): string {
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

async function graph(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, string> | FormData,
): Promise<Record<string, unknown>> {
  const form =
    body instanceof FormData
      ? body
      : body
        ? (() => {
            const f = new FormData();
            for (const [k, v] of Object.entries(body)) f.set(k, v);
            return f;
          })()
        : undefined;
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${need(accessToken, "WHATSAPP_ACCESS_TOKEN")}`,
    },
    ...(form ? { body: form } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = json.error as
      { message?: string; error_user_msg?: string } | undefined;
    throw new Error(
      `${method} ${path}: ${res.status} ${error?.error_user_msg ?? error?.message ?? JSON.stringify(json)}`,
    );
  }
  return json;
}

function printErrors(flow: FlowName, result: Record<string, unknown>): void {
  const errors = (result.validation_errors ?? []) as unknown[];
  if (errors.length === 0) return;
  console.log(`  ${flow}: ${errors.length} validation error(s)`);
  for (const e of errors) console.log(`    ${JSON.stringify(e)}`);
}

async function keys(dir = ".flow-keys"): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const out = resolve(dir);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, "private.pem"), privateKey, { mode: 0o600 });
  writeFileSync(join(out, "public.pem"), publicKey);
  console.log(`Wrote ${join(out, "private.pem")} and public.pem.`);
  console.log(
    "Set WHATSAPP_FLOW_PRIVATE_KEY to the private key (a PEM; literal \\n line breaks work), then run `bun run flows upload-key`.",
  );
}

async function uploadKey(): Promise<void> {
  const { privateKey, privateKeyPassphrase } = config.whatsapp.flows;
  const key = loadPrivateKey(
    need(privateKey, "WHATSAPP_FLOW_PRIVATE_KEY"),
    privateKeyPassphrase,
  );
  const pem = createPublicKey(key).export({ type: "spki", format: "pem" });
  await graph(
    "POST",
    `${need(phoneNumberId, "WHATSAPP_PHONE_NUMBER_ID")}/whatsapp_business_encryption`,
    { business_public_key: String(pem) },
  );
  console.log(`Public key registered on phone number ${phoneNumberId}.`);
}

async function sync(args: string[]): Promise<void> {
  const endpoint = args.find((a) => a.startsWith("https://"));
  if (!endpoint) {
    console.error(
      "Usage: bun run flows sync https://<host>/flows [--app <id>] [--publish]",
    );
    process.exit(1);
  }
  const appAt = args.indexOf("--app");
  const appId = appAt >= 0 ? args[appAt + 1] : undefined;
  const publish = args.includes("--publish");
  const waba = need(businessAccountId, "WHATSAPP_BUSINESS_ACCOUNT_ID");

  for (const flow of Object.keys(FLOW_DEFINITIONS) as FlowName[]) {
    const json = JSON.stringify(FLOW_DEFINITIONS[flow]);
    let id = config.whatsapp.flows.ids[flow];
    if (id) {
      const current = await graph("GET", `${id}?fields=status`);
      if (current.status === "PUBLISHED") {
        console.log(
          `  ${flow}: ${id} is published (read-only): creating a new Flow`,
        );
        id = "";
      }
    }
    if (id) {
      const form = new FormData();
      form.set(
        "file",
        new Blob([json], { type: "application/json" }),
        "flow.json",
      );
      form.set("name", "flow.json");
      form.set("asset_type", "FLOW_JSON");
      printErrors(flow, await graph("POST", `${id}/assets`, form));
      await graph("POST", id, { endpoint_uri: endpoint });
      console.log(`  ${flow}: updated ${id}`);
    } else {
      const created = await graph("POST", `${waba}/flows`, {
        name: NAMES[flow].name,
        categories: JSON.stringify(NAMES[flow].categories),
        flow_json: json,
        endpoint_uri: endpoint,
      });
      id = String(created.id);
      printErrors(flow, created);
      console.log(`  ${flow}: created ${id}  →  set ${ENV[flow]}=${id}`);
    }
    if (appId) await graph("POST", id, { application_id: appId });
    if (publish) {
      await graph("POST", `${id}/publish`);
      console.log(`  ${flow}: published`);
    }
  }
}

async function status(): Promise<void> {
  for (const flow of Object.keys(ENV) as FlowName[]) {
    const id = config.whatsapp.flows.ids[flow];
    if (!id) {
      console.log(`${flow}: no ${ENV[flow]}`);
      continue;
    }
    const f = await graph(
      "GET",
      `${id}?fields=name,status,json_version,endpoint_uri,validation_errors,health_status`,
    );
    console.log(
      `${flow}: ${id} ${String(f.name)} · ${String(f.status)} · ${String(f.endpoint_uri ?? "no endpoint")}`,
    );
    printErrors(flow, f);
    const health = f.health_status as
      { can_send_message?: string; entities?: unknown[] } | undefined;
    if (health) {
      console.log(`  can send: ${health.can_send_message ?? "?"}`);
      for (const e of health.entities ?? [])
        console.log(`    ${JSON.stringify(e)}`);
    }
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "keys":
    await keys(rest[0]);
    break;
  case "upload-key":
    await uploadKey();
    break;
  case "sync":
    await sync(rest);
    break;
  case "status":
    await status();
    break;
  default:
    console.log(
      "Usage: bun run flows keys|upload-key|sync|status (see scripts/flows.ts)",
    );
    process.exit(command ? 1 : 0);
}
