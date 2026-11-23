// Validated deployment manifests keyed by network. Contract/RPC configuration is
// loaded from here instead of being hardcoded, so each network resolves its own
// addresses and endpoints. Unknown networks have no manifest and are blocked.
const DEPLOYMENT_MANIFESTS = {
  local: {
    network: "local",
    explorer: "https://stellar.expert/explorer/testnet/contract/",
    rpcUrl: "http://localhost:8000/soroban/rpc",
    contracts: {
      market_core: "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O",
      reasoning_registry: "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M"
    }
  },
  testnet: {
    network: "testnet",
    explorer: "https://stellar.expert/explorer/testnet/contract/",
    rpcUrl: "https://soroban-testnet.stellar.org",
    contracts: {
      market_core: "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O",
      reasoning_registry: "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M"
    }
  }
};

const NETWORK_STORAGE_KEY = "oracledeskNetwork";
const apiBase = localStorage.getItem("oracledeskApiUrl") || "http://localhost:3000";
const expectedNetwork = "TESTNET";
const clock = document.querySelector("#clock");
const apiStatus = document.querySelector("#api-status");
const walletButton = document.querySelector("#wallet-button");
const walletStatus = document.querySelector("#wallet-status");

let walletState = { connected: false, publicKey: null, network: null };

// --- Explicit network selection (#107) ---
// Networks are declared explicitly. Only networks with a validated deployment
// manifest may transact; unknown/future networks are selectable but blocked.
const NETWORKS = {
  local: {
    label: "Local",
    explorer: "http://localhost:8000/explorer/contract/",
    manifest: {
      market_core: "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O",
      reasoning_registry: "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M"
    }
  },
  testnet: {
    label: "Testnet",
    explorer: "https://stellar.expert/explorer/testnet/contract/",
    manifest: {
      market_core: "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O",
      reasoning_registry: "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M"
    }
  },
  future: {
    label: "Future network",
    explorer: null,
    manifest: null
  }
};

const networkSelect = document.querySelector("#network-select");
const networkStatus = document.querySelector("#network-status");

function isValidManifest(manifest) {
  return Boolean(
    manifest &&
      typeof manifest.market_core === "string" &&
      manifest.market_core.length > 0 &&
      typeof manifest.reasoning_registry === "string" &&
      manifest.reasoning_registry.length > 0
  );
}

function getSelectedNetwork() {
  const key = networkSelect?.value || localStorage.getItem("oracledeskNetwork") || "testnet";
  return { key, config: NETWORKS[key] };
}

function setNetworkStatus(state, message) {
  if (!networkStatus) return;
  networkStatus.dataset.state = state;
  networkStatus.textContent = message;
}

function applyNetwork(key) {
  const config = NETWORKS[key];
  if (!config) {
    setNetworkStatus("failure", `Unknown network "${key}". Transactions blocked.`);
    return;
  }
  localStorage.setItem("oracledeskNetwork", key);
  if (!isValidManifest(config.manifest)) {
    setNetworkStatus("failure", `${config.label}: no validated deployment manifest. Transactions blocked.`);
    return;
  }
  deployment.market_core = config.manifest.market_core;
  deployment.reasoning_registry = config.manifest.reasoning_registry;
  setContractLinks();
  setNetworkStatus("ready", `${config.label}: deployment manifest loaded.`);
}

function updateClock() {
  clock.textContent = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}

function setContractLinks() {
  const { config } = getSelectedNetwork();
  const base = config?.explorer;
  const marketLink = document.querySelector("#market-link");
  const registryLink = document.querySelector("#registry-link");
  if (!base) {
    marketLink.removeAttribute("href");
    registryLink.removeAttribute("href");
    return;
  }
  marketLink.href = base + deployment.market_core;
  registryLink.href = base + deployment.reasoning_registry;
}

function setApiStatus(state) {
  apiStatus.classList.toggle("online", state === "online");
  apiStatus.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${state === "online" ? "Online" : "Offline"}`;
  apiStatus.setAttribute("aria-label", `API status: ${state === "online" ? "online" : "offline"}`);
}

async function checkApi() {
  try {
    const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error("unhealthy");
    setApiStatus("online");
  } catch {
    setApiStatus("offline");
  }
}

// --- Paid trace viewer ---------------------------------------------------
// Trace content is only rendered after the x402 payment completes AND the
// returned payload passes hash/signature verification. Each failure mode is
// surfaced as its own explicit state; we never fall back to sample data.

const TRACE_STATES = {
  idle: "idle",
  payment_required: "payment_required",
  verifying: "verifying",
  verified: "verified",
  invalid: "invalid",
  unavailable: "unavailable",
  retrying: "retrying",
  error: "error"
};

const traceViewer = {
  state: TRACE_STATES.idle,
  traceId: null,
  content: null,
  provenance: null,
  verification: null,
  message: "",
  attempts: 0
};

function setTraceState(state, message) {
  traceViewer.state = state;
  traceViewer.message = message || "";
  renderTraceViewer();
}

// Provenance fields we surface. These are descriptive metadata only; a valid
// signature proves integrity/authenticity of the payload, NOT that the
// strategy is economically sound.
const PROVENANCE_FIELDS = [
  ["registry", "Registry"],
  ["agent", "Agent"],
  ["key_identity", "Key identity"],
  ["hash", "Hash"],
  ["schema_version", "Schema version"]
];

function renderProvenance(container, provenance) {
  container.textContent = "";
  if (!provenance) return;
  const dl = document.createElement("dl");
  dl.className = "trace-provenance";
  PROVENANCE_FIELDS.forEach(([key, label]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    const value = provenance[key];
    dd.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  });
  container.appendChild(dl);
}

function renderVerification(container, verification) {
  container.textContent = "";
  if (!verification) return;
  const badge = document.createElement("span");
  badge.className = "trace-verification";
  badge.dataset.result = verification.result;
  badge.textContent = verification.result === "verified" ? "Signature verified" : "Signature verification failed";
  container.appendChild(badge);
  const note = document.createElement("p");
  note.className = "trace-verification-note";
  note.textContent = "A valid signature proves payload integrity and signer identity only; it does not imply the strategy is economically sound.";
  container.appendChild(note);
}

function renderTraceViewer() {
  const root = document.querySelector("#trace-viewer");
  if (!root) return;
  const status = root.querySelector("#trace-status");
  const body = root.querySelector("#trace-body");
  const retry = root.querySelector("#trace-retry");
  const provenanceEl = root.querySelector("#trace-provenance");
  const verificationEl = root.querySelector("#trace-verification");
  const exportBtn = root.querySelector("#trace-export");
  if (!status || !body) return;

  status.dataset.state = traceViewer.state;
  status.textContent = traceViewer.message;
  body.textContent = "";
  if (provenanceEl) renderProvenance(provenanceEl, traceViewer.provenance);
  if (verificationEl) renderVerification(verificationEl, traceViewer.verification);
  if (retry) retry.hidden = traceViewer.state !== TRACE_STATES.unavailable && traceViewer.state !== TRACE_STATES.error;
  if (exportBtn) exportBtn.hidden = traceViewer.state !== TRACE_STATES.verified;

  if (traceViewer.state === TRACE_STATES.verified && traceViewer.content) {
    const pre = document.createElement("pre");
    pre.className = "trace-content";
    pre.textContent = JSON.stringify(traceViewer.content, null, 2);
    body.appendChild(pre);
  }
}

// Deterministic verification: recompute the SHA-256 of the canonical trace
// payload and compare it to the hash the server signed. A mismatch means the
// content is invalid and must not be displayed.
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTrace(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!payload.content || !payload.hash) return false;
  const canonical = typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content);
  const expected = await sha256Hex(canonical);
  return expected === payload.hash;
}

// Build an offline-verifiable evidence bundle: the raw payload plus the
// provenance and verification result, so an operator can re-check the hash
// and signature without trusting this UI.
function buildEvidenceExport() {
  return {
    trace_id: traceViewer.traceId,
    exported_at: new Date().toISOString(),
    provenance: traceViewer.provenance,
    verification: traceViewer.verification,
    content: traceViewer.content
  };
}

function exportEvidence() {
  if (traceViewer.state !== TRACE_STATES.verified) return;
  const blob = new Blob([JSON.stringify(buildEvidenceExport(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `trace-evidence-${traceViewer.traceId || "unknown"}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadTrace(traceId, { retry = false } = {}) {
  traceViewer.traceId = traceId;
  traceViewer.content = null;
  traceViewer.provenance = null;
  traceViewer.verification = null;
  traceViewer.attempts = retry ? traceViewer.attempts + 1 : 0;
  if (retry) setTraceState(TRACE_STATES.retrying, `Retrying trace fetch (attempt ${traceViewer.attempts + 1})…`);
  else setTraceState(TRACE_STATES.idle, "Requesting trace…");

  let response;
  try {
    response = await fetch(`${apiBase}/traces/${encodeURIComponent(traceId)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    setTraceState(TRACE_STATES.unavailable, "Trace service unavailable. Retry when the API is reachable.");
    return;
  }

  if (response.status === 402) {
    setTraceState(TRACE_STATES.payment_required, "Payment required (x402). Complete payment to view this trace.");
    return;
  }
  if (response.status === 404) {
    setTraceState(TRACE_STATES.unavailable, "Trace not found or not yet available.");
    return;
  }
  if (!response.ok) {
    setTraceState(TRACE_STATES.error, `Trace request failed (HTTP ${response.status}).`);
    return;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    setTraceState(TRACE_STATES.invalid, "Trace response could not be parsed; content withheld.");
    return;
  }

  setTraceState(TRACE_STATES.verifying, "Verifying trace hash and signature…");
  let ok = false;
  try {
    ok = await verifyTrace(payload);
  } catch {
    ok = false;
  }
  if (!ok) {
    traceViewer.provenance = payload && payload.provenance ? payload.provenance : null;
    traceViewer.verification = { result: "failed" };
    setTraceState(TRACE_STATES.invalid, "Trace failed hash/signature verification; content withheld.");
    return;
  }

  traceViewer.content = payload.content;
  traceViewer.provenance = payload.provenance || null;
  traceViewer.verification = { result: "verified" };
  setTraceState(TRACE_STATES.verified, "Verified trace content.");
}

const traceForm = document.querySelector("#trace-form");
if (traceForm) {
  traceForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = traceForm.querySelector("#trace-id");
    const traceId = input && input.value.trim();
    if (!traceId) return;
    loadTrace(traceId);
  });
}
const traceRetry = document.querySelector("#trace-retry");
if (traceRetry) {
  traceRetry.addEventListener("click", () => {
    if (traceViewer.traceId) loadTrace(traceViewer.traceId, { retry: true });
  });
}
const traceExport = document.querySelector("#trace-export");
if (traceExport) {
  traceExport.addEventListener("click", exportEvidence);
}
renderTraceViewer();
// ------------------------------------------------------------------------

// --- Live market loading (#101) -----------------------------------------
// All market rows come from the indexer/read API. Fixture rows are never
// rendered as live data. The function surfaces four explicit states:
//   loading  — request in flight
//   loaded   — rows rendered from indexer response
//   empty    — indexer returned an empty list
//   stale    — indexer responded but ledger freshness metadata is stale
//   error    — network or parse failure, with a retry affordance
// Never falls back to hardcoded data after any failure state.

const MARKET_LIST_STATES = {
  loading: "loading",
  loaded: "loaded",
  empty: "empty",
  stale: "stale",
  error: "error"
};

// Age threshold (ms) beyond which we treat the indexed data as stale.
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

const marketList = document.querySelector("#market-list");
const marketListStatus = document.querySelector("#market-list-status");
const marketListMessage = document.querySelector("#market-list-message");
const marketListRetry = document.querySelector("#market-list-retry");
const ledgerFreshness = document.querySelector("#ledger-freshness");
const ledgerSequenceEl = document.querySelector("#ledger-sequence");
const ledgerIndexedAtEl = document.querySelector("#ledger-indexed-at");
const ledgerStalenessEl = document.querySelector("#ledger-staleness");

function setMarketListState(state, message) {
  if (marketListStatus) {
    marketListStatus.dataset.state = state;
  }
  if (marketListMessage) {
    marketListMessage.textContent = message || "";
  }
  if (marketListRetry) {
    marketListRetry.hidden = state !== MARKET_LIST_STATES.error && state !== MARKET_LIST_STATES.stale;
  }
}

function iconForMarket(market) {
  const change = typeof market.change === "number" ? market.change : 0;
  if (change > 0) return { symbol: "↑", cssClass: "coral" };
  if (change < 0) return { symbol: "↓", cssClass: "green" };
  return { symbol: "=", cssClass: "gold" };
}

function formatTimeToClose(closeTime) {
  if (closeTime == null) return "Unknown close time";
  const ms = new Date(closeTime).getTime() - Date.now();
  if (Number.isNaN(ms)) return "Unknown close time";
  if (ms <= 0) return "Closed";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  return `Closes in ${days}d ${String(hours).padStart(2, "0")}h`;
}

function formatPriceCents(price) {
  if (price == null || !Number.isFinite(price)) return "—";
  return `${Math.round(price * 100)}¢`;
}

function formatChangePct(change) {
  if (change == null || !Number.isFinite(change)) return "";
  const sign = change >= 0 ? "+" : "−";
  return `${sign}${Math.abs(change).toFixed(1)}%`;
}

function buildMarketRow(market) {
  const { symbol, cssClass } = iconForMarket(market);
  const timeLabel = formatTimeToClose(market.closeTime);
  const indexLabel = market.index != null ? `#${String(market.index).padStart(4, "0")}` : "";
  const priceCents = formatPriceCents(market.yesPrice);
  const changePct = formatChangePct(market.change);
  const changeClass = market.change >= 0 ? "positive" : "negative";

  const button = document.createElement("button");
  button.className = "market-row";
  button.type = "button";
  button.dataset.market = market.id;
  button.dataset.marketTitle = market.title;
  button.setAttribute("aria-pressed", "false");
  button.setAttribute(
    "aria-label",
    `${market.title}${timeLabel ? ", " + timeLabel : ""}${indexLabel ? ", market " + indexLabel : ""}${priceCents !== "—" ? ", YES price " + priceCents : ""}`
  );

  const icon = document.createElement("span");
  icon.className = `market-icon ${cssClass}`;
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = symbol;

  const copy = document.createElement("span");
  copy.className = "market-copy";
  copy.innerHTML = `<strong>${escapeHtml(market.title)}</strong><small>${escapeHtml(timeLabel)}${indexLabel ? " · " + escapeHtml(indexLabel) : ""}</small>`;

  const priceEl = document.createElement("span");
  priceEl.className = "market-price";
  priceEl.innerHTML = `<strong>${escapeHtml(priceCents)}</strong><small>YES${changePct ? ` <span class="${changeClass}">${escapeHtml(changePct)}</span>` : ""}</small>`;

  button.append(icon, copy, priceEl);

  button.addEventListener("click", () => {
    document.querySelectorAll(".market-row").forEach((item) => {
      item.classList.remove("selected");
      item.setAttribute("aria-pressed", "false");
    });
    button.classList.add("selected");
    button.setAttribute("aria-pressed", "true");
    const selectedMarketEl = document.querySelector("#selected-market");
    if (selectedMarketEl) selectedMarketEl.textContent = market.title;
    const chartChangeEl = document.querySelector("#chart-change");
    if (chartChangeEl) {
      chartChangeEl.textContent = changePct;
      chartChangeEl.className = `chart-change ${market.change >= 0 ? "positive" : "negative"}`;
    }
    loadLifecycle(market.id);
  });

  return button;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderLedgerFreshness(meta) {
  if (!ledgerFreshness) return;
  if (!meta) {
    ledgerFreshness.hidden = true;
    return;
  }
  ledgerFreshness.hidden = false;
  if (ledgerSequenceEl) ledgerSequenceEl.textContent = meta.ledgerSequence != null ? String(meta.ledgerSequence) : "—";
  if (ledgerIndexedAtEl) {
    const ts = meta.indexedAt ? new Intl.DateTimeFormat([], { timeStyle: "medium" }).format(new Date(meta.indexedAt)) : "—";
    ledgerIndexedAtEl.textContent = ts;
  }
  if (ledgerStalenessEl) {
    const ageMs = meta.indexedAt ? Date.now() - new Date(meta.indexedAt).getTime() : Infinity;
    if (ageMs > STALE_THRESHOLD_MS) {
      ledgerStalenessEl.textContent = "Stale — data may not reflect current chain state";
      ledgerStalenessEl.dataset.state = "stale";
    } else {
      ledgerStalenessEl.textContent = "Fresh";
      ledgerStalenessEl.dataset.state = "fresh";
    }
  }
}

function renderMarketRows(markets) {
  if (!marketList) return;
  marketList.replaceChildren();
  for (const market of markets) {
    marketList.append(buildMarketRow(market));
  }
  // Auto-select the first row so the chart panel always has a market.
  const first = marketList.querySelector(".market-row");
  if (first) first.click();
}

async function loadMarkets({ retry = false } = {}) {
  const { key: network, config } = getSelectedNetwork();
  if (!config || !isValidManifest(config.manifest)) {
    setMarketListState(MARKET_LIST_STATES.error, "Selected network has no validated deployment manifest. Market data unavailable.");
    return;
  }

  setMarketListState(MARKET_LIST_STATES.loading, retry ? "Retrying market load…" : "Loading markets…");
  if (marketList) marketList.replaceChildren();

  let response;
  try {
    response = await fetch(`${apiBase}/markets?network=${encodeURIComponent(network)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    setMarketListState(MARKET_LIST_STATES.error, "Market indexer unavailable. Retry when the API is reachable.");
    return;
  }

  if (!response.ok) {
    setMarketListState(MARKET_LIST_STATES.error, `Market indexer returned an error (HTTP ${response.status}). Retry to reload.`);
    return;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    setMarketListState(MARKET_LIST_STATES.error, "Market response could not be parsed. No market data displayed.");
    return;
  }

  // The API must return { markets: [...], meta: { ledgerSequence, indexedAt } }.
  // Any other shape is an error; we never infer or fill missing fields.
  if (!body || !Array.isArray(body.markets)) {
    setMarketListState(MARKET_LIST_STATES.error, "Market response has unexpected shape. No market data displayed.");
    return;
  }

  const { markets, meta } = body;
  renderLedgerFreshness(meta || null);

  // Stale check: if freshness metadata is present and stale, surface a warning
  // but still render the rows so the operator can see what was last indexed.
  const ageMs = meta?.indexedAt ? Date.now() - new Date(meta.indexedAt).getTime() : 0;
  const isStale = ageMs > STALE_THRESHOLD_MS;

  if (markets.length === 0) {
    setMarketListState(MARKET_LIST_STATES.empty, "No markets indexed on this network yet.");
    return;
  }

  renderMarketRows(markets);

  if (isStale) {
    setMarketListState(
      MARKET_LIST_STATES.stale,
      `Market data is stale (indexed ${Math.floor(ageMs / 60000)} min ago). Retry to reload.`
    );
  } else {
    setMarketListState(MARKET_LIST_STATES.loaded, `${markets.length} market${markets.length === 1 ? "" : "s"} loaded.`);
  }
}

if (marketListRetry) {
  marketListRetry.addEventListener("click", () => loadMarkets({ retry: true }));
}

walletButton.addEventListener("click", () => {
  if (walletState.connected) {
    disconnectWallet();
  } else {
    connectWallet();
  }
});
document.querySelector("#refresh-button").addEventListener("click", () => {
  checkApi();
  loadMarkets({ retry: true });
});

if (networkSelect) {
  networkSelect.addEventListener("change", (event) => {
    applyNetwork(event.currentTarget.value);
    loadMarkets();
  });
}

// --- Safe quote / slippage / deadline transaction flow (#103) ---
// All values come from the API (generated bindings/SDK helpers on the backend).
// Nothing here is hardcoded or sample data; failures surface explicitly.

const txStatus = document.querySelector("#tx-status");
const tradeForm = document.querySelector("#trade-form");

function setTxState(state, message) {
  if (!txStatus) return;
  txStatus.dataset.state = state;
  txStatus.textContent = message;
}

function parseBounds(form) {
  const slippage = Number(form.elements.slippage?.value);
  const deadline = Number(form.elements.deadline?.value);
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 50) {
    throw new Error("Slippage must be an explicit value between 0 and 50 bps.");
  }
  if (!Number.isFinite(deadline) || deadline <= 0) {
    throw new Error("Deadline must be an explicit positive number of seconds.");
  }
  return { slippageBps: Math.round(slippage), deadlineSeconds: Math.round(deadline) };
}

async function requestQuote({ market, side, amount, slippageBps, deadlineSeconds, network }) {
  const response = await fetch(`${apiBase}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ market, side, amount, slippageBps, deadlineSeconds, network }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Quote failed (${response.status}).`);
  const quote = await response.json();
  if (!quote || quote.amountOut == null || !quote.quoteId) {
    throw new Error("Quote response missing required fields.");
  }
  return quote;
}

async function simulateTrade(quote, network) {
  const response = await fetch(`${apiBase}/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteId: quote.quoteId, network }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Simulation failed (${response.status}).`);
  const result = await response.json();
  if (!result || result.success !== true) {
    throw new Error(result?.error || "Simulation rejected the transaction.");
  }
  return result;
}

async function submitTrade(quote, network) {
  const response = await fetch(`${apiBase}/trade`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteId: quote.quoteId, network }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Transaction failed (${response.status}).`);
  const result = await response.json();
  if (!result || !result.hash) throw new Error("Transaction response missing hash.");
  return result;
}

if (tradeForm) {
  tradeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { key: network, config } = getSelectedNetwork();
    if (!config || !isValidManifest(config.manifest)) {
      setTxState("failure", "Selected network has no validated deployment manifest. Transactions blocked.");
      return;
    }
    const market = document.querySelector("#selected-market")?.textContent;
    const side = form.elements.side?.value;
    const amount = Number(form.elements.amount?.value);
    if (!market || !side || !Number.isFinite(amount) || amount <= 0) {
      setTxState("failure", "Select a market and enter a positive amount.");
      return;
    }
    try {
      const bounds = parseBounds(form);
      setTxState("pending", "Requesting quote…");
      const quote = await requestQuote({ market, side, amount, ...bounds, network });
      setTxState("pending", `Quoted ${quote.amountOut}. Simulating…`);
      await simulateTrade(quote, network);
      setTxState("pending", "Submitting transaction…");
      const result = await submitTrade(quote, network);
      setTxState("success", `Submitted: ${result.hash}`);
    } catch (error) {
      setTxState("failure", error.message || "Transaction failed.");
    }
  });
}

// --- Market lifecycle & resolution evidence panel (#113) ---
// Every field is sourced from the indexer/chain via the API. No sample data is
// rendered as live; missing or unverifiable fields surface explicit failures.

const lifecyclePanel = document.querySelector("#lifecycle-panel");
const lifecycleStatus = document.querySelector("#lifecycle-status");

function setLifecycleState(state, message) {
  if (!lifecycleStatus) return;
  lifecycleStatus.dataset.state = state;
  lifecycleStatus.textContent = message;
}

function formatTimestamp(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function renderEvidenceLinks(container, evidence) {
  container.replaceChildren();
  if (!Array.isArray(evidence) || evidence.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No evidence links provided.";
    container.append(empty);
    return;
  }
  for (const item of evidence) {
    if (!item || typeof item.url !== "string" || !/^https?:\/\//.test(item.url)) {
      const invalid = document.createElement("li");
      invalid.textContent = "Unverifiable evidence entry omitted.";
      container.append(invalid);
      continue;
    }
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = item.url;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.textContent = item.label || item.url;
    li.append(link);
    container.append(li);
  }
}

function renderLifecycle(data) {
  if (!lifecyclePanel) return;
  const fields = {
    "lifecycle-close-time": formatTimestamp(data.closeTime),
    "lifecycle-rule": data.resolutionRule ?? null,
    "lifecycle-rule-version": data.resolutionRuleVersion ?? null,
    "lifecycle-proposal": data.proposal ?? null,
    "lifecycle-dispute-deadline": formatTimestamp(data.disputeDeadline),
    "lifecycle-fallback-time": formatTimestamp(data.fallbackTime),
    "lifecycle-outcome": data.finalOutcome ?? null
  };
  for (const [id, value] of Object.entries(fields)) {
    const el = document.querySelector(`#${id}`);
    if (!el) continue;
    el.textContent = value == null ? "Unavailable" : String(value);
    el.dataset.missing = value == null ? "true" : "false";
  }
  const evidenceList = document.querySelector("#lifecycle-evidence");
  if (evidenceList) renderEvidenceLinks(evidenceList, data.evidence);
}

async function loadLifecycle(market) {
  if (!lifecyclePanel) return;
  if (!market) {
    setLifecycleState("failure", "No market selected.");
    return;
  }
  const { key: network, config } = getSelectedNetwork();
  if (!config || !isValidManifest(config.manifest)) {
    setLifecycleState("failure", "Selected network has no validated deployment manifest. Lifecycle data unavailable.");
    return;
  }
  setLifecycleState("pending", "Loading lifecycle evidence…");
  try {
    const response = await fetch(
      `${apiBase}/markets/${encodeURIComponent(market)}/lifecycle?network=${encodeURIComponent(network)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) throw new Error(`Lifecycle request failed (${response.status}).`);
    const data = await response.json();
    if (!data || data.verified !== true) {
      throw new Error("Lifecycle data could not be verified against chain/indexer state.");
    }
    renderLifecycle(data);
    setLifecycleState("ready", "Lifecycle evidence verified.");
  } catch (error) {
    setLifecycleState("failure", error.message || "Failed to load lifecycle evidence.");
  }
}

updateClock();
setInterval(updateClock, 1000);
checkApi();
applyNetwork(getSelectedNetwork().key);
loadMarkets();
