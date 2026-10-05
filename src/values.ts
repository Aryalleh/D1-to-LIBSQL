import { ProtocolError } from "./errors";
import type { Value } from "./protocol";

/** A value that can be bound to a D1 prepared statement. */
export type D1Bindable = null | number | string | ArrayBuffer;

export function base64Encode(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64Decode(text: string): Uint8Array {
	// Accept both standard and URL-safe alphabets, with or without padding.
	let normalized = text.replace(/-/g, "+").replace(/_/g, "/");
	while (normalized.length % 4 !== 0) normalized += "=";
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Convert a Hrana value from the client into something D1 can bind. */
export function valueToD1(value: Value): D1Bindable {
	if (value === null || typeof value !== "object") {
		throw new ProtocolError("Invalid value: expected an object");
	}
	switch (value.type) {
		case "null":
			return null;
		case "integer": {
			const n = Number(value.value);
			if (!Number.isInteger(n)) {
				throw new ProtocolError(`Invalid integer value: ${value.value}`);
			}
			// D1 cannot bind BigInts. Integers beyond 2^53 are passed as text so that
			// columns with INTEGER affinity still store the exact value.
			return Number.isSafeInteger(n) ? n : value.value;
		}
		case "float":
			return Number(value.value);
		case "text":
			return value.value;
		case "blob": {
			const bytes = base64Decode(value.base64 ?? "");
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		}
		default:
			throw new ProtocolError(`Unknown value type: ${(value as { type: unknown }).type}`);
	}
}

/** Convert a value returned by D1 into a Hrana value. */
export function valueFromD1(value: unknown): Value {
	if (value === null || value === undefined) {
		return { type: "null" };
	}
	if (typeof value === "number") {
		if (Number.isInteger(value)) {
			return { type: "integer", value: value.toString() };
		}
		return { type: "float", value };
	}
	if (typeof value === "bigint") {
		return { type: "integer", value: value.toString() };
	}
	if (typeof value === "string") {
		return { type: "text", value };
	}
	if (typeof value === "boolean") {
		return { type: "integer", value: value ? "1" : "0" };
	}
	if (value instanceof ArrayBuffer) {
		return { type: "blob", base64: base64Encode(new Uint8Array(value)) };
	}
	if (ArrayBuffer.isView(value)) {
		return {
			type: "blob",
			base64: base64Encode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
		};
	}
	if (Array.isArray(value)) {
		// D1 returns BLOB columns as arrays of byte values.
		return { type: "blob", base64: base64Encode(Uint8Array.from(value as number[])) };
	}
	return { type: "text", value: String(value) };
}
