/*
 * Thin C bridge around DuckDB's C API for Blazor WASM P/Invoke.
 * Compiled with .NET's pinned Emscripten and linked via NativeFileReference.
 */
#include "duckdb.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef struct {
	duckdb_database db;
	duckdb_connection conn;
	int opened;
} duckdb_bridge_ctx;

static duckdb_bridge_ctx g_ctx;

static char *dup_cstr(const char *s)
{
	if (!s) {
		char *empty = (char *)malloc(1);
		if (empty)
			empty[0] = '\0';
		return empty;
	}
	size_t n = strlen(s);
	char *out = (char *)malloc(n + 1);
	if (!out)
		return NULL;
	memcpy(out, s, n + 1);
	return out;
}

static void append_json_escaped(char **buf, size_t *len, size_t *cap, const char *s)
{
	if (!s) {
		return;
	}
	for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
		char esc[7];
		const char *piece = NULL;
		size_t piece_len = 0;
		if (*p == '"' || *p == '\\') {
			esc[0] = '\\';
			esc[1] = (char)*p;
			esc[2] = '\0';
			piece = esc;
			piece_len = 2;
		} else if (*p == '\n') {
			piece = "\\n";
			piece_len = 2;
		} else if (*p == '\r') {
			piece = "\\r";
			piece_len = 2;
		} else if (*p == '\t') {
			piece = "\\t";
			piece_len = 2;
		} else if (*p < 0x20) {
			snprintf(esc, sizeof(esc), "\\u%04x", *p);
			piece = esc;
			piece_len = 6;
		} else {
			esc[0] = (char)*p;
			esc[1] = '\0';
			piece = esc;
			piece_len = 1;
		}

		if (*len + piece_len + 1 > *cap) {
			size_t ncap = (*cap < 64) ? 256 : (*cap * 2);
			while (ncap < *len + piece_len + 1)
				ncap *= 2;
			char *nb = (char *)realloc(*buf, ncap);
			if (!nb)
				return;
			*buf = nb;
			*cap = ncap;
		}
		memcpy(*buf + *len, piece, piece_len);
		*len += piece_len;
		(*buf)[*len] = '\0';
	}
}

static void append_raw(char **buf, size_t *len, size_t *cap, const char *s)
{
	if (!s)
		return;
	size_t n = strlen(s);
	if (*len + n + 1 > *cap) {
		size_t ncap = (*cap < 64) ? 256 : (*cap * 2);
		while (ncap < *len + n + 1)
			ncap *= 2;
		char *nb = (char *)realloc(*buf, ncap);
		if (!nb)
			return;
		*buf = nb;
		*cap = ncap;
	}
	memcpy(*buf + *len, s, n + 1);
	*len += n;
}

/* Returns 0 on success. On failure, *out_error is a malloc'd message (caller frees). */
int duckdb_bridge_open(char **out_error)
{
	if (out_error)
		*out_error = NULL;
	if (g_ctx.opened) {
		return 0;
	}

	duckdb_state st = duckdb_open(NULL, &g_ctx.db);
	if (st == DuckDBError) {
		if (out_error)
			*out_error = dup_cstr("duckdb_open failed");
		return -1;
	}
	st = duckdb_connect(g_ctx.db, &g_ctx.conn);
	if (st == DuckDBError) {
		duckdb_close(&g_ctx.db);
		if (out_error)
			*out_error = dup_cstr("duckdb_connect failed");
		return -1;
	}
	g_ctx.opened = 1;
	return 0;
}

void duckdb_bridge_close(void)
{
	if (!g_ctx.opened)
		return;
	duckdb_disconnect(&g_ctx.conn);
	duckdb_close(&g_ctx.db);
	memset(&g_ctx, 0, sizeof(g_ctx));
}

/* Writes CSV bytes to MEMFS and CREATE OR REPLACE TABLE via read_csv_auto. */
int duckdb_bridge_load_csv(const char *table, const uint8_t *data, size_t len, char **out_error)
{
	if (out_error)
		*out_error = NULL;
	if (!g_ctx.opened || !table || !data) {
		if (out_error)
			*out_error = dup_cstr("not open or bad args");
		return -1;
	}

	char path[256];
	snprintf(path, sizeof(path), "/tmp/%s.csv", table);
	FILE *f = fopen(path, "wb");
	if (!f) {
		if (out_error)
			*out_error = dup_cstr("fopen MEMFS failed");
		return -1;
	}
	if (fwrite(data, 1, len, f) != len) {
		fclose(f);
		if (out_error)
			*out_error = dup_cstr("fwrite failed");
		return -1;
	}
	fclose(f);

	char sql[640];
	snprintf(sql, sizeof(sql),
		 "CREATE OR REPLACE TABLE %s AS SELECT * FROM read_csv_auto('%s', header=true, sample_size=-1)",
		 table, path);

	duckdb_result result;
	duckdb_state st = duckdb_query(g_ctx.conn, sql, &result);
	if (st == DuckDBError) {
		const char *msg = duckdb_result_error(&result);
		if (out_error)
			*out_error = dup_cstr(msg ? msg : "load_csv query failed");
		duckdb_destroy_result(&result);
		return -1;
	}
	duckdb_destroy_result(&result);
	return 0;
}

/*
 * Runs SQL and returns malloc'd JSON:
 * {"columns":[...],"rows":[[...]],"elapsedMs":N,"interopCopyMs":0}
 * Caller must free with duckdb_bridge_free.
 */
char *duckdb_bridge_query_json(const char *sql, char **out_error)
{
	if (out_error)
		*out_error = NULL;
	if (!g_ctx.opened || !sql) {
		if (out_error)
			*out_error = dup_cstr("not open or bad sql");
		return NULL;
	}

	duckdb_result result;
	/* Timing around duckdb_query only (native execution). */
	/* Use duckdb's wall clock via clock if available — caller also times. */
	duckdb_state st = duckdb_query(g_ctx.conn, sql, &result);
	if (st == DuckDBError) {
		const char *msg = duckdb_result_error(&result);
		if (out_error)
			*out_error = dup_cstr(msg ? msg : "query failed");
		duckdb_destroy_result(&result);
		return NULL;
	}

	idx_t col_count = duckdb_column_count(&result);
	idx_t row_count = duckdb_row_count(&result);

	size_t cap = 1024;
	size_t len = 0;
	char *buf = (char *)malloc(cap);
	if (!buf) {
		duckdb_destroy_result(&result);
		if (out_error)
			*out_error = dup_cstr("oom");
		return NULL;
	}
	buf[0] = '\0';

	append_raw(&buf, &len, &cap, "{\"columns\":[");
	for (idx_t c = 0; c < col_count; c++) {
		if (c)
			append_raw(&buf, &len, &cap, ",");
		append_raw(&buf, &len, &cap, "\"");
		append_json_escaped(&buf, &len, &cap, duckdb_column_name(&result, c));
		append_raw(&buf, &len, &cap, "\"");
	}
	append_raw(&buf, &len, &cap, "],\"rows\":[");

	/* Cap rows at 2000 for interop safety; UI further caps display. */
	idx_t emit_rows = row_count > 2000 ? 2000 : row_count;
	for (idx_t r = 0; r < emit_rows; r++) {
		if (r)
			append_raw(&buf, &len, &cap, ",");
		append_raw(&buf, &len, &cap, "[");
		for (idx_t c = 0; c < col_count; c++) {
			if (c)
				append_raw(&buf, &len, &cap, ",");
			if (duckdb_value_is_null(&result, c, r)) {
				append_raw(&buf, &len, &cap, "null");
				continue;
			}
			duckdb_type t = duckdb_column_type(&result, c);
			char tmp[128];
			switch (t) {
			case DUCKDB_TYPE_BOOLEAN:
				append_raw(&buf, &len, &cap, duckdb_value_boolean(&result, c, r) ? "true" : "false");
				break;
			case DUCKDB_TYPE_TINYINT:
			case DUCKDB_TYPE_SMALLINT:
			case DUCKDB_TYPE_INTEGER:
			case DUCKDB_TYPE_BIGINT:
				snprintf(tmp, sizeof(tmp), "%lld", (long long)duckdb_value_int64(&result, c, r));
				append_raw(&buf, &len, &cap, tmp);
				break;
			case DUCKDB_TYPE_FLOAT:
			case DUCKDB_TYPE_DOUBLE:
			case DUCKDB_TYPE_DECIMAL: {
				double d = duckdb_value_double(&result, c, r);
				if (isnan(d) || isinf(d))
					append_raw(&buf, &len, &cap, "null");
				else {
					snprintf(tmp, sizeof(tmp), "%.15g", d);
					append_raw(&buf, &len, &cap, tmp);
				}
				break;
			}
			default: {
				char *s = duckdb_value_varchar(&result, c, r);
				append_raw(&buf, &len, &cap, "\"");
				append_json_escaped(&buf, &len, &cap, s ? s : "");
				append_raw(&buf, &len, &cap, "\"");
				if (s)
					duckdb_free(s);
				break;
			}
			}
		}
		append_raw(&buf, &len, &cap, "]");
	}
	append_raw(&buf, &len, &cap, "],\"elapsedMs\":0,\"interopCopyMs\":0,\"rowCount\":");
	{
		char rc[32];
		snprintf(rc, sizeof(rc), "%llu", (unsigned long long)row_count);
		append_raw(&buf, &len, &cap, rc);
	}
	append_raw(&buf, &len, &cap, "}");

	duckdb_destroy_result(&result);
	return buf;
}

void duckdb_bridge_free(void *p)
{
	if (p)
		free(p);
}
