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

type FetchCall = { url: string; init: RequestInit };

const mockFetch = (responses: Response[]) => {
  const calls: FetchCall[] = [];
  let idx = 0;
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[idx++];
    if (!next) throw new Error("mockFetch: no more responses queued");
    return next;
  };
  return { fn, calls };
};

const sseResponse = (events: string[]): Response =>
  new Response(events.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

describe("create() + exec()", () => {
  it("creates a sandbox, executes a command, streams lines, and sends auth header", async () => {
    const { fn, calls } = mockFetch([
      // create() warmup mkdir
      sseResponse([`data: {"type":"exit","code":0}\n\n`]),
      // user-issued exec
      sseResponse([
        `data: {"type":"stdout","line":"hello"}\n\n`,
        `data: {"type":"stdout","line":"world"}\n\n`,
        `data: {"type":"stderr","line":"warn"}\n\n`,
        `data: {"type":"exit","code":0}\n\n`,
      ]),
    ]);
    const provider = cloudflare({
      workerUrl: "https://example.workers.dev",
      authToken: "tok",
      sandboxId: "sb-1",
      fetch: fn,
    });
    const handle = await provider.create({ env: {} });
    expect(handle.worktreePath).toBe("/workspace");

    const lines: string[] = [];
    const result = await handle.exec("echo hello", {
      onLine: (l) => lines.push(l),
    });
    expect(result).toEqual({
      stdout: "hello\nworld",
      stderr: "warn",
      exitCode: 0,
    });
    expect(lines).toEqual(["hello", "world"]);

    // Auth header is set on every request
    for (const call of calls) {
      const headers = new Headers(
        call.init.headers as ConstructorParameters<typeof Headers>[0],
      );
      expect(headers.get("authorization")).toBe("Bearer tok");
    }
    // First call: mkdir warmup
    expect(calls[0]!.url).toBe(
      "https://example.workers.dev/sandboxes/sb-1/exec",
    );
    // Second call: user exec
    expect(calls[1]!.init.method).toBe("POST");
    const body = JSON.parse(String(calls[1]!.init.body));
    expect(body).toEqual({ command: "echo hello", cwd: "/workspace" });
  });

  it("forwards non-zero exit code", async () => {
    const { fn } = mockFetch([
      sseResponse([`data: {"type":"exit","code":0}\n\n`]),
      sseResponse([`data: {"type":"exit","code":42}\n\n`]),
    ]);
    const provider = cloudflare({
      workerUrl: "https://example.workers.dev",
      authToken: "tok",
      sandboxId: "sb-1",
      fetch: fn,
    });
    const handle = await provider.create({ env: {} });
    const result = await handle.exec("false");
    expect(result.exitCode).toBe(42);
  });

  it("passes cwd and sudo through", async () => {
    const { fn, calls } = mockFetch([
      sseResponse([`data: {"type":"exit","code":0}\n\n`]),
      sseResponse([`data: {"type":"exit","code":0}\n\n`]),
    ]);
    const provider = cloudflare({
      workerUrl: "https://example.workers.dev",
      authToken: "tok",
      sandboxId: "sb-1",
      fetch: fn,
    });
    const handle = await provider.create({ env: {} });
    await handle.exec("ls", { cwd: "/elsewhere", sudo: true });
    const body = JSON.parse(String(calls[1]!.init.body));
    expect(body).toEqual({ command: "ls", cwd: "/elsewhere", sudo: true });
  });

  it("throws clear error on HTTP failure", async () => {
    const { fn } = mockFetch([
      sseResponse([`data: {"type":"exit","code":0}\n\n`]),
      new Response("nope", { status: 500 }),
    ]);
    const provider = cloudflare({
      workerUrl: "https://example.workers.dev",
      authToken: "tok",
      sandboxId: "sb-1",
      fetch: fn,
    });
    const handle = await provider.create({ env: {} });
    await expect(handle.exec("boom")).rejects.toThrow(/500/);
  });
});
