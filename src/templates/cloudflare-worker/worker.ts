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

const streamExec = (
  sandbox: ReturnType<typeof getSandbox>,
  command: string,
  cwd: string | undefined,
  sudo: boolean | undefined,
): Response => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const emit = (event: unknown) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

  (async () => {
    try {
      // The SDK exposes streaming exec; the exact method name is pinned
      // against the installed @cloudflare/sandbox version. As of writing
      // it is `sandbox.execStream({ command, cwd, sudo })` returning an
      // async iterable of { type: "stdout"|"stderr", data: string } plus
      // a final exitCode property/promise. Adapt if the SDK differs.
      const stream = sandbox.execStream({ command, cwd, sudo });
      let partialOut = "";
      let partialErr = "";
      for await (const chunk of stream) {
        const target = chunk.type === "stdout" ? "stdout" : "stderr";
        const buffer = target === "stdout" ? partialOut : partialErr;
        const text = buffer + chunk.data;
        const lines = text.split("\n");
        const carry = lines.pop() ?? "";
        if (target === "stdout") partialOut = carry;
        else partialErr = carry;
        for (const line of lines) {
          await emit({ type: target, line });
        }
      }
      if (partialOut) await emit({ type: "stdout", line: partialOut });
      if (partialErr) await emit({ type: "stderr", line: partialErr });
      const exitCode = await stream.exitCode;
      await emit({ type: "exit", code: exitCode ?? 0 });
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
      const { command, cwd, sudo } = (await request.json()) as {
        command: string;
        cwd?: string;
        sudo?: boolean;
      };
      return streamExec(sandbox, command, cwd, sudo);
    }

    if (rest === "/files") {
      const path = url.searchParams.get("path");
      if (!path) return new Response("missing path", { status: 400 });
      if (request.method === "PUT") {
        const bytes = await request.arrayBuffer();
        await sandbox.writeFile(path, new Uint8Array(bytes));
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        const file = await sandbox.readFile(path);
        return new Response(file.content);
      }
    }

    if (request.method === "POST" && rest === "/files/extract") {
      const path = url.searchParams.get("path");
      if (!path) return new Response("missing path", { status: 400 });
      const tmp = `/tmp/sandcastle-${crypto.randomUUID()}.tar.gz`;
      const bytes = await request.arrayBuffer();
      await sandbox.writeFile(tmp, new Uint8Array(bytes));
      const escapedPath = path.replace(/'/g, "'\\''");
      await sandbox.exec(
        `mkdir -p '${escapedPath}' && tar -xzf '${tmp}' -C '${escapedPath}' && rm -f '${tmp}'`,
      );
      return new Response(null, { status: 204 });
    }

    return notFound();
  },
};
