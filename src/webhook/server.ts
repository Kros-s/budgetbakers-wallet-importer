import http from "http";
import { processEmail, type EmailDeps, type EmailPayload } from "./email-processor.js";

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startWebhookServer(deps: EmailDeps): void {
  // Read at call time, after .env.local is loaded
  const SECRET = process.env.WEBHOOK_SECRET?.trim() ?? "";
  const PORT = Number(process.env.WEBHOOK_PORT ?? 8765);

  if (!SECRET) {
    console.warn("[webhook] WEBHOOK_SECRET not set — webhook server disabled.");
    return;
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook/email") {
      reply(res, 404, { error: "Not found" });
      return;
    }

    if (req.headers["x-webhook-secret"] !== SECRET) {
      console.warn("[webhook] Rejected — bad secret");
      reply(res, 401, { error: "Unauthorized" });
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", async () => {
      let payload: EmailPayload;
      try {
        payload = JSON.parse(body) as EmailPayload;
      } catch {
        reply(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!payload.from || !payload.text) {
        reply(res, 400, { error: "Missing required fields: from, text" });
        return;
      }

      try {
        const result = await processEmail(deps, payload);
        reply(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[webhook] Error:", message);
        reply(res, 500, { error: message });
      }
    });
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[webhook] Listening on 127.0.0.1:${PORT}`);
  });
}
