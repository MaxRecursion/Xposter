// Classic script bridge for Blazor WASM (no ES module exports — avoids fingerprint/import issues).
(function () {
  'use strict';

  const DUCKDB_VERSION = '1.29.0';
  const DUCKDB_CDN = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;

  const rootHandlePromise = navigator.storage?.getDirectory?.();

  let duckdbModule = null;
  let db = null;
  let connection = null;
  let initialized = false;

  async function getDirectoryHandle(path, create = false) {
    const root = await rootHandlePromise;
    if (!root) throw new Error('OPFS is not available in this browser.');
    const parts = path.split('/').filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, { create });
    }
    return current;
  }

  async function getParentAndName(path) {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error(`Invalid path: ${path}`);
    const parentPath = parts.join('/');
    const parent = parentPath ? await getDirectoryHandle(parentPath, true) : await rootHandlePromise;
    return { parent, fileName };
  }

  async function writeText(path, content) {
    const { parent, fileName } = await getParentAndName(path);
    const handle = await parent.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async function readText(path) {
    try {
      const { parent, fileName } = await getParentAndName(path);
      const handle = await parent.getFileHandle(fileName);
      const file = await handle.getFile();
      return await file.text();
    } catch {
      return null;
    }
  }

  async function writeBytes(path, bytes) {
    const { parent, fileName } = await getParentAndName(path);
    const handle = await parent.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    await writable.write(data);
    await writable.close();
  }

  async function readBytes(path) {
    try {
      const { parent, fileName } = await getParentAndName(path);
      const handle = await parent.getFileHandle(fileName);
      const file = await handle.getFile();
      const buffer = await file.arrayBuffer();
      return Array.from(new Uint8Array(buffer));
    } catch {
      return null;
    }
  }

  async function deletePath(path) {
    try {
      const { parent, fileName } = await getParentAndName(path);
      await parent.removeEntry(fileName);
    } catch {
      // ignore
    }
  }

  async function deleteDirectory(path) {
    try {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 0) return;
      const dirName = parts.pop();
      const parentPath = parts.join('/');
      const parent = parentPath ? await getDirectoryHandle(parentPath, false) : await rootHandlePromise;
      await parent.removeEntry(dirName, { recursive: true });
    } catch {
      // ignore
    }
  }

  async function listDirectories(path) {
    try {
      const dir = await getDirectoryHandle(path, false);
      const names = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') names.push(name);
      }
      return names;
    } catch {
      return [];
    }
  }

  async function getStorageEstimate() {
    if (!navigator.storage?.estimate) return null;
    const estimate = await navigator.storage.estimate();
    return {
      usageBytes: estimate.usage ?? 0,
      quotaBytes: estimate.quota ?? 0,
    };
  }

  async function requestPersistence() {
    if (!navigator.storage?.persist) return false;
    return await navigator.storage.persist();
  }

  async function loadDuckDb() {
    if (duckdbModule) return duckdbModule;
    duckdbModule = await import(DUCKDB_CDN);
    return duckdbModule;
  }

  async function instantiateDb() {
    const duckdb = await loadDuckDb();
    const base = '/lib/duckdb-wasm/';
    const manualBundles = {
      mvp: {
        mainModule: base + 'duckdb-mvp.wasm',
        mainWorker: base + 'duckdb-browser-mvp.worker.js',
      },
      eh: {
        mainModule: base + 'duckdb-eh.wasm',
        mainWorker: base + 'duckdb-browser-eh.worker.js',
      },
    };
    const bundle = await duckdb.selectBundle(manualBundles);
    const worker = new Worker(bundle.mainWorker, { type: 'module' });
    const logger = new duckdb.ConsoleLogger();
    const instance = new duckdb.AsyncDuckDB(logger, worker);
    await instance.instantiate(bundle.mainModule, bundle.pthreadWorker);
    try {
      await instance.open({
        path: 'opfs://analytics_catalog.db',
        accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
      });
    } catch (openError) {
      console.warn('OPFS catalog open failed, using in-memory catalog:', openError);
      await instance.open({
        path: ':memory:',
        accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
      });
    }
    const conn = await instance.connect();
    await conn.query("SET checkpoint_threshold = '0KB'");
    db = instance;
    connection = conn;
    initialized = true;
  }

  async function ensureReady() {
    if (!initialized) await instantiateDb();
  }

  function sanitizeTableName(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  // DuckDB WASM may return BigInt — Blazor interop cannot marshal those to C#.
  function normalizeInteropValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  async function query(sql) {
    await ensureReady();
    const start = performance.now();
    const result = await connection.query(sql);
    const elapsedMs = Math.round(performance.now() - start);

    if (typeof result.toArray === 'function') {
      const objects = result.toArray();
      const columns = result.schema?.fields?.map((f) => f.name)
        ?? (objects[0] ? Object.keys(objects[0]) : []);
      const rows = objects.map((row) => columns.map((c) => normalizeInteropValue(row[c])));
      return { columns, rows, elapsedMs };
    }

    return { columns: [], rows: [], elapsedMs };
  }

  window.SapAnalyticsBridge = {
    initialize: async () => {
      await requestPersistence();
      await ensureReady();
      return { ok: true };
    },
    writeText,
    readText,
    writeBytes,
    readBytes,
    deletePath,
    deleteDirectory,
    listDirectories,
    getStorageEstimate,
    registerDataset: async (entityId, opfsPath, format = 'parquet') => {
      await ensureReady();
      const tableName = sanitizeTableName(entityId);
      const storagePath = opfsPath.replace(/^opfs:\/\//, '');
      const bytes = await readBytes(storagePath);
      if (!bytes || bytes.length === 0) {
        throw new Error(`OPFS file not found or empty: ${storagePath}`);
      }
      const ext = format === 'csv' ? 'csv' : 'parquet';
      const vfsName = `import_${tableName}_${Date.now()}.${ext}`;
      await db.registerFileBuffer(vfsName, new Uint8Array(bytes));
      await connection.query(`DROP TABLE IF EXISTS ${tableName}`);
      if (format === 'csv') {
        await connection.query(
          `CREATE TABLE ${tableName} AS SELECT * FROM read_csv('${vfsName}', header=true)`
        );
      } else {
        await connection.query(
          `CREATE TABLE ${tableName} AS SELECT * FROM read_parquet('${vfsName}')`
        );
      }
      return { tableName };
    },
    refreshMaterializedViews: async (statements) => {
      await ensureReady();
      for (const sql of statements) {
        await connection.query(sql);
      }
      return { ok: true };
    },
    query,
    queryJson: async (sql) => JSON.stringify(await query(sql)),
    scalarLong: async (sql) => {
      const result = await query(sql);
      const value = result.rows?.[0]?.[0];
      if (value === null || value === undefined) return 0;
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    },
    loadSampleData: async () => {
      await ensureReady();
      await connection.query('DROP TABLE IF EXISTS companies');
      await connection.query('DROP TABLE IF EXISTS transactions');
      await connection.query('DROP TABLE IF EXISTS funds');
      await connection.query('DROP TABLE IF EXISTS users');
      await connection.query(`CREATE TABLE companies (company_id INTEGER, name VARCHAR, region VARCHAR, group_id INTEGER)`);
      await connection.query(`CREATE TABLE transactions (transaction_id INTEGER, company_id INTEGER, fund_id INTEGER, amount DOUBLE, period VARCHAR, transaction_date DATE)`);
      await connection.query(`CREATE TABLE funds (fund_id INTEGER, name VARCHAR, category VARCHAR)`);
      await connection.query(`CREATE TABLE users (user_id INTEGER, name VARCHAR, region VARCHAR, company_id INTEGER)`);
      await connection.query(`INSERT INTO companies SELECT i AS company_id, 'Company ' || i AS name, CASE WHEN i % 3 = 0 THEN 'North' WHEN i % 3 = 1 THEN 'South' ELSE 'West' END AS region, (i % 10) + 1 AS group_id FROM range(1, 501) t(i)`);
      await connection.query(`INSERT INTO funds SELECT i AS fund_id, 'Fund ' || i AS name, CASE WHEN i % 2 = 0 THEN 'Equity' ELSE 'Debt' END AS category FROM range(1, 21) t(i)`);
      await connection.query(`INSERT INTO users SELECT i AS user_id, 'User ' || i AS name, CASE WHEN i % 3 = 0 THEN 'North' WHEN i % 3 = 1 THEN 'South' ELSE 'West' END AS region, (i % 500) + 1 AS company_id FROM range(1, 1001) t(i)`);
      await connection.query(`INSERT INTO transactions SELECT i AS transaction_id, (i % 500) + 1 AS company_id, (i % 20) + 1 AS fund_id, (random() * 10000)::DOUBLE AS amount, '2024-' || LPAD(CAST((i % 12) + 1 AS VARCHAR), 2, '0') AS period, DATE '2024-01-01' + (i % 365) AS transaction_date FROM range(1, 50001) t(i)`);
      return { rowCount: 50000 };
    },
    getJsHeapUsed: () => performance.memory?.usedJSHeapSize ?? null,
  };
})();
