import type { StreamState } from "./baton";
import { SqlError, toProtoError } from "./errors";
import type { Batch, BatchCond, BatchResult, DescribeResult, ProtoError, Stmt, StmtResult } from "./protocol";
import { bindSql, classifySql, describeParams, isExplain, type StmtKind } from "./sql";
import { valueFromD1 } from "./values";

interface PreparedStep {
	stmt: D1PreparedStatement;
	kind: StmtKind;
	wantRows: boolean;
}

function emptyResult(): StmtResult {
	return {
		cols: [],
		rows: [],
		affected_row_count: 0,
		last_insert_rowid: null,
		rows_read: 0,
		rows_written: 0,
		query_duration_ms: 0,
	};
}

/** Convert a D1Result (rows as objects, plus meta) into a Hrana StmtResult. */
function resultFromD1(result: D1Result<Record<string, unknown>>, kind: StmtKind, wantRows: boolean): StmtResult {
	const objects = result.results ?? [];
	const names = objects.length > 0 ? Object.keys(objects[0]) : [];
	const meta = (result.meta ?? {}) as Partial<D1Meta>;
	return {
		cols: names.map((name) => ({ name, decltype: null })),
		rows: wantRows ? objects.map((o) => names.map((n) => valueFromD1(o[n]))) : [],
		affected_row_count: kind === "write" ? (meta.changes ?? 0) : 0,
		last_insert_rowid: kind === "write" && meta.last_row_id != null ? String(meta.last_row_id) : null,
		rows_read: meta.rows_read ?? 0,
		rows_written: meta.rows_written ?? 0,
		query_duration_ms: meta.duration ?? 0,
	};
}

function evalCond(cond: BatchCond, results: (StmtResult | null)[], errors: (ProtoError | null)[], autocommit: boolean): boolean {
	switch (cond.type) {
		case "ok":
			return results[cond.step] != null;
		case "error":
			return errors[cond.step] != null;
		case "not":
			return !evalCond(cond.cond, results, errors, autocommit);
		case "and":
			return cond.conds.every((c) => evalCond(c, results, errors, autocommit));
		case "or":
			return cond.conds.some((c) => evalCond(c, results, errors, autocommit));
		case "is_autocommit":
			return autocommit;
		default:
			throw new SqlError(`Unknown batch condition type: ${(cond as { type: unknown }).type}`, "PROTOCOL");
	}
}

/** Executes Hrana requests against a D1 database. */
export class Executor {
	constructor(
		private readonly db: D1Database,
		private readonly state: StreamState,
	) {}

	resolveSql(sql: string | null | undefined, sqlId: number | null | undefined): string {
		if (typeof sql === "string") return sql;
		if (typeof sqlId === "number") {
			const stored = this.state.sqls.get(sqlId);
			if (stored === undefined) throw new SqlError(`SQL text ${sqlId} not found`, "SQL_NOT_FOUND");
			return stored;
		}
		throw new SqlError("Statement has neither sql nor sql_id", "PROTOCOL");
	}

	storeSql(sqlId: number, sql: string): void {
		this.state.sqls.set(sqlId, sql);
	}

	closeSql(sqlId: number): void {
		this.state.sqls.delete(sqlId);
	}

	private prepare(stmt: Stmt): PreparedStep {
		const sql = this.resolveSql(stmt.sql, stmt.sql_id);
		const kind = classifySql(sql);
		const bound = bindSql(sql, stmt.args ?? [], stmt.named_args ?? []);
		return {
			stmt: this.db.prepare(bound.sql).bind(...bound.values),
			kind,
			wantRows: stmt.want_rows !== false,
		};
	}

	private async run(step: PreparedStep): Promise<StmtResult> {
		if (step.kind === "read") {
			// raw() keeps column order and duplicate column names intact.
			const [names = [], ...rows] = await step.stmt.raw<unknown[]>({ columnNames: true });
			return {
				...emptyResult(),
				cols: names.map((name) => ({ name, decltype: null })),
				rows: step.wantRows ? rows.map((r) => r.map(valueFromD1)) : [],
			};
		}
		const result = await step.stmt.run<Record<string, unknown>>();
		return resultFromD1(result, step.kind, step.wantRows);
	}

	/** Execute a single statement outside of a batch. */
	async execute(stmt: Stmt): Promise<StmtResult> {
		const step = this.prepare(stmt);
		switch (step.kind) {
			case "begin":
				throw new SqlError(
					"Interactive transactions are not supported by D1; use a batch (client.batch()) instead",
					"TRANSACTION_UNSUPPORTED",
				);
			case "commit":
				throw new SqlError("cannot commit - no transaction is active");
			case "rollback":
				throw new SqlError("cannot rollback - no transaction is active");
			default:
				return this.run(step);
		}
	}

	/**
	 * Execute a batch. Statements between BEGIN and COMMIT are sent to D1 as a
	 * single `db.batch()` call, which D1 executes atomically in a transaction.
	 */
	async batch(batch: Batch): Promise<BatchResult> {
		const steps = batch.steps ?? [];
		const n = steps.length;
		const results: (StmtResult | null)[] = new Array(n).fill(null);
		const errors: (ProtoError | null)[] = new Array(n).fill(null);
		// Set after a transaction failed: D1 already rolled it back, but the client
		// still believes a transaction is open until it issues ROLLBACK.
		let aborted = false;

		let i = 0;
		while (i < n) {
			const step = steps[i];
			if (step.condition && !evalCond(step.condition, results, errors, !aborted)) {
				i++;
				continue;
			}
			let prepared: PreparedStep;
			try {
				prepared = this.prepare(step.stmt);
			} catch (e) {
				errors[i] = toProtoError(e);
				i++;
				continue;
			}

			if (aborted) {
				if (prepared.kind === "rollback") {
					results[i] = emptyResult();
					aborted = false;
				} else {
					errors[i] = { message: "transaction was rolled back because a statement failed", code: "SQLITE_ABORT" };
				}
				i++;
				continue;
			}

			if (prepared.kind === "commit" || prepared.kind === "rollback") {
				errors[i] = toProtoError(new SqlError(`cannot ${prepared.kind} - no transaction is active`));
				i++;
				continue;
			}
			if (prepared.kind !== "begin") {
				try {
					results[i] = await this.run(prepared);
				} catch (e) {
					errors[i] = toProtoError(e);
				}
				i++;
				continue;
			}

			i = await this.runTransaction(steps, i, results, errors, (v) => (aborted = v));
		}
		return { step_results: results, step_errors: errors };
	}

	/**
	 * Handle a BEGIN at `begin`. Returns the index of the next step to evaluate.
	 * Step conditions inside the transaction are evaluated speculatively, assuming
	 * every statement succeeds, which is exactly what happens when D1 commits.
	 */
	private async runTransaction(
		steps: Batch["steps"],
		begin: number,
		results: (StmtResult | null)[],
		errors: (ProtoError | null)[],
		setAborted: (v: boolean) => void,
	): Promise<number> {
		const specResults = results.slice();
		specResults[begin] = emptyResult();
		const specErrors = errors.slice();
		const group: { index: number; step: PreparedStep }[] = [];
		let end = -1;
		let failure: { index: number; error: ProtoError } | null = null;

		for (let j = begin + 1; j < steps.length; j++) {
			const s = steps[j];
			if (s.condition && !evalCond(s.condition, specResults, specErrors, false)) continue;
			let prepared: PreparedStep;
			try {
				prepared = this.prepare(s.stmt);
			} catch (e) {
				failure = { index: j, error: toProtoError(e) };
				break;
			}
			if (prepared.kind === "commit") {
				end = j;
				break;
			}
			if (prepared.kind === "rollback") {
				failure = {
					index: j,
					error: { message: "ROLLBACK inside a batch is not supported by D1", code: "TRANSACTION_UNSUPPORTED" },
				};
				break;
			}
			if (prepared.kind === "begin") {
				failure = { index: j, error: { message: "cannot start a transaction within a transaction", code: "SQLITE_ERROR" } };
				break;
			}
			group.push({ index: j, step: prepared });
			specResults[j] = emptyResult();
		}

		if (failure === null && end === -1) {
			errors[begin] = {
				message: "Interactive transactions are not supported by D1; a transaction must be committed within the same batch (use client.batch())",
				code: "TRANSACTION_UNSUPPORTED",
			};
			return begin + 1;
		}

		results[begin] = emptyResult();
		if (failure === null) {
			try {
				const d1Results =
					group.length > 0
						? await this.db.batch<Record<string, unknown>>(group.map((g) => g.step.stmt))
						: [];
				group.forEach((g, k) => {
					results[g.index] = resultFromD1(d1Results[k], g.step.kind, g.step.wantRows);
				});
				results[end] = emptyResult();
				return end + 1;
			} catch (e) {
				// D1 rolled back the whole batch. It does not say which statement failed,
				// so the error is attributed to the first statement of the transaction.
				failure = { index: group[0]?.index ?? end, error: toProtoError(e) };
			}
		}

		errors[failure.index] = failure.error;
		setAborted(true);
		return failure.index + 1;
	}

	async sequence(sql: string): Promise<void> {
		const kind = classifySql(sql);
		if (kind === "begin") {
			throw new SqlError("Interactive transactions are not supported by D1", "TRANSACTION_UNSUPPORTED");
		}
		await this.db.exec(sql);
	}

	describe(sql: string): DescribeResult {
		const kind = classifySql(sql);
		return {
			params: describeParams(sql),
			cols: [],
			is_explain: isExplain(sql),
			is_readonly: kind === "read",
		};
	}
}
