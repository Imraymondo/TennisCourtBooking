import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { ensureSameOrigin } from "../lib/http";
import { AppError } from "../lib/time";

function denied(work: () => unknown) {
  assert.throws(
    work,
    (error: unknown) => error instanceof AppError && error.status === 403,
  );
}

test("origin validation uses the actual HTTP Host despite Next loopback normalization", () => {
  for (const authority of ["127.0.0.1:3400", "[::1]:3400", "localhost:3400"]) {
    const origin = `http://${authority}`;
    const request = new NextRequest(`${origin}/api/bookings`, {
      headers: { host: authority, origin },
    });
    assert.equal(new URL(request.url).hostname, "localhost");
    assert.doesNotThrow(() => ensureSameOrigin(request));
  }
});

test("different hosts, loopback aliases, ports, schemes and forged forwarding headers are denied", () => {
  for (const origin of [
    "http://localhost:3400",
    "http://127.0.0.1:3401",
    "https://127.0.0.1:3400",
    "https://attacker.example",
    "null",
  ]) {
    const request = new NextRequest("http://127.0.0.1:3400/api/bookings", {
      headers: {
        host: "127.0.0.1:3400",
        origin,
        "x-forwarded-host": new URL(
          origin === "null" ? "https://attacker.example" : origin,
        ).host,
      },
    });
    denied(() => ensureSameOrigin(request));
  }
});

test("same-origin HTTPS proxy traffic uses its real Host authority", () => {
  const request = new Request("https://internal-service:3000/api/bookings", {
    headers: { host: "courts.example", origin: "https://courts.example" },
  });
  assert.doesNotThrow(() => ensureSameOrigin(request));
});

test("malformed Host authorities and cross-origin requests without Host are denied", () => {
  for (const host of [
    "attacker.example@courts.example",
    "courts.example/path",
    "courts.example?x",
    "courts.example#x",
    "courts.example\\other",
    "",
  ]) {
    const request = new Request("https://courts.example/api/bookings", {
      headers: { host, origin: "https://courts.example" },
    });
    denied(() => ensureSameOrigin(request));
  }
  denied(() =>
    ensureSameOrigin(
      new Request("https://courts.example/api/bookings", {
        headers: { origin: "https://attacker.example" },
      }),
    ),
  );
});

test("APP_BASE_URL explicitly permits a configured external origin while absent Origin stays valid", () => {
  const old = process.env.APP_BASE_URL;
  try {
    process.env.APP_BASE_URL = "https://booking.example";
    assert.doesNotThrow(() =>
      ensureSameOrigin(
        new Request("http://internal:3000/api/bookings", {
          headers: { host: "internal:3000", origin: "https://booking.example" },
        }),
      ),
    );
    process.env.APP_BASE_URL = "invalid setting";
    denied(() =>
      ensureSameOrigin(
        new Request("http://internal:3000/api/bookings", {
          headers: { host: "internal:3000", origin: "https://booking.example" },
        }),
      ),
    );
    process.env.APP_BASE_URL = "data:text/plain,invalid";
    denied(() =>
      ensureSameOrigin(
        new Request("http://internal:3000/api/bookings", {
          headers: { host: "internal:3000", origin: "null" },
        }),
      ),
    );
    assert.doesNotThrow(() =>
      ensureSameOrigin(new Request("https://booking.example/api/bookings")),
    );
  } finally {
    if (old === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = old;
  }
});
