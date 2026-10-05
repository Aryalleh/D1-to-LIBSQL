import type { ProtoError } from "./protocol";

/** An error that is reported to the client as a Hrana `Error` object. */
export class SqlError extends Error {
	constructor(
		message: string,
		readonly code: string = "SQLITE_ERROR",
	) {
		super(message);
	}
}

/** A malformed request; reported with HTTP 400 instead of a per-request error. */
export class ProtocolError extends Error {}

/** Convert anything thrown by D1 (or by us) into a Hrana error object. */
export function toProtoError(e: unknown): ProtoError {
	if (e instanceof SqlError) {
		return { message: e.message, code: e.code };
	}
	let message = e instanceof Error ? e.message : String(e);
	// D1 errors look like "D1_ERROR: no such table: foo: SQLITE_ERROR".
	const codeMatch = /\b(SQLITE_[A-Z_]+)\b/.exec(message);
	let code = codeMatch?.[1] ?? null;
	message = message
		.replace(/^D1_[A-Z_]+:\s*/, "")
		.replace(/:\s*SQLITE_[A-Z_]+\s*$/, "")
		.trim();
	if (code === null) {
		code = /constraint failed/i.test(message) ? "SQLITE_CONSTRAINT" : "SQLITE_ERROR";
	}
	return { message, code };
}
