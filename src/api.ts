// Small client for the Morphedra Whiteboard Video API v1.
const DEFAULT_BASE = "https://api.morphedra.com/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

export interface ApiConfig {
  apiKey: string;
  baseUrl: string;
}

export function readConfig(): ApiConfig {
  const apiKey = (process.env.MORPHEDRA_API_KEY || "").trim();
  // MORPHEDRA_API_BASE exists only so the extension can be tested against a fake server.
  const baseUrl = (process.env.MORPHEDRA_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  return { apiKey, baseUrl };
}

export async function apiCall(
  cfg: ApiConfig,
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<any> {
  if (!cfg.apiKey) {
    throw new ApiError(
      401,
      "missing_api_key",
      "No API key is set. Open Claude Desktop, Settings, Extensions, Morphedra, and enter your API key (it starts with mk_live_ or mk_test_).",
    );
  }
  const url = new URL(cfg.baseUrl + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err: any) {
    throw new ApiError(0, "network_error", `Could not reach the Morphedra API: ${err?.message || err}`);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(
      res.status,
      e?.code || `http_${res.status}`,
      e?.message || `The API answered with HTTP ${res.status}.`,
      e?.request_id || res.headers.get("x-request-id") || undefined,
    );
  }
  return json;
}
