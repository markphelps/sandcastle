/**
 * Cloudflare Sandbox isolated provider — drives a user-deployed bridge Worker
 * over HTTPS. The Worker fronts `@cloudflare/sandbox` (Container-backed
 * Durable Objects). One Cloudflare Sandbox is materialized per Sandcastle run.
 *
 * Usage:
 *   import { cloudflare } from "sandcastle/sandboxes/cloudflare";
 *   await run({
 *     agent: claudeCode("claude-opus-4-7"),
 *     sandbox: cloudflare({ workerUrl: "https://sandcastle.<acct>.workers.dev" }),
 *   });
 */

import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";

export interface CloudflareOptions {
  /** URL of the deployed bridge Worker. */
  readonly workerUrl: string;
  /**
   * Bearer token matching the Worker's `SANDCASTLE_AUTH_TOKEN` secret.
   * Falls back to `CLOUDFLARE_SANDCASTLE_TOKEN` from process.env.
   */
  readonly authToken?: string;
  /** Override the generated sandbox identifier. Default: crypto.randomUUID(). */
  readonly sandboxId?: string;
  /**
   * Absolute path inside the sandbox to use as the worktree. Must match the
   * WORKDIR baked into .sandcastle/Dockerfile. Default: "/workspace".
   */
  readonly worktreePath?: string;
  /** Injected fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /** Provider env merged at launch time. */
  readonly env?: Record<string, string>;
}

const DEFAULT_WORKTREE_PATH = "/workspace";

export type ExecStreamEvent =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number };

export async function* parseSseExecStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ExecStreamEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line.
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let parsed: ExecStreamEvent;
          try {
            parsed = JSON.parse(payload) as ExecStreamEvent;
          } catch (err) {
            throw new Error(
              `cloudflare: failed to parse SSE payload "${payload}": ${(err as Error).message}`,
            );
          }
          yield parsed;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const resolveAuthToken = (
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): string => {
  const resolved = explicit ?? env["CLOUDFLARE_SANDCASTLE_TOKEN"];
  if (!resolved) {
    throw new Error(
      "Cloudflare provider: no auth token. Pass `authToken` to cloudflare() " +
        "or set CLOUDFLARE_SANDCASTLE_TOKEN in your environment.",
    );
  }
  return resolved;
};

export const buildSandboxUrl = (
  workerUrl: string,
  sandboxId: string,
  suffix: string,
  query?: Record<string, string>,
): string => {
  const base = workerUrl.endsWith("/") ? workerUrl.slice(0, -1) : workerUrl;
  const url = new URL(`${base}/sandboxes/${sandboxId}${suffix}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
};

export const cloudflare = (
  options: CloudflareOptions,
): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "cloudflare",
    env: options.env,
    create: async (): Promise<IsolatedSandboxHandle> => {
      const fetchImpl = options.fetch ?? globalThis.fetch;
      const authToken = resolveAuthToken(options.authToken, process.env);
      const sandboxId = options.sandboxId ?? crypto.randomUUID();
      const worktreePath = options.worktreePath ?? DEFAULT_WORKTREE_PATH;
      const workerUrl = options.workerUrl;

      const authHeaders = (
        extra?: ConstructorParameters<typeof Headers>[0],
      ): Headers => {
        const h = new Headers(extra);
        h.set("authorization", `Bearer ${authToken}`);
        return h;
      };

      const requireOk = async (
        res: Response,
        what: string,
      ): Promise<Response> => {
        if (res.ok) return res;
        const body = await res.text().catch(() => "");
        throw new Error(
          `cloudflare ${what}: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
        );
      };

      const execImpl = async (
        command: string,
        opts?: {
          onLine?: (line: string) => void;
          cwd?: string;
          sudo?: boolean;
        },
      ): Promise<ExecResult> => {
        const url = buildSandboxUrl(workerUrl, sandboxId, "/exec");
        const body: Record<string, unknown> = {
          command,
          cwd: opts?.cwd ?? worktreePath,
        };
        if (opts?.sudo) body["sudo"] = true;
        const res = await requireOk(
          await fetchImpl(url, {
            method: "POST",
            headers: authHeaders({ "content-type": "application/json" }),
            body: JSON.stringify(body),
          }),
          "exec",
        );
        if (!res.body) {
          throw new Error("cloudflare exec: response had no body stream");
        }
        const stdoutLines: string[] = [];
        const stderrChunks: string[] = [];
        let exitCode = 0;
        for await (const ev of parseSseExecStream(res.body)) {
          if (ev.type === "stdout") {
            stdoutLines.push(ev.line);
            opts?.onLine?.(ev.line);
          } else if (ev.type === "stderr") {
            stderrChunks.push(ev.line);
          } else {
            exitCode = ev.code;
          }
        }
        return {
          stdout: stdoutLines.join("\n"),
          stderr: stderrChunks.join(""),
          exitCode,
        };
      };

      // Warm-up: materialize the Durable Object and verify connectivity.
      const warm = await execImpl(`mkdir -p ${JSON.stringify(worktreePath)}`);
      if (warm.exitCode !== 0) {
        throw new Error(
          `cloudflare: failed to initialize worktree (${worktreePath}): exit ${warm.exitCode}`,
        );
      }

      return {
        worktreePath,
        exec: execImpl,
        copyIn: async () => {
          throw new Error("copyIn: not yet implemented");
        },
        copyFileOut: async () => {
          throw new Error("copyFileOut: not yet implemented");
        },
        close: async () => {
          // implemented in a later task
        },
      };
    },
  });
