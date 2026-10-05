import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { fetchTextWithRetry, fetchWithRetry } from "./http";

// Loopback only: no providers, credentials, databases, or real ingestion.
describe("native fetch cancellation", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  });

  it("closes a stalled HTTP body when the deadline aborts native fetch", async () => {
    let bodyClosed = false;
    let closed!: () => void;
    const closing = new Promise<void>(resolve => { closed = resolve; });
    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.flushHeaders();
      response.write("unfinished body");
      response.on("close", () => { bodyClosed = true; closed(); });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback listener");
    await expect(fetchTextWithRetry(`http://127.0.0.1:${address.port}`, undefined, {
      timeoutMs: 1000, maxRetries: 0, classifyFailures: true
    })).rejects.toMatchObject({
      kind: "timeout", diagnostic: { requestPhase: "body", httpStatus: 200 }
    });
    await closing;
    expect(bodyClosed).toBe(true);
  });

  it.each([200, 400, 503])("keeps final HTTP %i raw response bodies readable by existing adapters", async (status) => {
    server = createServer((_request, response) => {
      response.writeHead(status);
      response.end("fixture body");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback listener");
    const response = await fetchWithRetry(`http://127.0.0.1:${address.port}`, undefined, {
      timeoutMs: 1000, maxRetries: 0
    });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("fixture body");
  });
});
