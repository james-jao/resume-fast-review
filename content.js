(function () {
  "use strict";

  const state = { running: false, stopRequested: false };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "START_SCORING") {
      if (state.running) return sendResponse({ ok: false, error: "評估正在進行中。" });
      runScoring(message.target, Number(message.limit) || 20);
      sendResponse({ ok: true });
    }
    if (message?.type === "STOP_SCORING") {
      state.stopRequested = true;
      sendResponse({ ok: true });
    }
  });

  function findCandidates(limit) {
    const seen = new Set();
    const found = [];
    const links = [...document.querySelectorAll('a[href*="SearchResumeMaster"]')]
      .filter((link) => FastReview.isCandidateProfileUrl(link.href));
    for (const link of links) {
      if (found.length >= limit) break;
      const card = link.closest('[data-qa-id="resumeCard"]');
      const text = FastReview.compactText(card?.innerText, 4000);
      if (!card || text.length < 40 || text.length > 10000) continue;
      const url = new URL(link.href, location.href).href.split("#")[0];
      const candidateId = FastReview.candidateIdFromUrl(url);
      if (!candidateId || seen.has(candidateId)) continue;
      seen.add(candidateId);
      found.push({ id: candidateId, url, card });
    }
    return found;
  }

  async function runScoring(target, limit) {
    state.running = true;
    state.stopRequested = false;
    const panel = getPanel();
    try {
      const candidates = findCandidates(limit);
      if (!candidates.length) throw new Error("目前畫面找不到人才卡片。請先進入人才列表，或重新整理後再試。 ");
      updatePanel(`找到 ${candidates.length} 位人才，正在讀取詳細資料…`, 0, candidates.length);
      candidates.forEach(({ card }) => renderBadge(card, { status: "loading" }));

      const profiles = [];
      for (let index = 0; index < candidates.length; index += 1) {
        if (state.stopRequested) throw new Error("已停止評估。 ");
        const candidate = candidates[index];
        const detail = await fetchProfile(candidate.url);
        const extracted = detail?.ok ? extractProfile(detail.html) : { ok: false, error: detail?.error };
        if (extracted.ok) profiles.push({ id: candidate.id, profile: extracted.text, source: "detail" });
        else renderBadge(candidate.card, { status: "error", error: extracted.error || "詳細頁無法讀取" });
        updatePanel(`讀取詳細資料 ${index + 1}/${candidates.length}`, index + 1, candidates.length);
      }

      if (!profiles.length) throw new Error("所有人才詳細頁都無法讀取；請確認登入狀態與頁面是否為人才列表。 ");

      const batchSize = 5;
      for (let start = 0; start < profiles.length; start += batchSize) {
        if (state.stopRequested) throw new Error("已停止評估。 ");
        const batch = profiles.slice(start, start + batchSize);
        updatePanel(`Jev 評估中 ${start + 1}–${Math.min(start + batch.length, profiles.length)}/${profiles.length}`, start, profiles.length);
        const response = await sendMessage({ type: "SCORE_CANDIDATES", target, candidates: batch });
        if (!response?.ok) throw new Error(response?.error || "Jev 沒有回傳結果。 ");
        response.results.forEach((result) => {
          const candidate = candidates.find((item) => item.id === result.id);
          const profile = profiles.find((item) => item.id === result.id);
          if (candidate) renderBadge(candidate.card, { ...result, source: profile?.source });
        });
      }
      updatePanel(`完成：已評估 ${profiles.length} 位人才`, profiles.length, profiles.length, true);
    } catch (error) {
      updatePanel(error.message, 0, 1, true, true);
    } finally {
      state.running = false;
      panel.querySelector("button").hidden = true;
    }
  }

  function extractProfile(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,noscript,svg,header,footer,nav").forEach((node) => node.remove());
    const main = doc.querySelector(".msc-resume-wrapper");
    if (!main) return { ok: false, error: "詳細頁找不到履歷主內容，未送出評估。" };
    const text = FastReview.compactText(main?.textContent || "");
    const loginSignals = (text.match(/登入|登錄|sign\s*in|login/gi) || []).length;
    if (text.length < 300) return { ok: false, error: "詳細頁內容不足，未送出評估。" };
    if (loginSignals >= 2) return { ok: false, error: "詳細頁疑似登入畫面，未送出評估。" };
    return { ok: true, text };
  }

  async function fetchProfile(url) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.protocol !== "https:" || parsed.hostname !== "vip.104.com.tw") {
        return { ok: false, error: "不允許讀取這個網址。" };
      }
      const response = await fetch(parsed.href, { credentials: "include", redirect: "follow" });
      if (!response.ok) return { ok: false, error: `詳細頁讀取失敗（HTTP ${response.status}）。` };
      const finalUrl = new URL(response.url);
      const finalTarget = finalUrl.pathname + finalUrl.search;
      if (finalUrl.hostname !== "vip.104.com.tw" || /login|signin|sso/i.test(finalTarget)) {
        return { ok: false, error: "詳細頁被導向登入頁，請確認 104 登入狀態。" };
      }
      if (!FastReview.isCandidateProfileUrl(finalUrl.href)) {
        return { ok: false, error: "詳細頁被導向其他 104 頁面，未送出評估。" };
      }
      if (FastReview.candidateIdFromUrl(finalUrl.href) !== FastReview.candidateIdFromUrl(parsed.href)) {
        return { ok: false, error: "詳細頁的人才識別不一致，未送出評估。" };
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) return { ok: false, error: "詳細頁沒有回傳 HTML。" };
      return { ok: true, html: await response.text() };
    } catch (error) {
      return { ok: false, error: `詳細頁讀取失敗：${error.message}` };
    }
  }

  function renderBadge(card, result) {
    let badge = card.querySelector(":scope > .fast-review-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "fast-review-badge";
      if (getComputedStyle(card).position === "static") card.style.position = "relative";
      card.appendChild(badge);
    }
    if (result.status === "loading") {
      badge.className = "fast-review-badge is-loading";
      badge.textContent = "AI 讀取中";
      return;
    }
    if (result.status === "error") {
      badge.className = "fast-review-badge is-error";
      badge.textContent = "詳細頁失敗";
      badge.title = result.error;
      return;
    }
    const percent = result.percent;
    badge.className = `fast-review-badge ${percent >= 75 ? "is-high" : percent >= 50 ? "is-mid" : "is-low"}`;
    badge.textContent = percent == null ? "AI 無結果" : `${percent}% 契合`;
    const confidence = Number.isFinite(result.confidence) ? `${Math.round(result.confidence * 100)}%` : "未知";
    badge.title = `Jev 契合度：${percent ?? "未知"}%\n判斷信心：${confidence}\n資料來源：${result.source === "detail" ? "人才詳細頁" : "列表摘要（詳細頁讀取失敗）"}`;
  }

  function getPanel() {
    let panel = document.querySelector(".fast-review-panel");
    if (panel) return panel;
    panel = document.createElement("aside");
    panel.className = "fast-review-panel";
    panel.innerHTML = '<strong>104 人才快速媒合</strong><span>準備中…</span><progress max="1" value="0"></progress><button type="button">停止</button>';
    panel.querySelector("button").addEventListener("click", () => { state.stopRequested = true; });
    document.body.appendChild(panel);
    return panel;
  }

  function updatePanel(message, value, max, done = false, error = false) {
    const panel = getPanel();
    panel.classList.toggle("is-error", error);
    panel.classList.toggle("is-done", done && !error);
    panel.querySelector("span").textContent = message;
    const progress = panel.querySelector("progress");
    progress.max = Math.max(1, max);
    progress.value = value;
    panel.querySelector("button").hidden = done;
  }

  function sendMessage(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
  }
})();
