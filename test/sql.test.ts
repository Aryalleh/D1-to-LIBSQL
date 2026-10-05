import { describe, expect, it } from "vitest";
import { bindSql, classifySql, describeParams } from "../src/sql";

describe("bindSql", () => {
	it("rewrites named parameters to numbered ones", () => {
		const r = bindSql("SELECT :a, @b, $c, :a", [], [
			{ name: ":a", value: { type: "integer", value: "1" } },
			{ name: "b", value: { type: "text", value: "x" } },
			{ name: "$c", value: { type: "null" } },
		]);
		expect(r.sql).toBe("SELECT ?1, ?2, ?3, ?1");
		expect(r.values).toEqual([1, "x", null]);
	});

	it("follows SQLite numbering for mixed placeholders", () => {
		const r = bindSql("SELECT ?, ?5, ?, :x", [{ type: "integer", value: "1" }]);
		expect(r.sql).toBe("SELECT ?1, ?5, ?6, ?7");
		expect(r.values).toHaveLength(7);
	});

	it("ignores placeholders in strings, identifiers and comments", () => {
		const sql = "SELECT '?', \":x\", [@y], `$z` -- ?\n/* :w */ FROM t WHERE a$b = ?";
		const r = bindSql(sql, [{ type: "text", value: "v" }]);
		expect(r.sql).toBe(sql.replace(/\?$/, "?1"));
		expect(r.values).toEqual(["v"]);
	});

	it("keeps integers beyond 2^53 exact by passing them as text", () => {
		expect(bindSql("SELECT ?", [{ type: "integer", value: "9007199254740993" }]).values).toEqual(["9007199254740993"]);
	});
});

describe("classifySql", () => {
	it.each([
		["BEGIN IMMEDIATE", "begin"],
		["  /* c */ commit", "commit"],
		["END TRANSACTION", "commit"],
		["ROLLBACK", "rollback"],
		["ROLLBACK TO sp1", "write"],
		["select 1", "read"],
		["PRAGMA table_info(t)", "read"],
		["PRAGMA foreign_keys = on", "write"],
		["WITH x AS (SELECT 1) SELECT * FROM x", "read"],
		["WITH x AS (SELECT 1) DELETE FROM t", "write"],
		["SELECT 'DELETE'", "read"],
		["INSERT INTO t VALUES (1)", "write"],
	])("%s -> %s", (sql, kind) => {
		expect(classifySql(sql)).toBe(kind);
	});
});

it("describeParams lists names by index", () => {
	expect(describeParams("SELECT ?, :a, ?3, :a")).toEqual([{ name: null }, { name: ":a" }, { name: null }]);
});
