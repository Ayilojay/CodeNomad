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
const clock = document.querySelector("#clock");
const apiStatus = document.querySelector("#api-status");
const networkSelect = document.querySelector("#network-select");

// Bounds for user-supplied trade parameters. Values outside these ranges are rejected
// rather than silently clamped so the user always knows what they signed.
const SLIPPAGE_BOUNDS = { min: 0, max: 5000 }; // basis points (0% - 50%)
const DEADLINE_BOUNDS = { min: 30, max: 3600 }; // seconds

// Resolve the active network from the selector, falling back to the persisted
// choice. Returns null when the network has no validated manifest.
function getSelectedNetwork() {
  const raw = (networkSelect && networkSelect.value) || localStorage.getItem(NETWORK_STORAGE_KEY) || "local";
  return DEPLOYMENT_MANIFESTS[raw] ? raw : null;
}

function getDeployment() {
  const network = getSelectedNetwork();
  return network ? DEPLOYMENT_MANIFESTS[network] : null;
}

// Scope caches and wallet state by network so switching networks never reuses
// addresses or signatures from a different chain.
function networkScopedKey(key) {
  const network = getSelectedNetwork() || "unselected";
  return `${key}:${network}`;
}

function updateClock() {
  clock.textContent = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}

function setContractLinks() {
  const deployment = getDeployment();
  const marketLink = document.querySelector("#market-link");
  const registryLink = document.querySelector("#registry-link");
  if (!deployment) {
    marketLink.removeAttribute("href");
    registryLink.removeAttribute("href");
    return;
  }
  marketLink.href = deployment.explorer + deployment.contracts.market_core;
  registryLink.href = deployment.explorer + deployment.contracts.reasoning_registry;
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

function parseBoundedInt(raw, bounds, label) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    throw new Error(`${label} is required`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be a whole number`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new Error(`${label} must be between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

// Quote via the backend SDK helper (which wraps the generated bindings) so the
// displayed price always comes from verified on-chain state, never sample data.
async function fetchQuote({ market, amount, side }) {
  const response = await fetch(`${apiBase}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market, amount, side }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new Error(`Quote failed (${response.status})`);
  }
  const quote = await response.json();
  if (!quote || typeof quote.price !== "number" || !quote.quoteId) {
    throw new Error("Quote response was incomplete");
  }
  return quote;
}

// Simulate the transaction before requesting a signature. Any simulation failure
// blocks signing so we never ask the wallet to sign a transaction we know will fail.
async function simulateTransaction({ quoteId, slippageBps, deadlineSeconds }) {
  const response = await fetch(`${apiBase}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteId, slippageBps, deadlineSeconds }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new Error(`Simulation failed (${response.status})`);
  }
  const result = await response.json();
  if (!result || result.success !== true) {
    throw new Error(result && result.error ? result.error : "Simulation rejected the transaction");
  }
  return result;
}

function setTxState(state, message) {
  const el = document.querySelector("#tx-state");
  if (!el) return;
  el.dataset.state = state;
  el.textContent = message;
}

// Block transactions when the selected network has no validated deployment
// manifest or when the market address does not belong to that network.
function assertDeploymentMatchesNetwork(market) {
  const deployment = getDeployment();
  if (!deployment) {
    throw new Error("No validated deployment for the selected network; transactions are blocked");
  }
  const known = Object.values(deployment.contracts);
  if (market && !known.includes(market)) {
    throw new Error(`Market ${market} does not match the ${deployment.network} deployment; transactions are blocked`);
  }
  return deployment;
}

async function runTradeFlow({ market, amount, side, slippageRaw, deadlineRaw }) {
  try {
    const deployment = assertDeploymentMatchesNetwork(market);
    const slippageBps = parseBoundedInt(slippageRaw, SLIPPAGE_BOUNDS, "Slippage (bps)");
    const deadlineSeconds = parseBoundedInt(deadlineRaw, DEADLINE_BOUNDS, "Deadline (seconds)");

    setTxState("pending", "Fetching quote...");
    const quote = await fetchQuote({ market, amount, side });

    setTxState("pending", "Simulating transaction...");
    await simulateTransaction({ quoteId: quote.quoteId, slippageBps, deadlineSeconds });

    setTxState("pending", "Awaiting signature...");
    const signed = await requestSignature({ quoteId: quote.quoteId, slippageBps, deadlineSeconds, network: deployment.network });

    setTxState("pending", "Submitting transaction...");
    const submitted = await submitTransaction(signed);
    setTxState("success", `Transaction submitted: ${submitted.hash}`);
  } catch (error) {
    setTxState("failure", error.message || "Transaction failed");
  }
}

async function requestSignature(payload) {
  if (!window.freighterApi || typeof window.freighterApi.signTransaction !== "function") {
    throw new Error("Wallet not available; connect a wallet before trading");
  }
  const result = await window.freighterApi.signTransaction(payload);
  if (!result || result.error || !result.signedTxXdr) {
    throw new Error(result && result.error ? result.error : "Signature was not provided");
  }
  return result.signedTxXdr;
}

async function submitTransaction(signedTxXdr) {
  const response = await fetch(`${apiBase}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTxXdr }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    throw new Error(`Submission failed (${response.status})`);
  }
  const result = await response.json();
  if (!result || !result.hash) {
    throw new Error("Submission response was incomplete");
  }
  return result;
}

document.querySelectorAll(".market-row").forEach((row) => row.addEventListener("click", () => {
  document.querySelectorAll(".market-row").forEach((item) => item.classList.remove("selected"));
  row.classList.add("selected");
  document.querySelector("#selected-market").textContent = row.dataset.market;
}));

document.querySelector("#wallet-button").addEventListener("click", (event) => {
  event.currentTarget.innerHTML = '<span class="wallet-dot"></span> Wallet ready';
});
document.querySelector("#refresh-button").addEventListener("click", checkApi);

if (networkSelect) {
  const persisted = localStorage.getItem(NETWORK_STORAGE_KEY);
  if (persisted && DEPLOYMENT_MANIFESTS[persisted]) {
    networkSelect.value = persisted;
  }
  networkSelect.addEventListener("change", () => {
    localStorage.setItem(NETWORK_STORAGE_KEY, networkSelect.value);
    setContractLinks();
    setTxState("idle", `Network set to ${networkSelect.value}`);
  });
}

const tradeForm = document.querySelector("#trade-form");
if (tradeForm) {
  tradeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    runTradeFlow({
      market: form.dataset.market || document.querySelector("#selected-market").textContent,
      amount: form.elements.amount.value,
      side: form.elements.side.value,
      slippageRaw: form.elements.slippage.value,
      deadlineRaw: form.elements.deadline.value
    });
  });
}

setContractLinks();
updateClock();
setInterval(updateClock, 1000);
checkApi();