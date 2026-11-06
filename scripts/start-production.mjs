import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

const root = fileURLToPath(new URL("../", import.meta.url));
process.env.NODE_ENV = "production";
nextEnv.loadEnvConfig(root, false);

function fail(message) {
  console.error(`Deployment configuration: ${message}`);
  process.exit(1);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 5) fail("Node.js 24.5+ within 24.x is required.");
if (
  !process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASSWORD.length < 12 ||
  process.env.ADMIN_PASSWORD.length > 256
) {
  fail(
    "Set ADMIN_PASSWORD to a unique password between 12 and 256 characters.",
  );
}
if (!process.env.BOOKING_DB_PATH || !isAbsolute(process.env.BOOKING_DB_PATH)) {
  fail(
    "Set BOOKING_DB_PATH to an absolute file path on a mounted persistent disk.",
  );
}
const origin =
  process.env.APP_BASE_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim();
try {
  const url = new URL(origin || "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new Error("Invalid origin");
  }
  process.env.APP_BASE_URL = url.origin;
} catch {
  fail(
    "Set APP_BASE_URL to the public HTTPS origin, or use Render's RENDER_EXTERNAL_URL.",
  );
}

const arguments_ = process.argv.slice(2);
if (
  arguments_.length &&
  !(arguments_.length === 2 && arguments_[0] === "--port")
) {
  fail("The supported command option is --port followed by a port number.");
}
const port = Number(arguments_[1] || process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  fail("PORT must be an integer from 1 to 65535.");

const next = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);
const child = spawn(
  process.execPath,
  [next, "start", "--hostname", "0.0.0.0", "--port", String(port)],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  },
);

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}
child.once("error", () => {
  console.error("The production web process could not start.");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGTERM" ? 0 : 1);
});
