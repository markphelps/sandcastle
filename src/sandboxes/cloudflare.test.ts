import { describe, expect, it } from "vitest";
import { buildSandboxUrl, cloudflare, resolveAuthToken } from "./cloudflare.js";

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
