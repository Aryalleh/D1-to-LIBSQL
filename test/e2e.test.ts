// End-to-end test: runs the Worker with a local D1 database via wrangler's
// unstable_startWorker and talks to it with the official @libsql/client.
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

const TOKEN = "test-token";
let worker: Unstable_DevWorker;
let client: Client;

beforeAll(async () => {
	worker = await unstable_dev("src/index.ts", {
		config: "wrangler.jsonc",
		vars: { AUTH_TOKEN: TOKEN },
		experimental: { disableExperimentalWarning: true },
		persist: false,
		logLevel: "error",
	} as never);
	client = createClient({ url: `http://${worker.address}:${worker.port}`, authToken: TOKEN });
}, 60_000);

afterAll(async () => {
	client?.close();
	await worker?.stop();
});

describe("libSQL client against D1", () => {
	it("rejects requests without the token", async () => {
		const res = await worker.fetch("/v2/pipeline", { method: "POST", body: "{}" });
		expect(res.status).toBe(401);
	});

	it("creates tables and inserts rows", async () => {
		await client.execute("DROP TABLE IF EXISTS users");
		await client.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, score REAL, avatar BLOB)");
		const rs = await client.execute({
			sql: "INSERT INTO users (name, score, avatar) VALUES (?, ?, ?)",
			args: ["alice", 1.5, new Uint8Array([1, 2, 3])],
		});
		expect(rs.rowsAffected).toBe(1);
		expect(Number(rs.lastInsertRowid)).toBe(1);
	});

	it("supports named arguments", async () => {
		await client.execute({
			sql: "INSERT INTO users (name, score) VALUES (:name, $score)",
			args: { name: "bob", score: 2 },
		});
		const rs = await client.execute({ sql: "SELECT name FROM users WHERE name = @n", args: { n: "bob" } });
		expect(rs.rows[0].name).toBe("bob");
	});

	it("returns typed values and preserves column order", async () => {
		const rs = await client.execute("SELECT score, name, id, avatar, 'x' AS name FROM users WHERE id = 1");
		expect(rs.columns).toEqual(["score", "name", "id", "avatar", "name"]);
		const row = rs.rows[0];
		expect(row[0]).toBe(1.5);
		expect(row[1]).toBe("alice");
		expect(row[2]).toBe(1);
		expect(new Uint8Array(row[3] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
		expect(row[4]).toBe("x");
	});

	it("returns columns for empty results", async () => {
		const rs = await client.execute("SELECT id, name FROM users WHERE 0");
		expect(rs.columns).toEqual(["id", "name"]);
		expect(rs.rows).toHaveLength(0);
	});

	it("supports RETURNING", async () => {
		const rs = await client.execute({ sql: "INSERT INTO users (name) VALUES (?) RETURNING id, name", args: ["carol"] });
		expect(rs.rows[0].name).toBe("carol");
		expect(rs.rowsAffected).toBe(1);
	});

	it("executes batches atomically", async () => {
		const results = await client.batch(
			[
				{ sql: "INSERT INTO users (name) VALUES (?)", args: ["dave"] },
				{ sql: "UPDATE users SET score = 10 WHERE name = ?", args: ["dave"] },
				"SELECT count(*) AS n FROM users",
			],
			"write",
		);
		expect(results).toHaveLength(3);
		expect(results[1].rowsAffected).toBe(1);
		expect(results[2].rows[0].n).toBe(4);
	});

	it("rolls back failed batches", async () => {
		await expect(
			client.batch(["INSERT INTO users (name) VALUES ('eve')", "INSERT INTO users (name) VALUES ('alice')"], "write"),
		).rejects.toThrow(/UNIQUE constraint failed/);
		const rs = await client.execute("SELECT count(*) AS n FROM users WHERE name = 'eve'");
		expect(rs.rows[0].n).toBe(0);
	});

	it("reports SQL errors with codes", async () => {
		await expect(client.execute("SELECT * FROM missing_table")).rejects.toMatchObject({ code: "SQLITE_ERROR" });
	});

	it("runs multi-statement scripts", async () => {
		await client.executeMultiple("CREATE TABLE IF NOT EXISTS t2 (x); INSERT INTO t2 VALUES (1); INSERT INTO t2 VALUES (2);");
		const rs = await client.execute("SELECT sum(x) AS s FROM t2");
		expect(rs.rows[0].s).toBe(3);
	});

	it("rejects interactive transactions clearly", async () => {
		await expect(async () => {
			const tx = await client.transaction("write");
			await tx.execute("SELECT 1");
		}).rejects.toThrow(/Interactive transactions are not supported/);
	});

	it("serves the v3 cursor endpoint", async () => {
		const res = await worker.fetch("/v3/cursor", {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ baton: null, batch: { steps: [{ stmt: { sql: "SELECT 1 AS a" } }, { stmt: { sql: "SELECT nope" } }] } }),
		});
		const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
		expect(lines[0].baton).toMatch(/^d1s1\./);
		expect(lines.slice(1).map((l: { type: string }) => l.type)).toEqual(["step_begin", "row", "step_end", "step_error"]);
	});

	it("serves the legacy v1 API", async () => {
		const res = await worker.fetch("/", {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ statements: ["SELECT 1 AS one", { q: "SELECT ? AS v", params: [42] }] }),
		});
		expect(await res.json()).toMatchObject([
			{ results: { columns: ["one"], rows: [[1]] } },
			{ results: { columns: ["v"], rows: [[42]] } },
		]);
	});
});
