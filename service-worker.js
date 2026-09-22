importScripts("lib.js");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SCORE_CANDIDATES") {
    scoreCandidates(message.target, message.candidates).then(sendResponse);
    return true;
  }
  if (message?.type === "FETCH_PROFILE") {
    fetchProfileInPage(message.url, _sender.tab?.id).then(sendResponse);
    return true;
  }
});

async function fetchProfileInPage(profileUrl, tabId) {
  const apiUrl = FastReview.candidateProfileApiUrl(profileUrl);
  if (!apiUrl || !Number.isInteger(tabId)) return { ok: false, error: "不允許讀取這個網址。" };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (url) => {
        try {
          const response = await fetch(url, { credentials: "include", redirect: "error" });
          const contentType = response.headers.get("content-type") || "";
          return {
            ok: response.ok,
            status: response.status,
            contentType,
            finalUrl: response.url,
            body: response.ok && contentType.includes("application/json") ? await response.json() : null
          };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      },
      args: [apiUrl]
    });
    if (!result?.ok) {
      if (result?.status === 401 || result?.status === 403) return { ok: false, error: "履歷 API 拒絕存取，請確認 104 登入狀態。" };
      const detail = result?.status ? `（HTTP ${result.status}）` : `：${result?.error || "未知錯誤"}`;
      return { ok: false, error: `履歷 API 讀取失敗${detail}。` };
    }
    const finalUrl = new URL(result.finalUrl);
    if (finalUrl.hostname !== "auth.vip.104.com.tw" || !finalUrl.pathname.startsWith("/vipapi/resume/search/")) {
      return { ok: false, error: "履歷 API 回傳來源不正確，未送出評估。" };
    }
    if (!result.contentType.includes("application/json") || !result.body) return { ok: false, error: "履歷 API 沒有回傳 JSON。" };
    return { ok: true, body: result.body };
  } catch (error) {
    return { ok: false, error: `無法在 104 頁面讀取履歷 API：${error.message}` };
  }
}

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
