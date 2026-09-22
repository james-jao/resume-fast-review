importScripts("lib.js");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SCORE_CANDIDATES") {
    scoreCandidates(message.target, message.candidates).then(sendResponse);
    return true;
  }
});

async function scoreCandidates(target, candidates) {
  const { typesafeApiKey } = await chrome.storage.local.get("typesafeApiKey");
  if (!typesafeApiKey) return { ok: false, error: "請先在擴充功能中儲存 TypeSafe API key。" };
  if (!target?.trim()) return { ok: false, error: "請先描述你想找的人才。" };
  if (!Array.isArray(candidates) || candidates.length === 0) return { ok: false, error: "沒有可評估的人才。" };

  try {
    const payload = FastReview.buildEvaluationRequest(target, candidates);
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${typesafeApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body?.detail || body?.message || `HTTP ${response.status}`;
      return { ok: false, error: `Jev 評估失敗：${typeof detail === "string" ? detail : JSON.stringify(detail)}` };
    }
    const results = FastReview.parseScoreResults(body, candidates);
    return { ok: true, results, usage: body?.usage || null, model: body?.model || "jev-latest" };
  } catch (error) {
    return { ok: false, error: `無法連線 TypeSafe：${error.message}` };
  }
}
