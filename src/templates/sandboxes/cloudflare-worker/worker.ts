import { getSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace;
  SANDCASTLE_AUTH_TOKEN: string;
};

const unauthorized = () => new Response("unauthorized", { status: 401 });

const notFound = () => new Response("not found", { status: 404 });

const isAuthed = (req: Request, env: Env): boolean => {
  const got = req.headers.get("authorization");
  return got !== null && got === `Bearer ${env.SANDCASTLE_AUTH_TOKEN}`;
};

// Internal bindings the bridge owns — do NOT forward to the agent.
const BRIDGE_INTERNAL_KEYS = new Set(["SANDCASTLE_AUTH_TOKEN"]);

const collectAgentEnv = (env: Env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue; // skip DO bindings, etc.
    if (BRIDGE_INTERNAL_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
};

const streamExec = (
  sandbox: ReturnType<typeof getSandbox>,
  command: string,
  cwd: string | undefined,
  env: Env,
): Response => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const emit = (event: unknown): Promise<void> =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

  // Buffer partial lines so the wire format is always whole lines.
  let partialOut = "";
  let partialErr = "";

  (async () => {
    try {
      const execOpts: Record<string, unknown> = {
        stream: true,
        onOutput: (channel: "stdout" | "stderr", data: string) => {
          const prev = channel === "stdout" ? partialOut : partialErr;
          const text = prev + data;
          const lines = text.split("\n");
          const carry = lines.pop() ?? "";
          if (channel === "stdout") partialOut = carry;
          else partialErr = carry;
          for (const line of lines) {
            // Fire-and-forget: writes are ordered through the same writer.
            emit({ type: channel, line }).catch(() => {});
          }
        },
      };
      if (cwd !== undefined) execOpts["cwd"] = cwd;
      const agentEnv = collectAgentEnv(env);
      if (Object.keys(agentEnv).length > 0) execOpts["env"] = agentEnv;
      const result = await sandbox.exec(command, execOpts);
      if (partialOut) await emit({ type: "stdout", line: partialOut });
      if (partialErr) await emit({ type: "stderr", line: partialErr });
      await emit({ type: "exit", code: result.exitCode ?? 0 });
    } catch (err) {
      await emit({
        type: "stderr",
        line: `bridge error: ${(err as Error).message}`,
      });
      await emit({ type: "exit", code: 1 });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { "content-type": "text/event-stream" },
  });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthed(request, env)) return unauthorized();

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/sandboxes\/([^/]+)(\/.*)?$/);
    if (!match) return notFound();
    const id = match[1]!;
    const rest = match[2] ?? "";

    const sandbox = getSandbox(env.Sandbox, id);

    if (request.method === "DELETE" && rest === "") {
      try {
        await sandbox.destroy();
      } catch {
        // idempotent
      }
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && rest === "/exec") {
      const { command, cwd } = (await request.json()) as {
        command: string;
        cwd?: string;
      };
      return streamExec(sandbox, command, cwd, env);
    }

    if (rest === "/files") {
      const path = url.searchParams.get("path");
      if (!path) return new Response("missing path", { status: 400 });
      if (request.method === "PUT") {
        if (!request.body) return new Response("missing body", { status: 400 });
        // writeFile with ReadableStream only works on the RPC transport. The
        // default transport accepts a string + encoding, so we base64-encode.
        const bytes = await request.arrayBuffer();
        const b64 = Buffer.from(bytes).toString("base64");
        await sandbox.writeFile(path, b64, { encoding: "base64" });
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        // Read as base64 so binary is preserved; decode and return raw bytes.
        const file = await sandbox.readFile(path, { encoding: "base64" });
        const b64 = file.content as string;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes);
      }
    }

    if (request.method === "POST" && rest === "/files/extract") {
      const path = url.searchParams.get("path");
      if (!path) return new Response("missing path", { status: 400 });
      if (!request.body) return new Response("missing body", { status: 400 });
      const tmp = `/tmp/sandcastle-${crypto.randomUUID()}.tar.gz`;
      const bytes = await request.arrayBuffer();
      const b64 = Buffer.from(bytes).toString("base64");
      await sandbox.writeFile(tmp, b64, { encoding: "base64" });
      const escapedPath = path.replace(/'/g, "'\\''");
      await sandbox.exec(
        `mkdir -p '${escapedPath}' && tar -xzf '${tmp}' -C '${escapedPath}' && rm -f '${tmp}'`,
      );
      return new Response(null, { status: 204 });
    }

    return notFound();
  },
};
