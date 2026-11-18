import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { ApiError, apiCall, readConfig } from "./api.js";

const cfg = readConfig();
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const server = new McpServer({ name: "morphedra", version: "0.2.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown): ToolResult => {
  let text: string;
  if (err instanceof ApiError) {
    text = `Error (${err.code}${err.status ? `, HTTP ${err.status}` : ""}): ${err.message}${err.requestId ? ` [request id ${err.requestId}]` : ""}`;
  } else {
    text = `Error: ${(err as any)?.message || String(err)}`;
  }
  return { content: [{ type: "text", text }], isError: true };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isDone = (s: string) => s === "completed" || s === "failed" || s === "cancelled";

// ------------------------------------------------------------------ tools
server.registerTool(
  "create_video",
  {
    title: "Create whiteboard video",
    description:
      "Creates a narrated whiteboard video from 1 to 6 figures. THIS SPENDS MONEY on live keys: the account is charged $0.03 per second of finished video (shortest charge 10 seconds), and the maximum, max_duration_seconds x 3 cents, is held at once and the unused part returned. Test keys (mk_test_) are free, add a watermark and are limited to 15 seconds and 3 videos. " +
      "BEFORE calling this tool, tell the person the figures, the maximum duration and the maximum cost in dollars (max_duration_seconds x 0.03), and call it only after they agree. Do not call it again for the same request: if unsure whether it worked, use list_videos. " +
      "Each figure needs exactly one of image_url (public https link), image_path (a file on this computer: PNG, JPG or WEBP, up to 5 MB) or image_base64. Give a script for every figure or for none; without scripts the narration is composed from the figures and notes. The call returns at once with status 'queued'. The video is made in the background and a normal short video takes about one to several minutes: then use get_video with wait_seconds to follow it.",
    inputSchema: {
      figures: z
        .array(
          z.object({
            image_url: z.string().url().optional().describe("Public https link to a PNG, JPG or WEBP image of at most 5 MB."),
            image_path: z.string().optional().describe("Full path of an image file on this computer (PNG, JPG or WEBP, at most 5 MB)."),
            image_base64: z.string().optional().describe("The image as base64 (a data: prefix is accepted). At most 5 MB."),
            script: z.string().max(10000).optional().describe("The exact words the voice reads for this figure. Give a script for all figures or for none."),
          }),
        )
        .min(1)
        .max(6)
        .describe("1 to 6 figures, all landscape or all portrait, at least 200 px per side."),
      notes: z.string().max(5000).optional().describe("Background for the narration. Used only when no scripts are given."),
      voice: z.enum(["Charon", "Orus", "Kore", "Aoede", "Iapetus", "Rasalgethi", "Sulafat", "Erinome"]).optional().describe("Narrator voice. Default Charon."),
      language: z
        .enum(["en", "ur", "hi", "ar", "zh", "bn", "es", "fr", "de", "pt", "tr", "id", "ru"])
        .optional()
        .describe("Narration language, used only when no scripts are given (the narration is then written in this language). en, ur (Urdu), hi (Hindi), ar (Arabic), zh (Chinese), bn (Bangla), es, fr, de, pt, tr, id, ru. Default en. With scripts, the voice reads them as written, in any language."),
      title: z.string().max(100).optional(),
      max_duration_seconds: z
        .number()
        .int()
        .min(10)
        .max(600)
        .optional()
        .describe("The most the person can be charged for, in seconds (10 to 600, default 60; test keys: 15). Maximum cost = this x $0.03."),
      webhook_url: z.string().url().optional().describe("Public https address that gets video.completed and video.failed. Usually not needed here."),
      idempotency_key: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/)
        .optional()
        .describe("Optional. The same key with the same request returns the first video instead of creating another."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args): Promise<ToolResult> => {
    try {
      const figures: any[] = [];
      for (const [i, f] of args.figures.entries()) {
        const given = [f.image_url, f.image_path, f.image_base64].filter(Boolean).length;
        if (given !== 1) {
          return fail(new Error(`Figure ${i + 1}: give exactly one of image_url, image_path or image_base64.`));
        }
        const out: any = {};
        if (f.image_url) out.image_url = f.image_url;
        if (f.image_base64) out.image_base64 = f.image_base64;
        if (f.image_path) {
          const mime = MIME[extname(f.image_path).toLowerCase()];
          if (!mime) return fail(new Error(`Figure ${i + 1}: the file must be .png, .jpg, .jpeg or .webp.`));
          let size: number;
          try {
            size = (await stat(f.image_path)).size;
          } catch {
            return fail(new Error(`Figure ${i + 1}: the file "${f.image_path}" was not found on this computer.`));
          }
          if (size > MAX_IMAGE_BYTES) return fail(new Error(`Figure ${i + 1}: the file is larger than 5 MB.`));
          const buf = await readFile(f.image_path);
          out.image_base64 = `data:${mime};base64,${buf.toString("base64")}`;
        }
        if (f.script !== undefined) out.script = f.script;
        figures.push(out);
      }
      const body: any = { figures };
      for (const k of ["notes", "voice", "language", "title", "max_duration_seconds", "webhook_url"] as const) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      const headers = args.idempotency_key ? { "Idempotency-Key": args.idempotency_key } : undefined;
      return ok(await apiCall(cfg, "POST", "/videos", { body, headers }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_video",
  {
    title: "Get video status",
    description:
      "Returns one video: status (queued, processing, completed, failed, cancelled), progress, and when completed the video_url, thumbnail_url, transcript and the real cost. Set wait_seconds (up to 45) to wait for the video to finish before answering, so the person does not have to ask again; if it is still running after that, call it again. Free to call.",
    inputSchema: {
      video_id: z.string().min(1).describe("The video id, for example vid_pTcL5JlR5yGALqil."),
      wait_seconds: z.number().int().min(0).max(45).optional().describe("Wait up to this many seconds for a final status. Default 0 (answer at once)."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ video_id, wait_seconds }): Promise<ToolResult> => {
    try {
      const deadline = Date.now() + (wait_seconds ?? 0) * 1000;
      const path = `/videos/${encodeURIComponent(video_id)}`;
      let v = await apiCall(cfg, "GET", path);
      while (!isDone(v.status) && Date.now() + 6000 <= deadline) {
        await sleep(6000);
        v = await apiCall(cfg, "GET", path);
      }
      return ok(v);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_videos",
  {
    title: "List videos",
    description: "Lists the account's recent videos, newest first (records stay 30 days). Use it to find a video id or to check whether a create call worked. Free to call.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("How many videos, 1 to 50. Default 20."),
      starting_after: z.string().optional().describe("A video id: returns the videos created before it (next page)."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ limit, starting_after }): Promise<ToolResult> => {
    try {
      return ok(await apiCall(cfg, "GET", "/videos", { query: { limit, starting_after } }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "cancel_video",
  {
    title: "Cancel a queued video",
    description: "Cancels a video that is still 'queued' and returns the full reserved amount. It cannot be undone, and it does not work once the video is processing. Ask the person to confirm first.",
    inputSchema: { video_id: z.string().min(1).describe("The id of the queued video.") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ video_id }): Promise<ToolResult> => {
    try {
      return ok(await apiCall(cfg, "POST", `/videos/${encodeURIComponent(video_id)}/cancel`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_balance",
  {
    title: "Get account balance",
    description:
      "Returns the prepaid balance in cents (balance_cents; 100 = $1.00), the free test videos used and allowed, the price per second in cents and the shortest billed length. Check it before creating a video on a live key. Free to call.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (): Promise<ToolResult> => {
    try {
      return ok(await apiCall(cfg, "GET", "/balance"));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_usage",
  {
    title: "Get usage totals",
    description: "Returns totals for the last N days: number of videos, seconds made, money spent in cents, and videos by status. Free to call.",
    inputSchema: { days: z.number().int().min(1).max(90).optional().describe("1 to 90. Default 30.") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ days }): Promise<ToolResult> => {
    try {
      return ok(await apiCall(cfg, "GET", "/usage", { query: { days } }));
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
