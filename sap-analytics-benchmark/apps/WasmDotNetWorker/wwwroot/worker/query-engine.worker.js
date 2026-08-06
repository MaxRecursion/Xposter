import { createQueryEngine } from './duckdb-worker-engine.js';

const engine = createQueryEngine();

self.onmessage = async (event) => {
  const { id, type, sql } = event.data;
  const reply = (ok, payload, error) => self.postMessage({ id, ok, payload, error });

  try {
    if (type === 'initialize') {
      const result = await engine.initialize();
      reply(true, result);
      return;
    }
    if (type === 'query') {
      const payload = await engine.query(sql);
      reply(true, payload);
      return;
    }
    if (type === 'runFullSuite') {
      const payload = await engine.runFullSuite();
      reply(true, payload);
      return;
    }
    reply(false, null, `Unknown message type: ${type}`);
  } catch (err) {
    reply(false, null, String(err?.message || err));
  }
};
