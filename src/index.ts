import { decodeBaton, encodeBaton } from "./baton";
import { ProtocolError, toProtoError } from "./errors";
import { Executor } from "./executor";
import type {
	Batch,
	BatchStep,
	CursorEntry,
	CursorReqBody,
	PipelineReqBody,
	PipelineRespBody,
	StreamRequest,
	StreamResponse,
	StreamResult,
	Value,
} from "./protocol";
import { valueFromD1 } from "./values";

export interface Env {
	/** The D1 database to expose. */
	DB: D1Database;
	/** Bearer token clients must send (`authToken` in @libsql/client). Set with `wrangler secret put AUTH_TOKEN`. */
	AUTH_TOKEN?: string;
	/** Set to "true" to allow requests without a token (local development only). */
	ALLOW_ANONYMOUS?: string;
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

function text(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/plain", ...CORS_HEADERS } });
}

function timingSafeEqual(a: string, b: string): boolean {
	const ea = new TextEncoder().encode(a);
	const eb = new TextEncoder().encode(b);
	let diff = ea.length ^ eb.length;
	for (let i = 0; i < Math.max(ea.length, eb.length); i++) {
		diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
	}
	return diff === 0;
}

function authorize(request: Request, env: Env): Response | null {
	if (!env.AUTH_TOKEN) {
		if (env.ALLOW_ANONYMOUS === "true") return null;
		return text("Server misconfigured: set the AUTH_TOKEN secret (or ALLOW_ANONYMOUS=true for local dev)", 500);
	}
	const header = request.headers.get("Authorization") ?? "";
	const match = /^(?:Bearer|Basic)\s+(.+)$/i.exec(header.trim());
	if (match === null || !timingSafeEqual(match[1], env.AUTH_TOKEN)) {
		return text("Unauthorized", 401);
	}
	return null;
}

async function readJson<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw new ProtocolError("Request body is not valid JSON");
	}
}

async function handleStreamRequest(executor: Executor, req: StreamRequest): Promise<StreamResponse> {
	switch (req.type) {
		case "execute":
			return { type: "execute", result: await executor.execute(req.stmt) };
		case "batch":
			return { type: "batch", result: await executor.batch(req.batch) };
		case "sequence":
			await executor.sequence(executor.resolveSql(req.sql, req.sql_id));
			return { type: "sequence" };
		case "describe":
			return { type: "describe", result: executor.describe(executor.resolveSql(req.sql, req.sql_id)) };
		case "store_sql":
			executor.storeSql(req.sql_id, req.sql);
			return { type: "store_sql" };
		case "close_sql":
			executor.closeSql(req.sql_id);
			return { type: "close_sql" };
		case "get_autocommit":
			return { type: "get_autocommit", is_autocommit: true };
		case "close":
			return { type: "close" };
		default:
			throw new ProtocolError(`Unknown request type: ${(req as { type: unknown }).type}`);
	}
}

async function handlePipeline(request: Request, env: Env): Promise<Response> {
	const body = await readJson<PipelineReqBody>(request);
	if (body === null || typeof body !== "object" || !Array.isArray(body.requests)) {
		throw new ProtocolError("Pipeline request must have a `requests` array");
	}
	const state = decodeBaton(body.baton);
	const executor = new Executor(env.DB, state);
	const results: StreamResult[] = [];
	let closed = false;
	for (const req of body.requests) {
		if (closed) {
			results.push({ type: "error", error: { message: "Stream is closed", code: "STREAM_CLOSED" } });
			continue;
		}
		try {
			results.push({ type: "ok", response: await handleStreamRequest(executor, req) });
		} catch (e) {
			if (e instanceof ProtocolError) throw e;
			results.push({ type: "error", error: toProtoError(e) });
		}
		if (req.type === "close") closed = true;
	}
	const resp: PipelineRespBody = {
		baton: closed ? null : encodeBaton(state),
		base_url: null,
		results,
	};
	return json(resp);
}

async function handleCursor(request: Request, env: Env): Promise<Response> {
	const body = await readJson<CursorReqBody>(request);
	if (body === null || typeof body !== "object" || typeof body.batch !== "object") {
		throw new ProtocolError("Cursor request must have a `batch` object");
	}
	const state = decodeBaton(body.baton);
	const executor = new Executor(env.DB, state);
	const lines: unknown[] = [{ baton: encodeBaton(state), base_url: null }];
	try {
		const result = await executor.batch(body.batch);
		result.step_results.forEach((r, step) => {
			const error = result.step_errors[step];
			if (error) {
				lines.push({ type: "step_error", step, error } satisfies CursorEntry);
			} else if (r) {
				lines.push({ type: "step_begin", step, cols: r.cols } satisfies CursorEntry);
				for (const row of r.rows) lines.push({ type: "row", row } satisfies CursorEntry);
				lines.push({
					type: "step_end",
					affected_row_count: r.affected_row_count,
					last_insert_rowid: r.last_insert_rowid,
				} satisfies CursorEntry);
			}
		});
	} catch (e) {
		lines.push({ type: "error", error: toProtoError(e) } satisfies CursorEntry);
	}
	return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
		headers: { "Content-Type": "text/plain", ...CORS_HEADERS },
	});
}

/** Convert a plain JSON value from the legacy v1 API into a Hrana value. */
function legacyValue(v: unknown): Value {
	if (typeof v === "number" && Number.isInteger(v)) return { type: "integer", value: String(v) };
	if (typeof v === "number") return { type: "float", value: v };
	if (v !== null && typeof v === "object" && "base64" in v) {
		return { type: "blob", base64: String((v as { base64: unknown }).base64) };
	}
	return valueFromD1(v);
}

/** Legacy libSQL HTTP API v1: `POST /` with `{statements: [...]}`, executed in one transaction. */
async function handleLegacy(request: Request, env: Env): Promise<Response> {
	const body = await readJson<{ statements?: unknown[] }>(request);
	if (body === null || typeof body !== "object" || !Array.isArray(body.statements)) {
		throw new ProtocolError("Request must have a `statements` array");
	}
	const steps: BatchStep[] = [{ stmt: { sql: "BEGIN" } }];
	for (const s of body.statements) {
		const step = steps.length;
		const cond = { type: "ok" as const, step: step - 1 };
		if (typeof s === "string") {
			steps.push({ condition: cond, stmt: { sql: s } });
		} else if (s !== null && typeof s === "object" && typeof (s as { q?: unknown }).q === "string") {
			const { q, params } = s as { q: string; params?: unknown };
			const stmt: BatchStep["stmt"] = { sql: q };
			if (Array.isArray(params)) {
				stmt.args = params.map(legacyValue);
			} else if (params !== null && typeof params === "object") {
				stmt.named_args = Object.entries(params).map(([name, value]) => ({ name, value: legacyValue(value) }));
			}
			steps.push({ condition: cond, stmt });
		} else {
			throw new ProtocolError("Each statement must be a string or {q, params}");
		}
	}
	steps.push({ condition: { type: "ok", step: steps.length - 1 }, stmt: { sql: "COMMIT" } });
	steps.push({ condition: { type: "not", cond: { type: "ok", step: steps.length - 1 } }, stmt: { sql: "ROLLBACK" } });

	const executor = new Executor(env.DB, decodeBaton(null));
	const result = await executor.batch({ steps } satisfies Batch);
	const out = body.statements.map((_, k) => {
		const i = k + 1;
		const error = result.step_errors[i] ?? result.step_errors[0];
		const r = result.step_results[i];
		if (r) {
			return {
				results: {
					columns: r.cols.map((c) => c.name),
					rows: r.rows.map((row) => row.map(legacyCell)),
					rows_read: r.rows_read,
					rows_written: r.rows_written,
					query_duration_ms: r.query_duration_ms,
				},
			};
		}
		return { error: { message: error?.message ?? "Statement was not executed because the transaction was rolled back" } };
	});
	const failed = out.some((o) => "error" in o);
	return json(out, failed ? 400 : 200);
}

function legacyCell(v: Value): unknown {
	switch (v.type) {
		case "null":
			return null;
		case "integer":
			return Number(v.value);
		case "float":
		case "text":
			return v.value;
		case "blob":
			return { base64: v.base64 };
	}
}

async function route(request: Request, env: Env): Promise<Response> {
	const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
	const method = request.method;

	if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
	if (method === "GET" && path === "/health") return text("OK");
	if (method === "GET" && path === "/version") return text("d1-to-libsql 0.1.0");

	const denied = authorize(request, env);
	if (denied) return denied;

	if (method === "GET" && (path === "/v2" || path === "/v3")) return text("");
	if (method === "POST" && (path === "/v2/pipeline" || path === "/v3/pipeline")) return handlePipeline(request, env);
	if (method === "POST" && path === "/v3/cursor") return handleCursor(request, env);
	if (method === "POST" && path === "/") return handleLegacy(request, env);
	// Notably /v3-protobuf is not implemented, so clients fall back to JSON.
	return text("Not found", 404);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (e) {
			if (e instanceof ProtocolError) return text(e.message, 400);
			console.error(e);
			return text(`Internal error: ${e instanceof Error ? e.message : String(e)}`, 500);
		}
	},
} satisfies ExportedHandler<Env>;
