import { AppError, hash, rateLimit } from "./store";

export function json(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { status, headers: result });
}

export function apiError(error: unknown): Response {
  if (error instanceof AppError)
    return json({ error: error.message }, error.status);
  if (error instanceof SyntaxError)
    return json({ error: "The request body is not valid JSON." }, 400);
  console.error(
    "Booking API failed:",
    error instanceof Error ? error.name : "UnknownError",
  );
  return json(
    {
      error: "The service is temporarily unavailable. Please try again later.",
    },
    500,
  );
}

export function ensureSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  let actualOrigin = requestUrl.origin;
  if (host !== null) {
    // NextRequest normalizes loopback URLs (127.0.0.1 and [::1]) to localhost.
    // Browser origin authority must match the original HTTP Host, including its
    // port, rather than that internal URL. Forwarded hosts are not trusted here;
    // deployments behind a proxy can explicitly configure APP_BASE_URL.
    if (!host || /[\s/@\\?#]/.test(host))
      throw new AppError("This request origin is not allowed.", 403);
    try {
      actualOrigin = new URL(`${requestUrl.protocol}//${host}`).origin;
    } catch {
      throw new AppError("This request origin is not allowed.", 403);
    }
  }
  const allowed = [actualOrigin];
  if (process.env.APP_BASE_URL) {
    try {
      const configured = new URL(process.env.APP_BASE_URL);
      if (
        (configured.protocol === "https:" || configured.protocol === "http:") &&
        !configured.username &&
        !configured.password
      ) {
        allowed.push(configured.origin);
      }
    } catch {
      /* invalid setting grants nothing */
    }
  }
  if (!allowed.includes(origin))
    throw new AppError("This request origin is not allowed.", 403);
}

export async function readJson<T = Record<string, unknown>>(
  request: Request,
): Promise<T> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json")
  )
    throw new AppError("Please send the request as application/json.", 415);
  if (Number(request.headers.get("content-length")) > 16_384)
    throw new AppError("The request body is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("The request body is empty.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) {
        await reader.cancel();
        throw new AppError("The request body is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AppError("The request body must be an object.");
  return parsed as T;
}

export function limitRequest(
  request: Request,
  scope: string,
  limit = 60,
  windowMs = 15 * 60 * 1000,
) {
  // A reverse proxy must replace untrusted forwarding headers in production.
  const address =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  rateLimit(`http:${scope}:${hash(address)}`, limit, windowMs);
}
