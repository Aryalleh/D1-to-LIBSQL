import { SqlError } from "./errors";
import type { NamedArg, Value } from "./protocol";
import { type D1Bindable, valueToD1 } from "./values";

interface ParamToken {
	start: number;
	end: number;
	/** `?`, `?NNN`, or a named parameter including its prefix (`:x`, `@x`, `$x`). */
	text: string;
}

interface ScannedSql {
	params: ParamToken[];
	/** The SQL with literals, quoted identifiers and comments replaced by spaces. */
	code: string;
}

function isIdentChar(ch: string | undefined): boolean {
	return ch !== undefined && (/[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 0x7f);
}

/** Lexically scan SQL, finding parameters outside of strings, identifiers and comments. */
export function scanSql(sql: string): ScannedSql {
	const params: ParamToken[] = [];
	const code = sql.split("");
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (code[k] !== "\n") code[k] = " ";
	};
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === "`") {
			// Quoted string/identifier; a doubled quote is an escaped quote.
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === ch) {
					if (sql[j + 1] === ch) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			blank(i, Math.min(j + 1, sql.length));
			i = j + 1;
		} else if (ch === "[") {
			const j = sql.indexOf("]", i + 1);
			const end = j === -1 ? sql.length : j + 1;
			blank(i, end);
			i = end;
		} else if (ch === "-" && sql[i + 1] === "-") {
			const j = sql.indexOf("\n", i + 2);
			const end = j === -1 ? sql.length : j;
			blank(i, end);
			i = end;
		} else if (ch === "/" && sql[i + 1] === "*") {
			const j = sql.indexOf("*/", i + 2);
			const end = j === -1 ? sql.length : j + 2;
			blank(i, end);
			i = end;
		} else if (ch === "?") {
			let j = i + 1;
			while (j < sql.length && /[0-9]/.test(sql[j])) j++;
			params.push({ start: i, end: j, text: sql.slice(i, j) });
			i = j;
		} else if ((ch === ":" || ch === "@" || ch === "$") && isIdentChar(sql[i + 1]) && !isIdentChar(sql[i - 1])) {
			let j = i + 1;
			while (j < sql.length && isIdentChar(sql[j])) j++;
			params.push({ start: i, end: j, text: sql.slice(i, j) });
			i = j;
		} else if (isIdentChar(ch)) {
			// Skip whole words so that `$` inside identifiers is not treated as a parameter.
			let j = i + 1;
			while (j < sql.length && isIdentChar(sql[j])) j++;
			i = j;
		} else {
			i++;
		}
	}
	return { params, code: code.join("") };
}

interface ParamSlot {
	index: number;
	name: string | null;
}

/** Assign SQLite parameter indices the same way `sqlite3_prepare` does. */
function assignIndices(params: ParamToken[]): ParamSlot[] {
	const named = new Map<string, number>();
	let maxIndex = 0;
	return params.map((p) => {
		if (p.text === "?") {
			maxIndex += 1;
			return { index: maxIndex, name: null };
		}
		if (p.text.startsWith("?")) {
			const index = Number(p.text.slice(1));
			if (!Number.isSafeInteger(index) || index < 1 || index > 32766) {
				throw new SqlError(`variable number must be between ?1 and ?32766`);
			}
			maxIndex = Math.max(maxIndex, index);
			return { index, name: null };
		}
		let index = named.get(p.text);
		if (index === undefined) {
			maxIndex += 1;
			index = maxIndex;
			named.set(p.text, index);
		}
		return { index, name: p.text };
	});
}

function lookupNamedArg(namedArgs: Map<string, Value>, name: string): Value | undefined {
	// libSQL accepts names both with and without the prefix character.
	return namedArgs.get(name) ?? namedArgs.get(name.slice(1));
}

export interface BoundSql {
	sql: string;
	values: D1Bindable[];
}

/**
 * Rewrite every parameter to the `?NNN` form (D1 does not support named
 * parameters) and build the matching list of positional values.
 */
export function bindSql(sql: string, args: Value[] = [], namedArgsList: NamedArg[] = []): BoundSql {
	const { params } = scanSql(sql);
	if (params.length === 0) {
		return { sql, values: [] };
	}
	const slots = assignIndices(params);
	const namedArgs = new Map(namedArgsList.map((a) => [a.name, a.value] as const));
	const maxIndex = Math.max(...slots.map((s) => s.index));
	const values: D1Bindable[] = new Array(maxIndex).fill(null);
	for (let k = 0; k < Math.min(args.length, maxIndex); k++) {
		values[k] = valueToD1(args[k]);
	}
	for (const slot of slots) {
		if (slot.name === null) continue;
		const v = lookupNamedArg(namedArgs, slot.name);
		if (v !== undefined) values[slot.index - 1] = valueToD1(v);
	}
	let out = "";
	let last = 0;
	params.forEach((p, k) => {
		out += sql.slice(last, p.start) + "?" + slots[k].index;
		last = p.end;
	});
	out += sql.slice(last);
	return { sql: out, values };
}

/** Parameter names in the order of their indices, as reported by `describe`. */
export function describeParams(sql: string): { name: string | null }[] {
	const { params } = scanSql(sql);
	const slots = assignIndices(params);
	const maxIndex = slots.reduce((m, s) => Math.max(m, s.index), 0);
	const names: { name: string | null }[] = Array.from({ length: maxIndex }, () => ({ name: null }));
	for (const slot of slots) {
		if (slot.name !== null) names[slot.index - 1] = { name: slot.name };
	}
	return names;
}

export type StmtKind = "begin" | "commit" | "rollback" | "read" | "write";

/** Roughly classify a statement by its leading keywords. */
export function classifySql(sql: string): StmtKind {
	const code = scanSql(sql).code.trim().toUpperCase();
	const words = code.split(/[^A-Z0-9_]+/).filter((w) => w.length > 0);
	const first = words[0] ?? "";
	switch (first) {
		case "BEGIN":
			return "begin";
		case "COMMIT":
		case "END":
			return "commit";
		case "ROLLBACK":
			// ROLLBACK TO <savepoint> does not end the transaction.
			return words.slice(1, 3).includes("TO") ? "write" : "rollback";
		case "SELECT":
		case "VALUES":
		case "EXPLAIN":
			return "read";
		case "PRAGMA":
			return code.includes("=") ? "write" : "read";
		case "WITH":
			return words.some((w) => ["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(w)) ? "write" : "read";
		default:
			return "write";
	}
}

export function isExplain(sql: string): boolean {
	return /^\s*EXPLAIN\b/i.test(scanSql(sql).code);
}
