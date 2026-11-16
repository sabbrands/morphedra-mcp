# Morphedra for Claude Desktop

A local extension (MCPB) that lets Claude create and follow narrated whiteboard videos with the Morphedra Whiteboard Video API.

Tools: create_video, get_video, list_videos, cancel_video, get_balance, get_usage.

Setup: install `morphedra.mcpb` in Claude Desktop (Settings, Extensions) and enter your API key (mk_live_... or mk_test_...). The key is stored in your computer's secret store.

Price: $1.80 per minute of finished video on live keys. Test keys are free, watermarked, up to 15 seconds, 3 videos. Docs: https://morphedra.com/api-docs

Build (PowerShell): `npm install` then `npm run pack`. Test against a fake API: `npm run build` then `node test/fake-test.mjs`.

License: MIT
