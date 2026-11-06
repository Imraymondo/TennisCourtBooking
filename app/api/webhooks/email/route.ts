import { handleInboundEmail } from "@/lib/channels/email";
import { webhookFailure } from "@/lib/channels/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return Response.json(await handleInboundEmail(request), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return webhookFailure(error);
  }
}
