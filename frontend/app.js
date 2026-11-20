const deployment = {
  market_core: "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O",
  reasoning_registry: "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M"
};

const explorer = "https://stellar.expert/explorer/testnet/contract/";
const apiBase = localStorage.getItem("oracledeskApiUrl") || "http://localhost:3000";
const clock = document.querySelector("#clock");
const apiStatus = document.querySelector("#api-status");
const selectedMarket = document.querySelector("#selected-market");
const marketRows = Array.from(document.querySelectorAll(".market-row"));

function updateClock() {
  clock.textContent = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}

function setContractLinks() {
  document.querySelector("#market-link").href = explorer + deployment.market_core;
  document.querySelector("#registry-link").href = explorer + deployment.reasoning_registry;
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

function selectMarket(row) {
  marketRows.forEach((item) => {
    const isSelected = item === row;
    item.classList.toggle("selected", isSelected);
    item.setAttribute("aria-selected", String(isSelected));
    item.tabIndex = isSelected ? 0 : -1;
  });
  selectedMarket.textContent = row.dataset.market;
  selectedMarket.setAttribute("aria-label", `Selected market: ${row.dataset.market}`);
}

marketRows.forEach((row, index) => {
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.tabIndex = index === 0 ? 0 : -1;
  row.addEventListener("click", () => selectMarket(row));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectMarket(row);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = marketRows[(marketRows.indexOf(row) + delta + marketRows.length) % marketRows.length];
      next.focus();
      selectMarket(next);
    }
  });
});

if (marketRows.length > 0) selectMarket(marketRows[0]);

document.querySelector("#wallet-button").addEventListener("click", (event) => {
  event.currentTarget.innerHTML = '<span class="wallet-dot" aria-hidden="true"></span> Wallet ready';
  event.currentTarget.setAttribute("aria-label", "Wallet ready");
});
document.querySelector("#refresh-button").addEventListener("click", checkApi);
setContractLinks();
updateClock();
setInterval(updateClock, 1000);
checkApi();