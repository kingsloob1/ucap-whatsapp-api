import type { BunRequest } from "@kingsleyweb/bun-common";

/**
 * The client's address. bun-nest always parses `X-Forwarded-For` into
 * `req.ips`, so trusting it blindly would let anyone pick their own address
 * (and dodge every limit keyed on it). With `trustedProxies = 0` the socket
 * peer is used; with N, the address N hops in from the right of the chain,
 * the one the outermost trusted proxy saw.
 */
export function clientIp(req: BunRequest, trustedProxies: number): string {
  if (trustedProxies > 0) {
    const chain = [...req.ips, req.ip].filter(Boolean);
    const at = chain.length - 1 - trustedProxies;
    if (at >= 0) return chain[at]!;
    return chain[0] ?? "";
  }
  return req.ip;
}
