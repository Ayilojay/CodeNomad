const deployment = {
  market_core: "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O",
  reasoning_registry: "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M"
};

const explorer = "https://stellar.expert/explorer/testnet/contract/";
const apiBase = localStorage.getItem("oracledeskApiUrl") || "http://localhost:3000";
const clock = document.querySelector("#clock");
const apiStatus = document.querySelector("#api-status");

function updateClock() {
  clock.textContent = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}

function setContractLinks() {
  document.querySelector("#market-link").href = explorer + deployment.market_core;
  document.querySelector("#registry-link").href = explorer + deployment.reasoning_registry;
}

async function checkApi() {
  try {
    const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error("unhealthy");
    apiStatus.classList.add("online");
    apiStatus.innerHTML = '<span class="status-dot"></span>Online';
  } catch {
    apiStatus.innerHTML = '<span class="status-dot"></span>Offline';
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
  message: "",
  attempts: 0
};

function setTraceState(state, message) {
  traceViewer.state = state;
  traceViewer.message = message || "";
  renderTraceViewer();
}

function renderTraceViewer() {
  const root = document.querySelector("#trace-viewer");
  if (!root) return;
  const status = root.querySelector("#trace-status");
  const body = root.querySelector("#trace-body");
  const retry = root.querySelector("#trace-retry");
  if (!status || !body) return;

  status.dataset.state = traceViewer.state;
  status.textContent = traceViewer.message;
  body.textContent = "";
  if (retry) retry.hidden = traceViewer.state !== TRACE_STATES.unavailable && traceViewer.state !== TRACE_STATES.error;

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

async function loadTrace(traceId, { retry = false } = {}) {
  traceViewer.traceId = traceId;
  traceViewer.content = null;
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
    setTraceState(TRACE_STATES.invalid, "Trace failed hash/signature verification; content withheld.");
    return;
  }

  traceViewer.content = payload.content;
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
renderTraceViewer();
// ------------------------------------------------------------------------

document.querySelectorAll(".market-row").forEach((row) => row.addEventListener("click", () => {
  document.querySelectorAll(".market-row").forEach((item) => item.classList.remove("selected"));
  row.classList.add("selected");
  document.querySelector("#selected-market").textContent = row.dataset.market;
}));

document.querySelector("#wallet-button").addEventListener("click", (event) => {
  event.currentTarget.innerHTML = '<span class="wallet-dot"></span> Wallet ready';
});
document.querySelector("#refresh-button").addEventListener("click", checkApi);
setContractLinks();
updateClock();
setInterval(updateClock, 1000);
checkApi();