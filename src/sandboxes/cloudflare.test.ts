import { describe, expect, it } from "vitest";
import {
  buildSandboxUrl,
  cloudflare,
  parseSseExecStream,
  resolveAuthToken,
  type ExecStreamEvent,
} from "./cloudflare.js";

describe("cloudflare()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'cloudflare'", () => {
    const provider = cloudflare({ workerUrl: "https://example.workers.dev" });
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("cloudflare");
  });

  it("defaults env to empty object when not provided", () => {
    const provider = cloudflare({ workerUrl: "https://example.workers.dev" });
    expect(provider.env).toEqual({});
  });

  it("accepts an env option", () => {
    const provider = cloudflare({
      workerUrl: "https://example.workers.dev",
      env: { CLOUDFLARE_VAR: "value" },
    });
    expect(provider.env).toEqual({ CLOUDFLARE_VAR: "value" });
  });
});

describe("resolveAuthToken()", () => {
  it("returns the explicit token when provided", () => {
    expect(
      resolveAuthToken("explicit", { CLOUDFLARE_SANDCASTLE_TOKEN: "env" }),
    ).toBe("explicit");
  });

  it("falls back to CLOUDFLARE_SANDCASTLE_TOKEN env var", () => {
    expect(
      resolveAuthToken(undefined, { CLOUDFLARE_SANDCASTLE_TOKEN: "env" }),
    ).toBe("env");
  });

  it("throws when neither is set", () => {
    expect(() => resolveAuthToken(undefined, {})).toThrow(
      /CLOUDFLARE_SANDCASTLE_TOKEN/,
    );
  });
});

const streamFromChunks = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
};

describe("parseSseExecStream()", () => {
  it("parses stdout, stderr, and exit events", async () => {
    const stream = streamFromChunks([
      `data: {"type":"stdout","line":"hello"}\n\n`,
      `data: {"type":"stderr","line":"warn"}\n\n`,
      `data: {"type":"exit","code":0}\n\n`,
    ]);
    const events: ExecStreamEvent[] = [];
    for await (const ev of parseSseExecStream(stream)) events.push(ev);
    expect(events).toEqual([
      { type: "stdout", line: "hello" },
      { type: "stderr", line: "warn" },
      { type: "exit", code: 0 },
    ]);
  });

  it("handles events split across chunks", async () => {
    const stream = streamFromChunks([
      `data: {"type":"stdout","line":"hel`,
      `lo"}\n\ndata: {"type":"exit","code":1}\n\n`,
    ]);
    const events: ExecStreamEvent[] = [];
    for await (const ev of parseSseExecStream(stream)) events.push(ev);
    expect(events).toEqual([
      { type: "stdout", line: "hello" },
      { type: "exit", code: 1 },
    ]);
  });

  it("ignores non-data lines (comments, retry directives)", async () => {
    const stream = streamFromChunks([
      `: keepalive\n\n`,
      `retry: 1000\n\n`,
      `data: {"type":"exit","code":0}\n\n`,
    ]);
    const events: ExecStreamEvent[] = [];
    for await (const ev of parseSseExecStream(stream)) events.push(ev);
    expect(events).toEqual([{ type: "exit", code: 0 }]);
  });

  it("throws on malformed JSON", async () => {
    const stream = streamFromChunks([`data: not-json\n\n`]);
    await expect(async () => {
      for await (const _ of parseSseExecStream(stream)) {
        // consume
      }
    }).rejects.toThrow(/parse/i);
  });
});

describe("buildSandboxUrl()", () => {
  it("joins worker URL and path without double slashes", () => {
    expect(
      buildSandboxUrl("https://example.workers.dev/", "sb-1", "/exec"),
    ).toBe("https://example.workers.dev/sandboxes/sb-1/exec");
  });

  it("handles workerUrl without trailing slash", () => {
    expect(buildSandboxUrl("https://example.workers.dev", "sb-1", "")).toBe(
      "https://example.workers.dev/sandboxes/sb-1",
    );
  });

  it("appends query string when provided", () => {
    expect(
      buildSandboxUrl("https://example.workers.dev", "sb-1", "/files", {
        path: "/workspace/x",
      }),
    ).toBe(
      "https://example.workers.dev/sandboxes/sb-1/files?path=%2Fworkspace%2Fx",
    );
  });
});
