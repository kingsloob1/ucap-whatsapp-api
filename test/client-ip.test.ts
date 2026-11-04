import { describe, expect, test } from "bun:test";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { clientIp } from "../src/security/client-ip";

/** A request as clientIp reads it: headers, the parsed X-Forwarded-For chain and the socket peer. */
function req(
  headers: Record<string, string | string[]>,
  ips: string[] = [],
  ip = "100.64.0.2",
): BunRequest {
  return { headers, ips, ip } as unknown as BunRequest;
}

const RAILWAY = { trustedProxies: 1, clientIpHeader: "x-real-ip" };

describe("clientIp", () => {
  test("reads the configured header, ahead of the forwarded chain", () => {
    const r = req({ "x-real-ip": "102.90.124.174" }, [
      "102.90.124.174",
      "152.233.76.10",
    ]);
    expect(clientIp(r, RAILWAY)).toBe("102.90.124.174");
  });

  test("accepts IPv6 in the header, and takes the first of repeated headers", () => {
    expect(clientIp(req({ "x-real-ip": "2001:db8::1" }), RAILWAY)).toBe(
      "2001:db8::1",
    );
    expect(
      clientIp(req({ "x-real-ip": ["203.0.113.7", "198.51.100.1"] }), RAILWAY),
    ).toBe("203.0.113.7");
  });

  test("falls back to the chain when the header is missing or not one address", () => {
    const chain = ["198.51.100.9", "152.233.76.10"];
    expect(clientIp(req({}, chain), RAILWAY)).toBe("152.233.76.10");
    for (const bad of [
      "",
      "not-an-ip",
      "1.2.3.4, 5.6.7.8",
      "999.1.1.1",
      "<script>",
    ]) {
      expect(clientIp(req({ "x-real-ip": bad }, chain), RAILWAY)).toBe(
        "152.233.76.10",
      );
    }
  });

  test("without a header setting, ignores the header (a caller could set it)", () => {
    const r = req({ "x-real-ip": "203.0.113.66" }, ["198.51.100.9"]);
    expect(clientIp(r, { trustedProxies: 1, clientIpHeader: "" })).toBe(
      "198.51.100.9",
    );
    expect(clientIp(r, { trustedProxies: 0, clientIpHeader: "" })).toBe(
      "100.64.0.2",
    );
  });

  test("counts trusted hops from the right of the chain", () => {
    const r = req({}, ["203.0.113.5", "198.51.100.1", "192.0.2.10"]);
    expect(clientIp(r, { trustedProxies: 1, clientIpHeader: "" })).toBe(
      "192.0.2.10",
    );
    expect(clientIp(r, { trustedProxies: 2, clientIpHeader: "" })).toBe(
      "198.51.100.1",
    );
    expect(clientIp(r, { trustedProxies: 9, clientIpHeader: "" })).toBe(
      "203.0.113.5",
    );
  });
});
