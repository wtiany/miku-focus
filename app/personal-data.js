/* Local-only task data. Shared with the data tests and usable without a server. */
(function (root) {
  "use strict";
  const makeId = () => root.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  function normalizeTodos(value) {
    if (!Array.isArray(value)) return [];
    const ids = new Set();
    return value.filter(t => t && typeof t.text === "string" && t.text.trim()).map(t => {
      let id = typeof t.id === "string" && t.id.length <= 100 && t.id ? t.id : makeId();
      if (ids.has(id)) id = makeId();
      ids.add(id);
      return { id, text: t.text.slice(0, 60), done: Boolean(t.done) };
    });
  }
  function normalizeLedger(value) {
    const totals = Object.create(null);
    if (value?.totals && typeof value.totals === "object") for (const [id, ms] of Object.entries(value.totals)) {
      if (Number.isFinite(ms) && ms >= 0) totals[id] = ms;
    }
    return { totals, receipts: Array.isArray(value?.receipts) ? value.receipts.filter(id => typeof id === "string").slice(-256) : [] };
  }
  function creditFocus(value, run) {
    const ledger = normalizeLedger(value);
    if (!run?.id || !run.taskId || !Number.isFinite(run.ms) || run.ms <= 0 || ledger.receipts.includes(run.id)) return ledger;
    ledger.totals[run.taskId] = (ledger.totals[run.taskId] || 0) + Math.round(run.ms);
    ledger.receipts = [...ledger.receipts, run.id].slice(-256);
    return ledger;
  }
  const api = { makeId, normalizeTodos, normalizeLedger, creditFocus };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MikuPersonal = api;
})(globalThis);
