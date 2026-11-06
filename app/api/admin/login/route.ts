import { login, sessionCookie } from "@/lib/auth";
import {
  apiError,
  ensureSameOrigin,
  json,
  limitRequest,
  readJson,
} from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    ensureSameOrigin(request);
    limitRequest(request, "login", 8);
    const input = await readJson<{ password: string }>(request);
    const token = login(input.password);
    return json({ authenticated: true }, 200, {
      "Set-Cookie": sessionCookie(request, token),
    });
  } catch (error) {
    return apiError(error);
  }
}
