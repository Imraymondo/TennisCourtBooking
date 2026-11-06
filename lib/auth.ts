import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { AppError, getDatabase, hash } from "./store";

export const SESSION_COOKIE = "courtside_session";
const SESSION_MS = 8 * 60 * 60 * 1000;

function adminPassword(): string | null {
  const configured = process.env.ADMIN_PASSWORD;
  if (configured) return configured.length >= 12 ? configured : null;
  if (process.env.NODE_ENV === "production") return null;
  const directory = path.join(process.cwd(), ".data");
  const filename = path.join(directory, "admin-password");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(filename)) {
    try {
      writeFileSync(filename, randomBytes(24).toString("base64url"), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  chmodSync(filename, 0o600);
  return readFileSync(filename, "utf8").trim();
}

export function ensureAdminConfigured(): boolean {
  return adminPassword() !== null;
}

function cookieValue(request: Request): string | undefined {
  const values = request.headers.get("cookie")?.split(";") ?? [];
  const item = values.find((value) =>
    value.trim().startsWith(`${SESSION_COOKIE}=`),
  );
  const value = item?.trim().slice(SESSION_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export function isAdmin(request: Request): boolean {
  const token = cookieValue(request);
  if (!token) return false;
  const password = adminPassword();
  if (!password) return false;
  const row = getDatabase()
    .prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
    .get(hash(`${token}:${hash(password)}`));
  return !!row && Number(row.expires_at) > Date.now();
}

export function requireAdmin(request: Request): void {
  if (!isAdmin(request)) throw new AppError("请先登录工作人员账户", 401);
}

export function login(password: unknown): string {
  const expected = adminPassword();
  if (!expected)
    throw new AppError(
      "工作人员登录尚未配置，请设置至少 12 位的 ADMIN_PASSWORD",
      503,
    );
  if (
    typeof password !== "string" ||
    password.length > 256 ||
    !timingSafeEqual(Buffer.from(hash(password)), Buffer.from(hash(expected)))
  ) {
    throw new AppError("密码不正确", 401);
  }
  const token = randomBytes(32).toString("base64url");
  const db = getDatabase();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)").run(
    hash(`${token}:${hash(expected)}`),
    Date.now() + SESSION_MS,
  );
  return token;
}

export function logout(request: Request): void {
  const token = cookieValue(request);
  const password = token ? adminPassword() : null;
  if (token && password)
    getDatabase()
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(hash(`${token}:${hash(password)}`));
}

export function sessionCookie(
  request: Request,
  token: string,
  clear = false,
): string {
  const secure =
    new URL(request.url).protocol === "https:" ||
    process.env.NODE_ENV === "production";
  return `${SESSION_COOKIE}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? "; Secure" : ""}`;
}
