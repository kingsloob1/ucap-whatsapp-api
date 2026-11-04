import type { BunRequest } from "@kingsleyweb/bun-common";
import type { ClientIpConfig } from "./security.interface";

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+(%[\w.-]+)?$/i;

/** Whether a header value is a single, well-formed IPv4 or IPv6 address. */
function isIp(value: string): boolean {
  return IPV4.test(value) || (value.includes(":") && IPV6.test(value));
}

/**
 * The client's address, which rate limits and origin blocks are keyed on.
 *
 * - With `clientIpHeader` (e.g. `x-real-ip` on Railway, whose edge overwrites
 *   that header with the connecting client on every request), the header's
 *   value, when it holds one well-formed address. Only set it behind a proxy
 *   that overwrites the header: anywhere else a caller could choose its own.
 * - Otherwise, or when the header is missing or malformed (e.g. a request that
 *   didn't come through the edge), the forwarded chain: bun-nest always parses
 *   `X-Forwarded-For` into `req.ips`, so it is trusted only `trustedProxies`
 *   hops in from the right. `0` uses the socket peer.
 */
export function clientIp(req: BunRequest, config: ClientIpConfig): string {
  if (config.clientIpHeader) {
    const raw = req.headers[config.clientIpHeader];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value && isIp(value)) return value;
  }
  if (config.trustedProxies > 0) {
    const chain = [...req.ips, req.ip].filter(Boolean);
    const at = chain.length - 1 - config.trustedProxies;
    if (at >= 0) return chain[at]!;
    return chain[0] ?? "";
  }
  return req.ip;
}
