import * as opfs from './opfs-storage.js';

const DUCKDB_VERSION = '1.29.0';
const CDN = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/dist/`;

let duckdbModule = null;
let db = null;
let connection = null;
let initialized = false;

async function loadDuckDb() {
  if (duckdbModule) return duckdbModule;
  const moduleUrl = `${CDN}duckdb-browser.mjs`;
  duckdbModule = await import(moduleUrl);
  return duckdbModule;
}

async function instantiateDb() {
  const duckdb = await loadDuckDb();
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerUrl = bundle.mainWorker;
  const worker = typeof workerUrl === 'string' ? new Worker(workerUrl) : new Worker(workerUrl, { type: 'module' });
  const logger = new duckdb.ConsoleLogger();
  const instance = new duckdb.AsyncDuckDB(logger, worker);
  await instance.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await instance.open({
    path: 'opfs://catalog.db',
    accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
  });
  const conn = await instance.connect();
  await conn.query("SET checkpoint_threshold = '0KB'");
  db = instance;
  connection = conn;
  initialized = true;
  return { db, connection };
}

function rowsToPayload(table, elapsedMs) {
  const columns = table.schema?.fields?.map((f) => f.name) ?? [];
  const rows = [];
  for (const batch of table.batches ?? []) {
    const len = batch.numRows ?? 0;
    for (let i = 0; i < len; i++) {
      const row = [];
      for (let c = 0; c < columns.length; c++) {
        row.push(batch.getChildAt(c)?.get(i));
      }
      rows.push(row);
    }
  }
  return { columns, rows, elapsedMs };
}

async function ensureReady() {
  if (!initialized) await instantiateDb();
}

export async function initialize() {
  await opfs.requestPersistence();
  await ensureReady();
  return { ok: true };
}

export async function registerDataset(entityId, opfsPath, format = 'parquet') {
  await ensureReady();
  const tableName = sanitizeTableName(entityId);
  const escapedPath = opfsPath.replace(/'/g, "''");
  const reader = format === 'csv' ? 'read_csv' : 'read_parquet';
  await connection.query(`DROP TABLE IF EXISTS ${tableName}`);
  await connection.query(
    `CREATE TABLE ${tableName} AS SELECT * FROM ${reader}('${escapedPath}')`
  );
  return { tableName };
}

export async function registerParquet(entityId, opfsPath) {
  return registerDataset(entityId, opfsPath, 'parquet');
}

export async function refreshMaterializedViews(statements) {
  await ensureReady();
  for (const sql of statements) {
    await connection.query(sql);
  }
  return { ok: true };
}

export async function query(sql) {
  await ensureReady();
  const start = performance.now();
  const result = await connection.query(sql);
  const elapsedMs = Math.round(performance.now() - start);

  if (typeof result.toArray === 'function') {
    const objects = result.toArray();
    const columns = result.schema?.fields?.map((f) => f.name)
      ?? (objects[0] ? Object.keys(objects[0]) : []);
    const rows = objects.map((row) => columns.map((c) => row[c]));
    return { columns, rows, elapsedMs };
  }

  return rowsToPayload(result, elapsedMs);
}

export async function scalarLong(sql) {
  const result = await query(sql);
  const value = result.rows?.[0]?.[0];
  if (value === null || value === undefined) return 0;
  return Number(value);
}

export async function loadSampleData() {
  await ensureReady();

  await connection.query('DROP TABLE IF EXISTS companies');
  await connection.query('DROP TABLE IF EXISTS transactions');
  await connection.query('DROP TABLE IF EXISTS funds');
  await connection.query('DROP TABLE IF EXISTS users');

  await connection.query(`
    CREATE TABLE companies (
      company_id INTEGER,
      name VARCHAR,
      region VARCHAR,
      group_id INTEGER
    )
  `);

  await connection.query(`
    CREATE TABLE transactions (
      transaction_id INTEGER,
      company_id INTEGER,
      fund_id INTEGER,
      amount DOUBLE,
      period VARCHAR,
      transaction_date DATE
    )
  `);

  await connection.query(`
    CREATE TABLE funds (
      fund_id INTEGER,
      name VARCHAR,
      category VARCHAR
    )
  `);

  await connection.query(`
    CREATE TABLE users (
      user_id INTEGER,
      name VARCHAR,
      region VARCHAR,
      company_id INTEGER
    )
  `);

  // Seed representative sample: 50k transactions for POC (scalable via Parquet import)
  await connection.query(`
    INSERT INTO companies SELECT
      i AS company_id,
      'Company ' || i AS name,
      CASE WHEN i % 3 = 0 THEN 'North' WHEN i % 3 = 1 THEN 'South' ELSE 'West' END AS region,
      (i % 10) + 1 AS group_id
    FROM range(1, 501) t(i)
  `);

  await connection.query(`
    INSERT INTO funds SELECT
      i AS fund_id,
      'Fund ' || i AS name,
      CASE WHEN i % 2 = 0 THEN 'Equity' ELSE 'Debt' END AS category
    FROM range(1, 21) t(i)
  `);

  await connection.query(`
    INSERT INTO users SELECT
      i AS user_id,
      'User ' || i AS name,
      CASE WHEN i % 3 = 0 THEN 'North' WHEN i % 3 = 1 THEN 'South' ELSE 'West' END AS region,
      (i % 500) + 1 AS company_id
    FROM range(1, 1001) t(i)
  `);

  await connection.query(`
    INSERT INTO transactions SELECT
      i AS transaction_id,
      (i % 500) + 1 AS company_id,
      (i % 20) + 1 AS fund_id,
      (random() * 10000)::DOUBLE AS amount,
      '2024-' || LPAD(CAST((i % 12) + 1 AS VARCHAR), 2, '0') AS period,
      DATE '2024-01-01' + (i % 365) AS transaction_date
    FROM range(1, 50001) t(i)
  `);

  return { rowCount: 50000 };
}

function sanitizeTableName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export async function getJsHeapUsed() {
  if (performance.memory?.usedJSHeapSize) {
    return performance.memory.usedJSHeapSize;
  }
  return null;
}

// Re-export OPFS for Blazor single module entry
export const writeText = opfs.writeText;
export const readText = opfs.readText;
export const writeBytes = opfs.writeBytes;
export const readBytes = opfs.readBytes;
export const deletePath = opfs.deletePath;
export const deleteDirectory = opfs.deleteDirectory;
export const listDirectories = opfs.listDirectories;
export const getStorageEstimate = opfs.getStorageEstimate;
