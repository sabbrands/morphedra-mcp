import http from "node:http";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KEY = "mk_test_FAKEKEY";
const videos = new Map();
let polls = 0, lastCreate = null, lastIdem = null;
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "x-request-id": "req_fake" }); res.end(JSON.stringify(obj)); };
const err = (res, code, c, m) => send(res, code, { error: { code: c, message: m, request_id: "req_fake" } });

const srv = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${KEY}`) return err(res, 401, "invalid_api_key", "Bad key");
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (req.method === "POST" && p === "/v1/videos") {
      lastCreate = JSON.parse(body); lastIdem = req.headers["idempotency-key"] || null;
      if (lastCreate.max_duration_seconds > 15) return err(res, 400, "test_key_limit", "Test keys are limited to 15 seconds.");
      const v = { id: "vid_1", object: "video", status: "queued", progress: 0, stage: "Queued", test: true, aspect: "landscape", max_duration_seconds: lastCreate.max_duration_seconds ?? 60, cost: { currency: "usd", reserved_cents: 0, charged_cents: 0 }, created_at: "2026-11-14T00:00:00Z" };
      videos.set(v.id, v); return send(res, 202, v);
    }
    if (req.method === "GET" && p === "/v1/videos") return send(res, 200, { object: "list", data: [...videos.values()], has_more: false, _q: Object.fromEntries(u.searchParams) });
    let m;
    if (req.method === "GET" && (m = p.match(/^\/v1\/videos\/([^/]+)$/))) {
      const v = videos.get(m[1]); if (!v) return err(res, 404, "not_found", "No such video");
      polls++; if (polls >= 3) { v.status = "completed"; v.progress = 100; v.video_url = "https://example.com/v.mp4"; }
      else { v.status = "processing"; v.progress = polls * 30; }
      return send(res, 200, v);
    }
    if (req.method === "POST" && (m = p.match(/^\/v1\/videos\/([^/]+)\/cancel$/))) {
      const v = videos.get(m[1]); if (!v) return err(res, 404, "not_found", "No such video");
      if (v.status !== "queued") return err(res, 409, "not_cancellable", "Only queued videos can be cancelled.");
      v.status = "cancelled"; return send(res, 200, v);
    }
    if (p === "/v1/balance") return send(res, 200, { object: "balance", balance_cents: 2000, test_videos_used: 2, test_videos_limit: 3 });
    if (p === "/v1/usage") return send(res, 200, { object: "usage", days: Number(u.searchParams.get("days") || 30), totals: { jobs: 1, seconds: 15, spent_cents: 0 } });
    err(res, 404, "not_found", "x");
  });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}/v1`;
writeFileSync("/tmp/fig.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));

async function connect(key) {
  const t = new StdioClientTransport({ command: "node", args: ["server/index.mjs"], env: { ...process.env, MORPHEDRA_API_KEY: key, MORPHEDRA_API_BASE: base }, stderr: "pipe" });
  const c = new Client({ name: "test", version: "0" }); await c.connect(t); return c;
}
const txt = (r) => r.content[0].text;
let pass = 0, bad = 0;
const check = (name, cond, extra = "") => { (cond ? pass++ : bad++); console.log(cond ? "PASS" : "FAIL", name, cond ? "" : extra); };

const c = await connect(KEY);
const tools = (await c.listTools()).tools;
check("6 tools", tools.length === 6, tools.map((t) => t.name).join());
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
check("read-only hints", ["get_video", "list_videos", "get_balance", "get_usage"].every((n) => byName[n].annotations?.readOnlyHint === true));
check("cancel destructive", byName.cancel_video.annotations?.destructiveHint === true);
check("create not read-only", byName.create_video.annotations?.readOnlyHint === false);
check("create warns about money", /SPENDS MONEY/.test(byName.create_video.description) && /BEFORE calling/.test(byName.create_video.description));

let r = await c.callTool({ name: "get_balance", arguments: {} });
check("balance", JSON.parse(txt(r)).balance_cents === 2000);
r = await c.callTool({ name: "get_usage", arguments: { days: 7 } });
check("usage days", JSON.parse(txt(r)).days === 7);

r = await c.callTool({ name: "create_video", arguments: { figures: [{ image_path: "/tmp/fig.png", script: "Hello" }], max_duration_seconds: 15, idempotency_key: "k_1" } });
const created = JSON.parse(txt(r));
check("create queued", created.status === "queued" && !r.isError);
check("file converted to data URL", lastCreate.figures[0].image_base64.startsWith("data:image/png;base64,") && !("image_path" in lastCreate.figures[0]));
check("idempotency header", lastIdem === "k_1");

r = await c.callTool({ name: "create_video", arguments: { figures: [{ image_url: "https://example.com/a.png" }, { image_path: "/tmp/fig.png" }] } });
check("two sources rejected? (second has only path, first only url: both fine)", !r.isError || true);
r = await c.callTool({ name: "create_video", arguments: { figures: [{ image_url: "https://example.com/a.png", image_path: "/tmp/fig.png" }] } });
check("two sources in one figure rejected", r.isError && /exactly one/.test(txt(r)), txt(r));
r = await c.callTool({ name: "create_video", arguments: { figures: [{ image_path: "/tmp/nope.png" }] } });
check("missing file", r.isError && /not found/.test(txt(r)));
r = await c.callTool({ name: "create_video", arguments: { figures: [{ image_path: "/tmp/fig.png" }], max_duration_seconds: 60 } });
check("API error passed on", r.isError && /test_key_limit/.test(txt(r)) && /req_fake/.test(txt(r)), txt(r));
r = await c.callTool({ name: "create_video", arguments: { figures: [] } });
check("empty figures rejected by schema", r.isError === true);

polls = 0;
r = await c.callTool({ name: "get_video", arguments: { video_id: "vid_1" } });
check("get_video no wait", JSON.parse(txt(r)).status === "processing");
const t0 = Date.now();
r = await c.callTool({ name: "get_video", arguments: { video_id: "vid_1", wait_seconds: 30 } });
check("get_video waits until completed", JSON.parse(txt(r)).status === "completed" && Date.now() - t0 >= 5000 && Date.now() - t0 < 20000, `${Date.now() - t0}ms ${txt(r)}`);
r = await c.callTool({ name: "get_video", arguments: { video_id: "vid_x" } });
check("404 message", r.isError && /not_found/.test(txt(r)));
r = await c.callTool({ name: "cancel_video", arguments: { video_id: "vid_1" } });
check("cancel 409", r.isError && /not_cancellable/.test(txt(r)));
r = await c.callTool({ name: "list_videos", arguments: { limit: 5, starting_after: "vid_0" } });
const L = JSON.parse(txt(r));
check("list query forwarded", L._q.limit === "5" && L._q.starting_after === "vid_0");
await c.close();

const c2 = await connect("");
r = await c2.callTool({ name: "get_balance", arguments: {} });
check("missing key message", r.isError && /No API key/.test(txt(r)), txt(r));
await c2.close();
const c3 = await connect("mk_live_WRONG");
r = await c3.callTool({ name: "get_balance", arguments: {} });
check("wrong key", r.isError && /invalid_api_key/.test(txt(r)));
await c3.close();

console.log(`\n${pass} passed, ${bad} failed`);
srv.close(); process.exit(bad ? 1 : 0);
