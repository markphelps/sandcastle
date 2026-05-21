---
"@ai-hero/sandcastle": patch
---

Add `cloudflare()` sandbox provider that drives a user-deployed Cloudflare Workers bridge fronting `@cloudflare/sandbox`. `sandcastle init` now offers `cloudflare` as a sandbox provider choice and scaffolds `.sandcastle/cloudflare-worker/` with the bridge Worker source. Import via `@ai-hero/sandcastle/sandboxes/cloudflare`.
