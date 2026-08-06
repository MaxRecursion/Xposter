// Minimal helpers for V2 — queries run via native DuckDB P/Invoke, not duckdb-wasm.
window.BenchmarkBridge = {
  downloadJson(filename, jsonText) {
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'timing.json';
    a.click();
    URL.revokeObjectURL(url);
  }
};
