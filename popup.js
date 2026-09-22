const targetInput = document.querySelector("#target");
const apiKeyInput = document.querySelector("#api-key");
const limitInput = document.querySelector("#limit");
const startButton = document.querySelector("#start");
const status = document.querySelector("#status");

restore();
startButton.addEventListener("click", startScoring);

async function restore() {
  const saved = await chrome.storage.local.get(["talentTarget", "typesafeApiKey", "candidateLimit"]);
  targetInput.value = saved.talentTarget || "";
  apiKeyInput.value = saved.typesafeApiKey || "";
  limitInput.value = saved.candidateLimit || 20;
}

async function startScoring() {
  setStatus("");
  const talentTarget = targetInput.value.trim();
  const typesafeApiKey = apiKeyInput.value.trim();
  const candidateLimit = Math.min(50, Math.max(1, Number(limitInput.value) || 20));
  if (!talentTarget) return setStatus("請先描述你想找的人才。", true);
  if (!typesafeApiKey) return setStatus("請先填入 TypeSafe API key。", true);

  startButton.disabled = true;
  await chrome.storage.local.set({ talentTarget, typesafeApiKey, candidateLimit });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://vip.104.com.tw/")) {
    startButton.disabled = false;
    return setStatus("請先開啟並登入 vip.104.com.tw 的人才列表。", true);
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "START_SCORING", target: talentTarget, limit: candidateLimit });
    if (!response?.ok) throw new Error(response?.error || "無法啟動評估。 ");
    setStatus("已開始。進度與結果會顯示在 104 頁面上。 ");
  } catch (_error) {
    setStatus("無法連接頁面，請重新整理 104 網頁後再試。", true);
  } finally {
    startButton.disabled = false;
  }
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}
