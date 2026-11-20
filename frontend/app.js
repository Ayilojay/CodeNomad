const deployment = {
  market_core: "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O",
  reasoning_registry: "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M"
};

const explorer = "https://stellar.expert/explorer/testnet/contract/";
const apiBase = localStorage.getItem("oracledeskApiUrl") || "http://localhost:3000";
const clock = document.querySelector("#clock");
const apiStatus = document.querySelector("#api-status");

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
  networkSelect.addEventListener("change", (event) => {
    applyNetwork(event.currentTarget.value);
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
      setTxState("pending", "Simulation passed. Awaiting signature…");
      const result = await submitTrade(quote, network);
      setTxState("success", `Submitted: ${result.hash}`);
    } catch (error) {
      setTxState("failure", error.message || "Transaction failed.");
    }
  });
}

applyNetwork(networkSelect?.value || localStorage.getItem("oracledeskNetwork") || "testnet");
updateClock();
setInterval(updateClock, 1000);
checkApi();