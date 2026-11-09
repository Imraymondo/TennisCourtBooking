import { createServer, request as httpRequest } from "node:http";

// Voice and explicitly enabled SMS callbacks can cross the tunnel. The website
// and staff endpoints remain local; email is not enabled by this relay.
export function createVoiceRelay({
  upstreamPort,
  deadlineMs = 10_000,
  maxBodyBytes = 32_768,
  allowSms = false,
}) {
  if (
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65535
  ) {
    throw new Error("Invalid local upstream port");
  }
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes < 1
  ) {
    throw new Error("Invalid local relay limits");
  }
  const server = createServer(
    {
      maxHeaderSize: 16_384,
      headersTimeout: Math.min(5_000, deadlineMs),
      requestTimeout: deadlineMs,
    },
    (incoming, outgoing) => {
      let upstream;
      const send = (status, text, type = "text/plain; charset=utf-8") => {
        if (outgoing.destroyed || outgoing.writableEnded) return;
        outgoing.writeHead(status, {
          "content-type": type,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        outgoing.end(text);
      };
      const path = incoming.url?.split("?")[0];
      if (
        path !== "/api/webhooks/voice" &&
        !(allowSms === true && path === "/api/webhooks/sms")
      ) {
        incoming.resume();
        send(404, "Not found");
        return;
      }
      if (incoming.method !== "POST") {
        incoming.resume();
        outgoing.setHeader("allow", "POST");
        send(405, "POST required");
        return;
      }
      const signature = incoming.headers["x-twilio-signature"];
      if (
        typeof signature !== "string" ||
        !signature ||
        signature.length > 256
      ) {
        incoming.resume();
        send(403, "Twilio signature required");
        return;
      }
      const contentType = incoming.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        !contentType
          .toLowerCase()
          .startsWith("application/x-www-form-urlencoded")
      ) {
        incoming.resume();
        send(415, "Form content required");
        return;
      }
      if (Number(incoming.headers["content-length"] || 0) > maxBodyBytes) {
        outgoing.once("finish", () => incoming.destroy());
        send(413, "Request too large");
        return;
      }

      const timer = setTimeout(() => {
        upstream?.destroy();
        outgoing.once("finish", () => incoming.destroy());
        send(504, "Local service timed out");
      }, deadlineMs);
      timer.unref();
      outgoing.once("finish", () => clearTimeout(timer));
      outgoing.once("close", () => {
        clearTimeout(timer);
        upstream?.destroy();
      });
      incoming.once("error", () => {
        clearTimeout(timer);
        upstream?.destroy();
        send(400, "Incomplete request");
      });
      const chunks = [];
      let bytes = 0;
      let oversized = false;
      incoming.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) {
          oversized = true;
          chunks.length = 0;
          incoming.pause();
          outgoing.once("finish", () => incoming.destroy());
          send(413, "Request too large");
        } else if (!oversized) chunks.push(chunk);
      });
      incoming.once("end", () => {
        if (oversized || outgoing.writableEnded || outgoing.destroyed) return;
        const body = Buffer.concat(chunks);
        upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port: upstreamPort,
            path: incoming.url,
            method: "POST",
            agent: false,
            headers: {
              "content-type": contentType,
              "content-length": body.length,
              "x-twilio-signature": signature,
            },
          },
          (response) => {
            const reply = [];
            let responseBytes = 0;
            let responseOversized = false;
            response.on("data", (chunk) => {
              responseBytes += chunk.length;
              if (responseBytes > 131_072) {
                responseOversized = true;
                response.destroy();
                send(502, "Invalid local response");
              } else reply.push(chunk);
            });
            response.once("error", () =>
              send(502, "Local service unavailable"),
            );
            response.once("end", () => {
              if (responseOversized) return;
              if (response.statusCode >= 300 && response.statusCode < 400) {
                send(502, "Unexpected local redirect");
                return;
              }
              send(
                response.statusCode || 502,
                Buffer.concat(reply),
                response.headers["content-type"] || "text/plain; charset=utf-8",
              );
            });
          },
        );
        upstream.once("error", () => send(502, "Local service unavailable"));
        upstream.end(body);
      });
    },
  );
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  });
  return server;
}
