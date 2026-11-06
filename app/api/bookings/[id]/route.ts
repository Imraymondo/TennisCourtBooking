import { cancelBooking, updateBooking } from "@/lib/store";
import { isAdmin } from "@/lib/auth";
import {
  apiError,
  ensureSameOrigin,
  json,
  limitRequest,
  readJson,
} from "@/lib/http";
import type { BookingInput } from "@/lib/domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    ensureSameOrigin(request);
    limitRequest(request, "mutate", 40);
    const { id } = await context.params;
    const input = await readJson<
      BookingInput & { version: number; accessCode?: string }
    >(request);
    return json({
      booking: updateBooking(id, input, input.accessCode, isAdmin(request)),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    ensureSameOrigin(request);
    limitRequest(request, "mutate", 40);
    const { id } = await context.params;
    const input = await readJson<{ version: number; accessCode?: string }>(
      request,
    );
    return json({
      booking: cancelBooking(
        id,
        input.version,
        input.accessCode,
        isAdmin(request),
      ),
    });
  } catch (error) {
    return apiError(error);
  }
}
