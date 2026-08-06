(function () {
  'use strict';

  const DUCKDB_VERSION = '1.32.0';
  const DUCKDB_CDN = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;
  const DATA_FILES = [
    { name: 'companies.csv', table: 'companies' },
    { name: 'funds.csv', table: 'funds' },
    { name: 'users.csv', table: 'users' },
    { name: 'transactions.csv', table: 'transactions' },
    { name: 'funds_distribution.csv', table: 'funds_distribution' },
  ];

  const QUERIES = {
    Q1ScanAgg: `SELECT COUNT(*) AS txn_count, SUM(amount) AS total_amount, AVG(amount) AS avg_amount FROM transactions`,
    Q2TimeSeries: `SELECT t.period, f.category, COUNT(*) AS txn_count, SUM(t.amount) AS total_amount FROM transactions t JOIN funds f ON t.fund_id = f.fund_id GROUP BY t.period, f.category ORDER BY t.period, f.category`,
    Q3JoinFilter: `SELECT c.region, c.group_id, COUNT(*) AS txn_count, SUM(t.amount) AS total_amount FROM transactions t JOIN companies c ON t.company_id = c.company_id WHERE c.region IN ('North', 'South', 'East', 'West') GROUP BY c.region, c.group_id ORDER BY total_amount DESC LIMIT 200`,
    Q4ForkJoin: `WITH txn_leg AS (SELECT t.period, SUM(t.amount) AS txn_amount, COUNT(*) AS txn_count FROM transactions t GROUP BY t.period), dist_leg AS (SELECT d.period, SUM(d.distribution_amount) AS dist_amount, COUNT(*) AS dist_count FROM funds_distribution d GROUP BY d.period) SELECT COALESCE(txn_leg.period, dist_leg.period) AS period, txn_leg.txn_amount, txn_leg.txn_count, dist_leg.dist_amount, dist_leg.dist_count FROM txn_leg FULL OUTER JOIN dist_leg ON txn_leg.period = dist_leg.period ORDER BY period`,
  };

  let duckdbModule = null;
  let db = null;
  let connection = null;
  let initialized = false;
  const stepTimings = [];

  function nowMs() {
    return performance.now();
  }

  function pushStep(step, elapsedMs, notes, theoretical) {
    stepTimings.push({ step, elapsedMs, notes: notes || null, isTheoretical: !!theoretical });
  }

  async function loadDuckDb() {
    if (duckdbModule) return duckdbModule;
    duckdbModule = await import(DUCKDB_CDN);
    return duckdbModule;
  }

  function normalizeValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();
    return String(value);
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
    // Plan lesson: never db.open({ path: 'opfs://…' }) — use in-memory catalogue.
    await instance.open({ path: ':memory:', accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    const conn = await instance.connect();
    await conn.query("SET checkpoint_threshold = '0KB'");
    db = instance;
    connection = conn;
    initialized = true;
  }

  async function ensureReady() {
    if (!initialized) await instantiateDb();
  }

  async function fetchDataFile(fileName) {
    const response = await fetch(`/data/${fileName}`);
    if (!response.ok) {
      throw new Error(`Missing dataset file /data/${fileName}. Run spikes/data/generate-dataset.mjs first.`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function loadDataset() {
    const loadStart = nowMs();
    for (const file of DATA_FILES) {
      const bytes = await fetchDataFile(file.name);
      const vfsName = file.name;
      await db.registerFileBuffer(vfsName, bytes);
      await connection.query(`DROP TABLE IF EXISTS ${file.table}`);
      await connection.query(
        `CREATE TABLE ${file.table} AS SELECT * FROM read_csv('${vfsName}', header=true)`
      );
    }
    pushStep('LoadData', nowMs() - loadStart, `${DATA_FILES.length} CSV files via registerFileBuffer`);
    pushStep('RegisterOpfs', 0, 'Using registerFileBuffer (no opfs:// db.open per Spike 1)');
  }

  async function query(sql) {
    await ensureReady();
    const queryStart = nowMs();
    const result = await connection.query(sql);
    const queryMs = nowMs() - queryStart;

    const copyStart = nowMs();
    let columns = [];
    let rows = [];
    if (typeof result.toArray === 'function') {
      const objects = result.toArray();
      columns = result.schema?.fields?.map((f) => f.name) ?? (objects[0] ? Object.keys(objects[0]) : []);
      rows = objects.map((row) => columns.map((c) => normalizeValue(row[c])));
    }
    const interopCopyMs = nowMs() - copyStart;

    return { columns, rows, elapsedMs: queryMs, interopCopyMs };
  }

  async function runQueryStep(stepKey, stepEnum) {
    const sql = QUERIES[stepKey];
    const payload = await query(sql);
    pushStep(stepEnum, payload.elapsedMs, `${payload.rows.length} rows returned`);
    if (payload.interopCopyMs > 0) {
      pushStep('ArrowInteropCopy', payload.interopCopyMs, stepEnum);
    }
    return payload;
  }

  window.BenchmarkBridge = {
    initialize: async () => {
      const start = nowMs();
      stepTimings.length = 0;
      try {
        if (navigator.storage?.persist) {
          await navigator.storage.persist();
        }
        await ensureReady();
        await loadDataset();
        pushStep('Init', nowMs() - start, 'duckdb-wasm eh bundle, :memory: catalog');
        return { ok: true, message: 'DuckDB-WASM ready with 1M-row heterogeneous dataset.' };
      } catch (err) {
        return { ok: false, message: String(err?.message || err) };
      }
    },

    queryJson: async (sql) => JSON.stringify(await query(sql)),

    runFullSuite: async () => {
      const startedAt = new Date().toISOString();
      stepTimings.length = 0;
      try {
        const initStart = nowMs();
        await ensureReady();
        await loadDataset();
        pushStep('Init', nowMs() - initStart);

        await runQueryStep('Q1ScanAgg', 'Q1ScanAgg');
        await runQueryStep('Q2TimeSeries', 'Q2TimeSeries');
        await runQueryStep('Q3JoinFilter', 'Q3JoinFilter');
        await runQueryStep('Q4ForkJoin', 'Q4ForkJoin');

        const gridStart = nowMs();
        await query(QUERIES.Q3JoinFilter);
        pushStep('GridBind', nowMs() - gridStart, 'simulated bind');

        const chartStart = nowMs();
        await query(QUERIES.Q2TimeSeries);
        pushStep('ChartBind', nowMs() - chartStart, 'simulated chart bind');

        const result = {
          approach: 'WasmJsInterop',
          startedAt,
          completedAt: new Date().toISOString(),
          rowCount: 1000000,
          steps: stepTimings,
          error: null,
        };
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({
          approach: 'WasmJsInterop',
          startedAt,
          completedAt: new Date().toISOString(),
          rowCount: 0,
          steps: stepTimings,
          error: String(err?.message || err),
        });
      }
    },

    downloadJson: (fileName, jsonText) => {
      const blob = new Blob([jsonText], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    },

    renderBarChart: (canvas, labels, values) => {
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      if (!values.length) return;
      const max = Math.max(...values, 1);
      const barW = Math.max(4, (w - 40) / values.length - 4);
      ctx.fillStyle = '#3d8bfd';
      values.forEach((v, i) => {
        const barH = (v / max) * (h - 50);
        const x = 30 + i * (barW + 4);
        const y = h - 20 - barH;
        ctx.fillRect(x, y, barW, barH);
      });
      ctx.fillStyle = '#8b9cb3';
      ctx.font = '10px sans-serif';
      labels.slice(0, 12).forEach((label, i) => {
        if (i % 2 === 0) ctx.fillText(String(label).slice(0, 7), 30 + i * (barW + 4), h - 6);
      });
    },
  };
})();
