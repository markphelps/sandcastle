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
      throw new Error("not yet implemented");
    },
  });
