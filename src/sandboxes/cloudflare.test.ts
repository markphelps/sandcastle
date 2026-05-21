import { describe, expect, it } from "vitest";
import { cloudflare } from "./cloudflare.js";

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
