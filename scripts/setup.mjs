#!/usr/bin/env node
// One-command setup: creates (or reuses) the D1 database, writes its id into
// wrangler.jsonc, optionally applies a schema, deploys the Worker, sets the
// AUTH_TOKEN secret and saves the connection details to .libsql.env.
//
//   npm run setup -- [--db <name>] [--location weur|eeur|apac|oc|wnam|enam]
//                    [--schema <file.sql>] [--token <token>] [--new-token]

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "wrangler.jsonc");
const credentialsPath = join(root, ".libsql.env");
const isWindows = process.platform === "win32";
const wranglerBin = process.env.WRANGLER_BIN ?? join(root, "node_modules", ".bin", isWindows ? "wrangler.cmd" : "wrangler");

function parseArgs(argv) {
	const opts = { db: "d1-to-libsql-db", location: undefined, schema: undefined, token: undefined, newToken: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) fail(`Missing value for ${arg}`);
			return v;
		};
		if (arg === "--db") opts.db = next();
		else if (arg === "--location") opts.location = next();
		else if (arg === "--schema") opts.schema = next();
		else if (arg === "--token") opts.token = next();
		else if (arg === "--new-token") opts.newToken = true;
		else if (arg === "-h" || arg === "--help") {
			console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 7).join("\n").replace(/^\/\/ ?/gm, ""));
			process.exit(0);
		} else fail(`Unknown option: ${arg}`);
	}
	return opts;
}

function fail(message) {
	console.error(`\n✖ ${message}`);
	process.exit(1);
}

function step(message) {
	console.log(`\n▶ ${message}`);
}

/** Run wrangler. `capture` returns stdout instead of streaming it to the terminal. */
function wrangler(args, { capture = false, input } = {}) {
	if (!existsSync(wranglerBin)) fail("wrangler is not installed. Run `npm install` first.");
	const result = spawnSync(wranglerBin, args, {
		cwd: root,
		input,
		encoding: "utf8",
		shell: isWindows,
		stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	});
	if (result.error) fail(`Could not run wrangler: ${result.error.message}`);
	if (result.status !== 0) {
		if (capture) process.stderr.write(result.stderr ?? "");
		fail(`wrangler ${args.join(" ")} failed (exit code ${result.status})`);
	}
	return result.stdout ?? "";
}

function parseJsonOutput(text) {
	// Wrangler may print warnings before the JSON.
	const start = text.search(/[[{]/);
	if (start === -1) throw new Error("no JSON in output");
	return JSON.parse(text.slice(start));
}

function findDatabase(name) {
	const list = parseJsonOutput(wrangler(["d1", "list", "--json"], { capture: true }));
	return list.find((db) => db.name === name);
}

function updateConfig(name, id) {
	let config = readFileSync(configPath, "utf8");
	const nameRe = /("database_name"\s*:\s*)"[^"]*"/;
	const idRe = /("database_id"\s*:\s*)"[^"]*"/;
	if (!nameRe.test(config) || !idRe.test(config)) fail("Could not find database_name/database_id in wrangler.jsonc");
	config = config.replace(nameRe, `$1${JSON.stringify(name)}`).replace(idRe, `$1${JSON.stringify(id)}`);
	writeFileSync(configPath, config);
}

function readSavedToken() {
	if (!existsSync(credentialsPath)) return undefined;
	const match = /^LIBSQL_AUTH_TOKEN=(.+)$/m.exec(readFileSync(credentialsPath, "utf8"));
	return match?.[1].trim();
}

async function healthCheck(url) {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const res = await fetch(new URL("/health", url));
			if (res.ok) return true;
		} catch {
			// DNS for a new workers.dev subdomain can take a few seconds.
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
	return false;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	step("Checking Cloudflare login");
	const whoami = spawnSync(wranglerBin, ["whoami"], { cwd: root, encoding: "utf8", shell: isWindows });
	if (whoami.status !== 0 || /not authenticated/i.test(`${whoami.stdout}${whoami.stderr}`)) {
		console.log("Not logged in; opening the Cloudflare login (or set CLOUDFLARE_API_TOKEN).");
		wrangler(["login"]);
	}

	step(`Creating D1 database "${opts.db}"`);
	let db = findDatabase(opts.db);
	if (db) {
		console.log(`Database already exists, reusing it (${db.uuid}).`);
	} else {
		const args = ["d1", "create", opts.db];
		if (opts.location) args.push("--location", opts.location);
		wrangler(args, { capture: true });
		db = findDatabase(opts.db);
		if (!db) fail("Database was created but could not be found with `wrangler d1 list`.");
		console.log(`Created ${db.uuid}.`);
	}

	step("Saving the database to wrangler.jsonc");
	updateConfig(opts.db, db.uuid);
	console.log(`DB binding → ${opts.db} (${db.uuid})`);

	if (opts.schema) {
		step(`Applying schema ${opts.schema}`);
		if (!existsSync(resolve(opts.schema))) fail(`Schema file not found: ${opts.schema}`);
		wrangler(["d1", "execute", opts.db, "--remote", "--yes", "--file", resolve(opts.schema)]);
	}

	step("Deploying the Worker");
	const deployOutput = wrangler(["deploy"], { capture: true });
	process.stdout.write(deployOutput);
	const url = /https:\/\/[^\s]+\.workers\.dev/.exec(deployOutput)?.[0];

	step("Setting the AUTH_TOKEN secret");
	const token = opts.token ?? (opts.newToken ? undefined : readSavedToken()) ?? randomBytes(32).toString("base64url");
	wrangler(["secret", "put", "AUTH_TOKEN"], { capture: true, input: `${token}\n` });
	console.log("Secret set.");

	writeFileSync(
		credentialsPath,
		[
			"# Generated by `npm run setup`. Keep this file private.",
			`LIBSQL_URL=${url ?? "https://<your-worker>.workers.dev"}`,
			`LIBSQL_AUTH_TOKEN=${token}`,
			`D1_DATABASE_NAME=${opts.db}`,
			`D1_DATABASE_ID=${db.uuid}`,
			"",
		].join("\n"),
		{ mode: 0o600 },
	);

	if (url) {
		step("Checking that the Worker is live");
		console.log((await healthCheck(url)) ? "Worker is up." : "Worker did not answer yet; it may need a minute to propagate.");
	} else {
		console.log("\nNo workers.dev URL found in the deploy output (enable workers.dev or add a route in the dashboard).");
	}

	console.log(`
✔ Done. Connection details saved to .libsql.env

  import { createClient } from "@libsql/client";
  const db = createClient({
    url: "${url ?? "https://<your-worker>.workers.dev"}",
    authToken: process.env.LIBSQL_AUTH_TOKEN,
  });
`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
