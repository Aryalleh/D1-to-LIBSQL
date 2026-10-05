import { ProtocolError } from "./errors";
import { base64Decode, base64Encode } from "./values";

/**
 * Per-stream state. Workers are stateless, so instead of keeping streams in
 * memory the whole state travels inside the opaque baton that the client
 * echoes back with its next request. It only ever contains SQL texts the
 * client itself stored, so a tampered baton grants nothing.
 */
export interface StreamState {
	sqls: Map<number, string>;
}

const PREFIX = "d1s1.";

export function newStreamState(): StreamState {
	return { sqls: new Map() };
}

export function encodeBaton(state: StreamState): string {
	const json = JSON.stringify({ s: Array.from(state.sqls.entries()) });
	const b64 = base64Encode(new TextEncoder().encode(json));
	return PREFIX + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBaton(baton: string | null | undefined): StreamState {
	if (baton === null || baton === undefined) {
		return newStreamState();
	}
	if (typeof baton !== "string" || !baton.startsWith(PREFIX)) {
		throw new ProtocolError("Invalid baton");
	}
	try {
		const json = new TextDecoder().decode(base64Decode(baton.slice(PREFIX.length)));
		const parsed = JSON.parse(json) as { s: [number, string][] };
		const sqls = new Map<number, string>();
		for (const [id, sql] of parsed.s) {
			if (typeof id !== "number" || typeof sql !== "string") throw new Error("bad entry");
			sqls.set(id, sql);
		}
		return { sqls };
	} catch {
		throw new ProtocolError("Invalid baton");
	}
}
