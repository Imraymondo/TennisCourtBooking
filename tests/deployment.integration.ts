import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Availability, Booking } from "../lib/domain";

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Launcher = {
  child: ChildProcess;
  completion: Promise<Exit>;
  exited: boolean;
  spawnFailed: boolean;
  stderr: string;
};

const publicOrigin = "https://booking-test.example";
const launchers: Launcher[] = [];
let directory: string;
let databasePath: string;
let password: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "courtside-deployment-test-"));
  databasePath = join(directory, "persistent", "bookings.sqlite");
  password = randomBytes(24).toString("base64url");
});

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function signalGroup(launcher: Launcher, signal: NodeJS.Signals) {
  if (!launcher.child.pid) return;
  try {
    if (process.platform === "win32") launcher.child.kill(signal);
    else process.kill(-launcher.child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

after(
  async () => {
    try {
      for (const launcher of launchers) {
        // The launcher owns its Next child; a process group is a cleanup fallback
        // even when a broken launcher exits before forwarding its shutdown signal.
        signalGroup(launcher, "SIGTERM");
        if (!launcher.exited) {
          try {
            await within(
              launcher.completion,
              2_000,
              "Test launcher did not stop.",
            );
          } catch {
            signalGroup(launcher, "SIGKILL");
            await within(
              launcher.completion,
              2_000,
              "Test launcher could not be terminated.",
            );
          }
        }
      }
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  },
  { timeout: 20_000 },
);

function environment(port: number): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const name of Object.keys(result)) {
    if (
      name.startsWith("TWILIO_") ||
      name.startsWith("POSTMARK_") ||
      name === "APP_BASE_URL"
    ) {
      result[name] = "";
    }
  }
  return {
    ...result,
    BOOKING_AI_ENABLED: "0",
    OPENAI_API_KEY: "",
    // Empty bindings prevent @next/env from reloading real provider settings
    // from a developer's .env.local during this isolated deployment check.
    APP_BASE_URL: "",
    TWILIO_ACCOUNT_SID: "",
    TWILIO_AUTH_TOKEN: "",
    TWILIO_PHONE_NUMBER: "",
    POSTMARK_INBOUND_SECRET: "",
    POSTMARK_SERVER_TOKEN: "",
    POSTMARK_FROM_EMAIL: "",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    BOOKING_DB_PATH: databasePath,
    ADMIN_PASSWORD: password,
    RENDER_EXTERNAL_URL: publicOrigin,
    PORT: String(port),
  };
}

function launch(env: NodeJS.ProcessEnv, captureError = false): Launcher {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "scripts", "start-production.mjs")],
    {
      cwd: process.cwd(),
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", captureError ? "pipe" : "ignore"],
    },
  );
  const launcher: Launcher = {
    child,
    completion: Promise.resolve({ code: null, signal: null }),
    exited: false,
    spawnFailed: false,
    stderr: "",
  };
  launcher.completion = new Promise<Exit>((resolve) => {
    child.once("error", () => {
      launcher.spawnFailed = true;
      launcher.exited = true;
      resolve({ code: null, signal: null });
    });
    child.once("exit", () => {
      launcher.exited = true;
    });
    child.once("close", (code, signal) => {
      launcher.exited = true;
      resolve({ code, signal });
    });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    // Keep bounded diagnostics in memory for assertions; never print them.
    launcher.stderr = (launcher.stderr + chunk.toString("utf8")).slice(-8_192);
  });
  launchers.push(launcher);
  return launcher;
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitUntilReady(launcher: Launcher, baseUrl: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert.ok(
      !launcher.exited && !launcher.spawnFailed,
      "Production launcher exited before health readiness; build the app first.",
    );
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch {
      // Next may still be starting; readiness polling has a fixed deadline.
    }
    await delay(100);
  }
  throw new Error(
    "Production health readiness did not succeed within 30 seconds.",
  );
}

async function api<T>(
  baseUrl: string,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const headers = new Headers();
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("origin", publicOrigin);
  }
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  return { response, body: (await response.json()) as T };
}

const invalidConfigurations = [
  { name: "missing admin password", field: "ADMIN_PASSWORD", value: undefined },
  { name: "short admin password", field: "ADMIN_PASSWORD", value: "too-short" },
  { name: "missing database path", field: "BOOKING_DB_PATH", value: undefined },
  {
    name: "relative database path",
    field: "BOOKING_DB_PATH",
    value: "relative.sqlite",
  },
] as const;

for (const invalid of invalidConfigurations) {
  test(
    `production launcher rejects ${invalid.name} before serving requests`,
    { timeout: 8_000 },
    async () => {
      const env = environment(await freePort());
      if (invalid.value === undefined) env[invalid.field] = "";
      else env[invalid.field] = invalid.value;
      const launcher = launch(env, true);
      const exit = await within(
        launcher.completion,
        5_000,
        "Invalid production configuration did not fail fast.",
      );
      assert.equal(
        launcher.spawnFailed,
        false,
        "The checked-in production launcher must execute.",
      );
      assert.ok(
        exit.code !== null && exit.code !== 0,
        "Unsafe production configuration must fail with a nonzero exit code.",
      );
      assert.ok(
        launcher.stderr.includes(invalid.field),
        "The failure should identify the required configuration name.",
      );
      assert.ok(
        !launcher.stderr.includes(password),
        "Launcher diagnostics must not disclose the staff password.",
      );
      assert.ok(
        !launcher.stderr.includes("too-short"),
        "Invalid configuration values must not be echoed.",
      );
    },
  );
}

test(
  "production launcher serves health and SSR, honors the public HTTPS origin, and persists bookings across restart",
  { timeout: 80_000 },
  async () => {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = environment(port);
    const first = launch(env);
    await waitUntilReady(first, baseUrl);

    const health = await api<{ status: string; service: string }>(
      baseUrl,
      "/api/health",
    );
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.service, "courtside");
    assert.ok(
      health.response.headers.get("cache-control")?.includes("no-store"),
      "Health readiness must not be cached.",
    );

    const homepage = await fetch(baseUrl, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(homepage.status, 200);
    assert.ok(
      (await homepage.text()).includes("COURTSIDE"),
      "The production launcher serves the application HTML.",
    );
    const input = {
      courtId: 1,
      startLocal: "2030-07-15T10:00",
      durationHours: 2,
      customerName: "部署持久化测试",
      email: "deployment@example.invalid",
      phone: "+61000000000",
    };
    // Requests remain local. Only the Origin header represents Render's public
    // HTTPS endpoint, exercising RENDER_EXTERNAL_URL -> APP_BASE_URL fallback.
    const created = await api<{ booking: Booking; accessCode: string }>(
      baseUrl,
      "/api/bookings",
      input,
    );
    assert.equal(
      created.response.status,
      201,
      "The public HTTPS origin is accepted behind the hosting proxy.",
    );
    assert.ok(/^\d{8}$/.test(created.body.booking.id));
    assert.ok(/^\d{10}$/.test(created.body.accessCode));

    first.child.kill("SIGTERM");
    await within(
      first.completion,
      8_000,
      "Production launcher must handle SIGTERM and stop Next.",
    );
    let stillServing = false;
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      await response.arrayBuffer();
      stillServing = true;
    } catch {
      // Expected: the launcher must stop its child rather than leave an orphan.
    }
    assert.equal(
      stillServing,
      false,
      "SIGTERM must stop the child HTTP server before the launcher exits.",
    );

    const restarted = launch(env);
    await waitUntilReady(restarted, baseUrl);
    const lookup = await api<{ booking: Booking }>(
      baseUrl,
      "/api/bookings/lookup",
      {
        id: created.body.booking.id,
        accessCode: created.body.accessCode,
      },
    );
    assert.equal(lookup.response.status, 200);
    assert.equal(lookup.body.booking.id, created.body.booking.id);
    assert.equal(lookup.body.booking.status, "confirmed");
    assert.equal(lookup.body.booking.version, 1);
    assert.ok(
      lookup.body.booking.email === input.email,
      "The persisted booking retains its contact details.",
    );

    const publicSchedule = await api<Availability>(
      baseUrl,
      "/api/availability?date=2030-07-15",
    );
    assert.equal(publicSchedule.response.status, 200);
    assert.ok(
      publicSchedule.body.courts[0].bookings.some(
        (booking) => booking.id === created.body.booking.id,
      ),
    );
    const publicText = JSON.stringify(publicSchedule.body);
    assert.ok(
      !publicText.includes(input.email) &&
        !publicText.includes(input.phone) &&
        !publicText.includes(created.body.accessCode),
      "The public persisted schedule omits contacts and management codes.",
    );
    const anonymousStaff = await api<Record<string, unknown>>(
      baseUrl,
      "/api/bookings",
    );
    assert.equal(anonymousStaff.response.status, 401);
    const anonymousText = JSON.stringify(anonymousStaff.body);
    assert.ok(
      !anonymousText.includes(input.email) &&
        !anonymousText.includes(input.phone) &&
        !anonymousText.includes(created.body.accessCode),
      "Unauthenticated staff requests disclose no private booking details.",
    );

    const login = await api<{ authenticated: boolean }>(
      baseUrl,
      "/api/admin/login",
      { password },
    );
    assert.equal(login.response.status, 200);
    assert.equal(login.body.authenticated, true);
    const setCookie = login.response.headers.get("set-cookie");
    assert.ok(
      setCookie &&
        setCookie.includes("HttpOnly") &&
        setCookie.includes("Secure"),
      "Production login uses a secure session cookie after restart.",
    );
    const staff = await api<{ bookings: Booking[] }>(
      baseUrl,
      "/api/bookings?date=2030-07-15",
      undefined,
      setCookie.split(";")[0],
    );
    assert.equal(staff.response.status, 200);
    assert.ok(
      staff.body.bookings.some(
        (booking) => booking.id === created.body.booking.id,
      ),
      "The same configured password grants staff access after restart.",
    );
  },
);
