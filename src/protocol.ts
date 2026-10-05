// Types for the Hrana-over-HTTP protocol (JSON encoding), versions 2 and 3.
// Spec: https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md

export type Value =
	| { type: "null" }
	| { type: "integer"; value: string }
	| { type: "float"; value: number }
	| { type: "text"; value: string }
	| { type: "blob"; base64: string };

export interface NamedArg {
	name: string;
	value: Value;
}

export interface Stmt {
	sql?: string | null;
	sql_id?: number | null;
	args?: Value[];
	named_args?: NamedArg[];
	want_rows?: boolean;
}

export interface Col {
	name: string | null;
	decltype: string | null;
}

export interface StmtResult {
	cols: Col[];
	rows: Value[][];
	affected_row_count: number;
	last_insert_rowid: string | null;
	rows_read: number;
	rows_written: number;
	query_duration_ms: number;
}

export interface ProtoError {
	message: string;
	code: string | null;
}

export type BatchCond =
	| { type: "ok"; step: number }
	| { type: "error"; step: number }
	| { type: "not"; cond: BatchCond }
	| { type: "and"; conds: BatchCond[] }
	| { type: "or"; conds: BatchCond[] }
	| { type: "is_autocommit" };

export interface BatchStep {
	condition?: BatchCond | null;
	stmt: Stmt;
}

export interface Batch {
	steps: BatchStep[];
}

export interface BatchResult {
	step_results: (StmtResult | null)[];
	step_errors: (ProtoError | null)[];
}

export interface DescribeResult {
	params: { name: string | null }[];
	cols: { name: string; decltype: string | null }[];
	is_explain: boolean;
	is_readonly: boolean;
}

export type StreamRequest =
	| { type: "close" }
	| { type: "execute"; stmt: Stmt }
	| { type: "batch"; batch: Batch }
	| { type: "sequence"; sql?: string | null; sql_id?: number | null }
	| { type: "describe"; sql?: string | null; sql_id?: number | null }
	| { type: "store_sql"; sql_id: number; sql: string }
	| { type: "close_sql"; sql_id: number }
	| { type: "get_autocommit" };

export type StreamResponse =
	| { type: "close" }
	| { type: "execute"; result: StmtResult }
	| { type: "batch"; result: BatchResult }
	| { type: "sequence" }
	| { type: "describe"; result: DescribeResult }
	| { type: "store_sql" }
	| { type: "close_sql" }
	| { type: "get_autocommit"; is_autocommit: boolean };

export type StreamResult =
	| { type: "ok"; response: StreamResponse }
	| { type: "error"; error: ProtoError };

export interface PipelineReqBody {
	baton: string | null;
	requests: StreamRequest[];
}

export interface PipelineRespBody {
	baton: string | null;
	base_url: string | null;
	results: StreamResult[];
}

export interface CursorReqBody {
	baton: string | null;
	batch: Batch;
}

export type CursorEntry =
	| { type: "step_begin"; step: number; cols: Col[] }
	| { type: "step_end"; affected_row_count: number; last_insert_rowid: string | null }
	| { type: "step_error"; step: number; error: ProtoError }
	| { type: "row"; row: Value[] }
	| { type: "error"; error: ProtoError };
