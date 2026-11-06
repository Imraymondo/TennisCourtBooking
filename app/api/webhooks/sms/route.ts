import { executeCommand } from "@/lib/channels/commands";
import {
  channelError,
  escapeXml,
  verifiedTwilioForm,
  webhookFailure,
  xmlResponse,
} from "@/lib/channels/security";
import { AppError, rateLimit, runChannelEvent } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const form = await verifiedTwilioForm(request);
    const messageId = form.get("MessageSid");
    if (!messageId || !/^[A-Za-z0-9]{10,64}$/.test(messageId))
      throw new AppError("缺少短信事件编号", 400);
    const reply = runChannelEvent(`sms:${messageId}`, () => {
      rateLimit(`sms:${form.get("From")}`, 30, 900_000);
      try {
        return executeCommand(form.get("Body") || "", {
          channel: "sms",
          phone: form.get("From")!,
        });
      } catch (error) {
        return channelError(error);
      }
    });
    return xmlResponse(`<Message>${escapeXml(reply)}</Message>`);
  } catch (error) {
    return webhookFailure(error);
  }
}
