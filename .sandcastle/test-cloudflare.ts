import * as sandcastle from "@ai-hero/sandcastle";
import { cloudflare } from "@ai-hero/sandcastle/sandboxes/cloudflare";

const workerUrl = process.env["SANDCASTLE_WORKER_URL"];
if (!workerUrl) {
  console.error("Set SANDCASTLE_WORKER_URL in .sandcastle/.env first.");
  process.exit(1);
}

const result = await sandcastle.run({
  sandbox: cloudflare({ workerUrl }),
  name: "Test",
  agent: sandcastle.claudeCode("claude-opus-4-7"),
  prompt: "Print the string CLOUDFLARE_OK and nothing else.",
});

console.log(
  JSON.stringify(
    {
      exitCode: 0,
      stdoutSnippet: result.stdout.slice(0, 200),
      commits: result.commits,
      branch: result.branch,
    },
    null,
    2,
  ),
);
