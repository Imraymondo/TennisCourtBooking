import { request as httpsRequest, Agent } from "node:https";
import { randomUUID } from "node:crypto";
import {
  AppError,
  claimChannelState,
  getChannelState,
  setChannelState,
  rateLimit,
  runChannelEvent,
} from "@/lib/store";
import { executeCommand } from "./commands";
import { channelError, limitedBody, timingSafeText } from "./security";

type InboundEmail = {
  MessageID?: unknown;
  From?: unknown;
  FromFull?: { Email?: unknown };
  Subject?: unknown;
  TextBody?: unknown;
  Headers?: { Name?: unknown; Value?: unknown }[];
};
type PreparedReply = { to: string; text: string };

export function emailConfigured() {
  return Boolean(
    process.env.POSTMARK_INBOUND_SECRET &&
      process.env.POSTMARK_SERVER_TOKEN &&
      process.env.POSTMARK_FROM_EMAIL &&
      process.env.POSTMARK_INBOUND_EMAIL,
  );
}

export function authenticateEmail(request: Request) {
  if (!emailConfigured()) throw new AppError("邮件渠道尚未配置", 503);
  const expected = `Basic ${Buffer.from(`postmark:${process.env.POSTMARK_INBOUND_SECRET}`).toString("base64")}`;
  if (!timingSafeText(request.headers.get("authorization") || "", expected))
    throw new AppError("无效的邮件渠道认证", 403);
}

function extractAddress(email: InboundEmail) {
  const raw =
    typeof email.FromFull?.Email === "string"
      ? email.FromFull.Email
      : typeof email.From === "string"
        ? email.From
        : "";
  const address = (raw.match(/<([^<>]+)>/)?.[1] || raw).trim().toLowerCase();
  if (address.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address))
    throw new AppError("发件人地址无效", 400);
  return address;
}

export function prepareEmail(email: InboundEmail): {
  id: string;
  reply: PreparedReply | null;
} {
  if (
    typeof email.MessageID !== "string" ||
    !/^[A-Za-z0-9-]{8,100}$/.test(email.MessageID)
  )
    throw new AppError("缺少邮件事件编号", 400);
  const to = extractAddress(email);
  const autoSubmitted = email.Headers?.some(
    (header) =>
      typeof header.Name === "string" &&
      header.Name.toLowerCase() === "auto-submitted" &&
      String(header.Value).toLowerCase() !== "no",
  );
  if (autoSubmitted || /^(mailer-daemon|postmaster)@/i.test(to))
    return { id: email.MessageID, reply: null };
  const subject = typeof email.Subject === "string" ? email.Subject.trim() : "";
  const body =
    typeof email.TextBody === "string"
      ? email.TextBody.trim()
          .split(/\r?\n/)
          .find((line) => line.trim()) || ""
      : "";
  // A command can be the complete subject, or the first non-empty plain-text line.
  const command =
    /^(查询|预订|预约|修改|取消|查看|帮助|QUERY\b|BOOK\b|CHANGE\b|CANCEL\b|VIEW\b|HELP\b)/i.test(
      subject,
    )
      ? subject
      : body || subject;
  return {
    id: email.MessageID,
    reply: runChannelEvent(`email:${email.MessageID}`, () => {
      rateLimit(`email:${to}`, 30, 900_000);
      try {
        return {
          to,
          text: executeCommand(command, { channel: "email", email: to }),
        };
      } catch (error) {
        return { to, text: channelError(error) };
      }
    }),
  };
}

export async function sendPostmarkEmail(reply: PreparedReply): Promise<void> {
  const from = process.env.POSTMARK_FROM_EMAIL!;
  const token = process.env.POSTMARK_SERVER_TOKEN!;
  const body = JSON.stringify({
    From: from,
    To: reply.to,
    Subject: "COURTSIDE 网球场预约回复",
    TextBody: reply.text,
    Headers: [{ Name: "Auto-Submitted", Value: "auto-replied" }],
  });
  // Node >=24.5 supports inherited HTTP(S)_PROXY/NO_PROXY through proxyEnv.
  // Node's inherited CA trust remains active; verification is never disabled.
  const agent = new Agent({ proxyEnv: process.env, keepAlive: false });
  try {
    await new Promise<void>((resolve, reject) => {
      const request = httpsRequest(
        "https://api.postmarkapp.com/email",
        {
          method: "POST",
          agent,
          signal: AbortSignal.timeout(15_000),
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "content-length": Buffer.byteLength(body),
            "X-Postmark-Server-Token": token,
          },
        },
        (response) => {
          let length = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 65_536) {
              response.destroy();
              reject(new AppError("邮件服务返回异常，请稍后重试", 502));
            } else chunks.push(chunk);
          });
          response.on("error", () =>
            reject(new AppError("邮件服务连接失败，请稍后重试", 502)),
          );
          response.on("end", () => {
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (
                response.statusCode !== 200 ||
                result.ErrorCode !== 0 ||
                typeof result.MessageID !== "string"
              )
                throw new Error("Rejected");
              resolve();
            } catch {
              reject(new AppError("回复邮件未被服务商接受，请稍后重试", 502));
            }
          });
        },
      );
      request.on("error", () =>
        reject(new AppError("邮件服务连接失败，请稍后重试", 502)),
      );
      request.setTimeout(15_000, () => request.destroy(new Error("timeout")));
      request.end(body);
    });
  } finally {
    agent.destroy();
  }
}

export async function handleInboundEmail(request: Request) {
  authenticateEmail(request);
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new AppError("不支持的请求格式", 415);
  let email: InboundEmail;
  try {
    const parsed: unknown = JSON.parse(await limitedBody(request, 65_536));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid");
    email = parsed as InboundEmail;
    if (
      email.Headers &&
      (!Array.isArray(email.Headers) ||
        email.Headers.some((header) => !header || typeof header !== "object"))
    )
      throw new Error("Invalid");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("邮件请求内容无效", 400);
  }
  const prepared = prepareEmail(email);
  if (!prepared.reply) return { status: "ignored" };
  const sentKey = `email:sent:${prepared.id}`;
  if (getChannelState(sentKey)) return { status: "already-replied" };
  const leaseKey = `email:delivery:${prepared.id}`;
  const nonce = randomUUID();
  const claimed = claimChannelState(leaseKey, nonce, 60_000);
  if (!claimed) throw new AppError("邮件回复正在发送，请稍后重试", 503);
  try {
    // Recheck after acquiring the lease because another request may have completed.
    if (getChannelState(sentKey)) return { status: "already-replied" };
    await sendPostmarkEmail(prepared.reply);
    setChannelState(sentKey, "sent", 365 * 24 * 60 * 60 * 1000);
    return { status: "replied" };
  } finally {
    if (getChannelState(leaseKey) === nonce) setChannelState(leaseKey, null);
  }
}
