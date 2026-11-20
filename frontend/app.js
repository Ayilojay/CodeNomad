const deployment = {
  market_core: "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O",
  reasoning_registry: "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M"
};

const explorer = "https://stellar.expert/explorer/testnet/contract/";
const apiBase = localStorage.getItem("oracledeskApiUrl") || "http://localhost:3000";
const expectedNetwork = "TESTNET";
const clock = document.querySelector("#clock");
const apiStatus = document.querySelector("#api-status");
const walletButton = document.querySelector("#wallet-button");
const walletStatus = document.querySelector("#wallet-status");

let walletState = { connected: false, publicKey: null, network: null };

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

function shortenKey(key) {
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function renderWallet() {
  if (!walletState.connected) {
    walletButton.innerHTML = '<span class="wallet-dot"></span> Connect wallet';
    if (walletStatus) walletStatus.textContent = "No wallet connected";
    return;
  }
  walletButton.innerHTML = `<span class="wallet-dot"></span> ${shortenKey(walletState.publicKey)}`;
  if (walletStatus) {
    walletStatus.textContent = `Connected: ${walletState.publicKey} · Network: ${walletState.network}`;
  }
}

function resetWallet() {
  walletState = { connected: false, publicKey: null, network: null };
  renderWallet();
}

function showWalletError(message) {
  resetWallet();
  if (walletStatus) walletStatus.textContent = message;
}

async function connectWallet() {
  const freighter = window.freighterApi;
  if (!freighter) {
    showWalletError("Wallet unavailable: install a supported Stellar wallet (Freighter).");
    return;
  }
  try {
    const allowed = await freighter.isAllowed();
    if (!allowed) {
      const granted = await freighter.setAllowed();
      if (!granted) {
        showWalletError("Wallet access was not granted.");
        return;
      }
    }
    const publicKey = await freighter.getPublicKey();
    if (!publicKey) {
      showWalletError("Wallet did not return a public key.");
      return;
    }
    const network = await freighter.getNetwork();
    if (network !== expectedNetwork) {
      showWalletError(`Network mismatch: wallet is on ${network}, expected ${expectedNetwork}.`);
      return;
    }
    walletState = { connected: true, publicKey, network };
    renderWallet();
  } catch (error) {
    showWalletError(`Wallet connection failed: ${error.message || error}`);
  }
}

async function disconnectWallet() {
  try {
    if (window.freighterApi && window.freighterApi.disconnect) {
      await window.freighterApi.disconnect();
    }
  } catch {
    // Ignore disconnect errors; local state is reset regardless.
  }
  resetWallet();
}

document.querySelectorAll(".market-row").forEach((row) => row.addEventListener("click", () => {
  document.querySelectorAll(".market-row").forEach((item) => item.classList.remove("selected"));
  row.classList.add("selected");
  document.querySelector("#selected-market").textContent = row.dataset.market;
}));

walletButton.addEventListener("click", () => {
  if (walletState.connected) {
    disconnectWallet();
  } else {
    connectWallet();
  }
});
document.querySelector("#refresh-button").addEventListener("click", checkApi);
setContractLinks();
renderWallet();
updateClock();
setInterval(updateClock, 1000);
checkApi();