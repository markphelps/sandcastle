---
"@ai-hero/sandcastle": patch
---

Add `sandcastle cloudflare deploy` and `sandcastle cloudflare set-token` CLI commands that shell out to `wrangler` inside `.sandcastle/cloudflare-worker/` for deploying the bridge Worker and setting the `SANDCASTLE_AUTH_TOKEN` Worker secret.
