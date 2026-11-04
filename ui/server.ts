/**
 * The UIs' dev server: Bun bundles the chat UI (index.html) and the admin UI
 * (admin.html) on the fly, with hot reloading, and every other path, HTTP or
 * WebSocket, is proxied to the Nest API. The pages therefore call the API
 * same-origin, exactly as when Nest serves the built UIs.
 *
 *   bun --hot ui/server.ts      (UI_PORT, default 3001; API_URL, default http://127.0.0.1:$PORT or :3000)
 */
import type { ServerWebSocket } from "bun";
import admin from "./admin.html";
import chat from "./index.html";

const port = Number(process.env.UI_PORT ?? 3001);
const apiUrl = new URL(
  process.env.API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
);

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
];

/**
 * The request's headers as the API should see them. Origin and Referer are
 * rewritten to the API's own origin: the jobs API refuses cross-site mutations
 * and socket upgrades, and through this proxy every request is same-site.
 */
function forwardHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  if (headers.has("origin")) headers.set("origin", apiUrl.origin);
  if (headers.has("referer")) headers.set("referer", `${apiUrl.origin}/`);
  return headers;
}

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL(url.pathname + url.search, apiUrl);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders(req),
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.arrayBuffer(),
      redirect: "manual",
    });
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  } catch (error) {
    return Response.json(
      {
        statusCode: 502,
        error: "Bad Gateway",
        message: `The API at ${apiUrl.origin} isn't reachable: ${String(error)}`,
      },
      { status: 502 },
    );
  }
}

/* A WebSocket bridge, for the jobs dashboard's live events. */

interface Bridge {
  target: string;
  headers: Record<string, string>;
  protocols: string[];
  upstream?: WebSocket;
  pending: (string | Uint8Array<ArrayBuffer>)[];
}

const websocket = {
  open(ws: ServerWebSocket<Bridge>) {
    const { target, headers, protocols } = ws.data;
    const upstream = new WebSocket(target, {
      headers,
      protocols,
    } as unknown as string[]);
    upstream.binaryType = "arraybuffer";
    ws.data.upstream = upstream;
    upstream.onopen = () => {
      for (const message of ws.data.pending.splice(0)) upstream.send(message);
    };
    upstream.onmessage = (event) => {
      ws.send(
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer),
      );
    };
    upstream.onclose = (event) =>
      ws.close(event.code === 1005 ? 1000 : event.code, event.reason);
    upstream.onerror = () => ws.close(1011, "upstream error");
  },
  message(ws: ServerWebSocket<Bridge>, raw: string | Buffer) {
    const message = typeof raw === "string" ? raw : new Uint8Array(raw);
    const upstream = ws.data.upstream;
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
    else ws.data.pending.push(message);
  },
  close(ws: ServerWebSocket<Bridge>) {
    ws.data.upstream?.close();
  },
};

const server = Bun.serve<Bridge>({
  port,
  hostname: "127.0.0.1",
  development: { hmr: true, console: true },
  routes: {
    "/": chat,
    "/chat": chat,
    "/chat/": chat,
    "/admin": admin,
    "/admin/": admin,
  },
  fetch(req, srv) {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const url = new URL(req.url);
      const target = new URL(url.pathname + url.search, apiUrl);
      target.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
      const headers: Record<string, string> = { origin: apiUrl.origin };
      const cookie = req.headers.get("cookie");
      if (cookie) headers.cookie = cookie;
      const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (
        srv.upgrade(req, {
          data: { target: target.href, headers, protocols, pending: [] },
        })
      )
        return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return proxy(req);
  },
  websocket,
});

console.log(`Chat UI:  ${server.url}`);
console.log(
  `Admin UI: ${new URL("/admin/", server.url)}  (jobs dashboard at /admin/jobs/)`,
);
console.log(`API proxied to ${apiUrl.origin}`);
