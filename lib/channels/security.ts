import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/store";

export function timingSafeText(actual: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export async function limitedBody(request: Request, maximum = 32_768) {
  const length = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(length) || length > maximum)
    throw new AppError("请求内容过大", 413);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new AppError("请求内容过大", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function channelError(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : "暂时无法处理，请稍后重试或联系工作人员。";
}

export function escapeXml(value: string) {
  return value.replace(
    /[<>&"']/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

export function baseUrl(): string {
  const raw = process.env.APP_BASE_URL;
  if (!raw) throw new AppError("电话和短信渠道尚未配置", 503);
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new AppError("APP_BASE_URL 必须是公开服务的 HTTPS origin", 503);
  }
  if (
    url.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  ) {
    throw new AppError("电话和短信渠道需要 HTTPS 地址", 503);
  }
  return url.origin;
}

export function twilioConfigured(): boolean {
  if (
    !process.env.TWILIO_AUTH_TOKEN?.trim() ||
    !process.env.TWILIO_PHONE_NUMBER
  )
    return false;
  try {
    baseUrl();
    return true;
  } catch {
    return false;
  }
}

// Verify the signed public callback URL and form independently of direction.
// Outbound call callbacks have the customer's number in To; their caller and
// recipient are checked against the saved attendance attempt by its handler.
export async function verifiedTwilioCallbackForm(
  request: Request,
): Promise<URLSearchParams> {
  if (!twilioConfigured()) throw new AppError("电话和短信渠道尚未配置", 503);
  if (
    !request.headers
      .get("content-type")
      ?.includes("application/x-www-form-urlencoded")
  ) {
    throw new AppError("不支持的请求格式", 415);
  }
  const form = new URLSearchParams(await limitedBody(request));
  const keys = [...new Set(form.keys())].sort();
  if (keys.some((key) => form.getAll(key).length !== 1))
    throw new AppError("重复的请求字段", 400);
  const path = new URL(request.url);
  const originalUrl = `${baseUrl()}${path.pathname}${path.search}`;
  const material =
    originalUrl + keys.map((key) => `${key}${form.get(key)}`).join("");
  const signature = createHmac("sha1", process.env.TWILIO_AUTH_TOKEN!.trim())
    .update(material)
    .digest("base64");
  if (
    !timingSafeText(request.headers.get("x-twilio-signature") || "", signature)
  ) {
    throw new AppError("无效的 Twilio 签名", 403);
  }
  return form;
}

export async function verifiedTwilioForm(
  request: Request,
): Promise<URLSearchParams> {
  const form = await verifiedTwilioCallbackForm(request);
  if (
    form.get("To") !== process.env.TWILIO_PHONE_NUMBER ||
    !/^\+\d{7,15}$/.test(form.get("From") || "")
  ) {
    throw new AppError("无效的收发号码", 400);
  }
  return form;
}

export function xmlResponse(xml: string) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`,
    {
      headers: {
        "content-type": "text/xml; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

export function webhookFailure(error: unknown) {
  return Response.json(
    { error: channelError(error) },
    {
      status: error instanceof AppError ? error.status : 500,
      headers: { "cache-control": "no-store" },
    },
  );
}
