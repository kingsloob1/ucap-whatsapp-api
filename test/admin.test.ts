import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { passwordProblem } from "../src/admin/admins.repository";
import { testApp } from "./helpers";

const ADMIN = {
  email: "ops@example.com",
  username: "opsadmin",
  password: "Correct-Horse-42",
};

let app: INestApplication;
let base: string;
/** One sign-in shared by the tests below: the login route allows 10 a minute per address. */
let cookie: string;

beforeAll(async () => {
  ({ app } = await testApp({
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_USERNAME: ADMIN.username,
    ADMIN_PASSWORD: ADMIN.password,
  }));
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  cookie = (await login()).cookie;
});

afterAll(async () => {
  await app.close();
});

const json = (body: unknown, cookie?: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
  },
  body: JSON.stringify(body),
});

async function login(identifier = ADMIN.username, password = ADMIN.password) {
  const res = await fetch(
    `${base}/admin/api/login`,
    json({ identifier, password }),
  );
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { res, cookie };
}

async function simulate(from: string, text: string, choiceId?: string) {
  await fetch(
    `${base}/dev/simulate`,
    json({ from, text, ...(choiceId ? { choiceId } : {}) }),
  );
}

test("passwords need length, variety and no username", () => {
  const who = { email: "ada@example.com", username: "adaobi" };
  expect(passwordProblem("Short1!", who)).toContain("12");
  expect(passwordProblem("alllowercaseletters", who)).toContain("three");
  expect(passwordProblem("Adaobi-is-great-1", who)).toContain("username");
  expect(passwordProblem("Correct-Horse-42", who)).toBeNull();
});

describe("sign-in", () => {
  test("refuses malformed input with 400", async () => {
    const res = await fetch(
      `${base}/admin/api/login`,
      json({ identifier: "a b", password: "" }),
    );
    expect(res.status).toBe(400);
  });

  test("refuses a wrong password with 401 and no cookie", async () => {
    const { res, cookie } = await login(ADMIN.username, "Wrong-Password-1");
    expect(res.status).toBe(401);
    expect(cookie).toBe("");
  });

  test("accepts the email (any case) or the username (beforeAll), with a locked-down cookie", async () => {
    const byEmail = await login("OPS@Example.com");
    expect(byEmail.res.status).toBe(200);
    const header = byEmail.res.headers.get("set-cookie")!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/admin");
    expect(await byEmail.res.json()).toMatchObject({
      admin: { email: ADMIN.email, username: ADMIN.username },
    });

    const me = await fetch(`${base}/admin/api/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
  });

  test("logout ends the session", async () => {
    const own = (await login()).cookie;
    await fetch(`${base}/admin/api/logout`, json({}, own));
    expect(
      (await fetch(`${base}/admin/api/me`, { headers: { cookie: own } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/admin/api/me`, { headers: { cookie } })).status,
    ).toBe(200);
  });

  test("an account is locked for 15 minutes after 5 wrong passwords, even with the right one", async () => {
    const { app: locked } = await testApp({
      ADMIN_EMAIL: "a2@example.com",
      ADMIN_USERNAME: "lockme",
      ADMIN_PASSWORD: ADMIN.password,
    });
    await locked.listen(0, "127.0.0.1");
    const url = `${await locked.getUrl()}/admin/api/login`;
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await fetch(
            url,
            json({ identifier: "lockme", password: "Wrong-Password-1" }),
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await fetch(
          url,
          json({ identifier: "lockme", password: ADMIN.password }),
        )
      ).status,
    ).toBe(429);
    await locked.close();
  });

  test("the login route is throttled per address", async () => {
    const { app: throttled } = await testApp();
    await throttled.listen(0, "127.0.0.1");
    const url = `${await throttled.getUrl()}/admin/api/login`;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await fetch(url, json({ identifier: `nobody${i}`, password: "x" })))
          .status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    await throttled.close();
  });
});

describe("sessions", () => {
  const waId = "2348031119999";

  beforeAll(async () => {
    await simulate(waId, "hi");
    await simulate(waId, "Proceed", "onboard:proceed");
    await simulate(waId, "22233344499");
  });

  test("need a signed-in admin", async () => {
    expect((await fetch(`${base}/admin/api/sessions`)).status).toBe(401);
  });

  test("are listed with their source, live step and status", async () => {
    const res = await fetch(
      `${base}/admin/api/sessions?source=simulator&status=active`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: {
        waId: string;
        step: string;
        source: string;
        status: string;
      }[];
    };
    expect(body.sessions.find((s) => s.waId === waId)).toMatchObject({
      source: "simulator",
      status: "active",
      step: "ask_dob",
    });

    const none = await fetch(`${base}/admin/api/sessions?source=whatsapp`, {
      headers: { cookie },
    });
    expect(
      ((await none.json()) as { sessions: { waId: string }[] }).sessions.some(
        (s) => s.waId === waId,
      ),
    ).toBe(false);
  });

  test("show the state and the messages with the BVN masked", async () => {
    const res = await fetch(`${base}/admin/api/sessions/${waId}`, {
      headers: { cookie },
    });
    const body = (await res.json()) as {
      state: { bvn: string };
      events: { text: string }[];
    };
    expect(body.state.bvn).toBe("*******4499");
    expect(JSON.stringify(body)).not.toContain("22233344499");
  });

  test("can be reset: the next message starts from the welcome", async () => {
    const res = await fetch(
      `${base}/admin/api/sessions/${waId}/reset`,
      json({}, cookie),
    );
    expect(await res.json()).toEqual({ wasLive: true });

    const detail = (await (
      await fetch(`${base}/admin/api/sessions/${waId}`, { headers: { cookie } })
    ).json()) as {
      session: { status: string; endReason: string };
      state: unknown;
    };
    expect(detail.session.status).toBe("ended");
    expect(detail.session.endReason).toBe("reset by admin opsadmin");
    expect(detail.state).toBeNull();

    const next = await fetch(
      `${base}/dev/simulate`,
      json({ from: waId, text: "22233344499" }),
    );
    expect(((await next.json()) as { step: string }).step).toBe(
      "onboarding_prompt",
    );
  });

  test("an unknown number is a 404", async () => {
    expect(
      (
        await fetch(`${base}/admin/api/sessions/2348000000999`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(404);
  });
});

describe("jobs dashboard", () => {
  test("the API needs a signed-in admin", async () => {
    expect((await fetch(`${base}/admin/jobs-api/queues`)).status).toBe(401);
    const res = await fetch(`${base}/admin/jobs-api/queues`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const names = (
      (await res.json()) as { items: { name: string }[] }
    ).items.map((q) => q.name);
    expect(names).toEqual(
      expect.arrayContaining(["whatsapp-inbound", "whatsapp-outbound"]),
    );
  });

  test("the UI sends a signed-out visitor to sign in, and comes back", async () => {
    const res = await fetch(`${base}/admin/jobs`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "/admin/?next=%2Fadmin%2Fjobs",
    );

    const ok = await fetch(`${base}/admin/jobs/`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/html");
  });
});
