(function () {
  "use strict";

  const state = { running: false, stopRequested: false, scoreCache: {}, target: "" };

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

  function findCandidates(limit, target) {
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
      const cached = FastReview.cachedScoreForTarget(state.scoreCache[candidateId], target);
      if (cached) {
        renderBadge(card, cached);
        continue;
      }
      found.push({ id: candidateId, url, card });
    }
    return found;
  }

  async function runScoring(target, limit) {
    state.running = true;
    state.stopRequested = false;
    state.target = FastReview.compactText(target, 4000);
    const panel = getPanel();
    try {
      await loadScoreCache();
      applyCachedScoresToList();
      const candidates = findCandidates(limit, state.target);
      if (!candidates.length) throw new Error("目前已載入的人才都已評估。請繼續往下捲載入更多人才後，再按一次評估。 ");
      updatePanel(`找到 ${candidates.length} 位人才，正在讀取詳細資料…`, 0, candidates.length);
      candidates.forEach(({ card }) => renderBadge(card, { status: "loading" }));

      const profiles = [];
      for (let index = 0; index < candidates.length; index += 1) {
        if (state.stopRequested) throw new Error("已停止評估。 ");
        const candidate = candidates[index];
        const detail = await fetchProfile(candidate.url);
        const extracted = detail?.ok ? FastReview.extractResumeProfile(detail.body) : { ok: false, error: detail?.error };
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
          if (candidate) {
            const savedResult = { ...result, source: profile?.source, target: state.target, savedAt: Date.now() };
            state.scoreCache[candidate.id] = savedResult;
            renderBadge(candidate.card, savedResult);
          }
        });
        await chrome.storage.local.set({ fastReviewScores: state.scoreCache });
      }
      updatePanel(`完成：已評估 ${profiles.length} 位人才`, profiles.length, profiles.length, true);
    } catch (error) {
      updatePanel(error.message, 0, 1, true, true);
    } finally {
      state.running = false;
      panel.querySelector("button").hidden = true;
    }
  }

  async function fetchProfile(url) {
    try {
      return await sendMessage({ type: "FETCH_PROFILE", url });
    } catch (error) {
      return { ok: false, error: `履歷 API 讀取失敗：${error.message}` };
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
      delete badge.dataset.scoreTarget;
      delete badge.dataset.scorePercent;
      badge.className = "fast-review-badge is-loading";
      badge.textContent = "AI 讀取中";
      return;
    }
    if (result.status === "error") {
      delete badge.dataset.scoreTarget;
      delete badge.dataset.scorePercent;
      badge.className = "fast-review-badge is-error";
      badge.textContent = "詳細頁失敗";
      badge.title = result.error;
      return;
    }
    const percent = result.percent;
    badge.dataset.scoreTarget = result.target || state.target;
    badge.dataset.scorePercent = String(percent);
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

  async function loadScoreCache() {
    const saved = await chrome.storage.local.get(["fastReviewScores", "talentTarget"]);
    state.scoreCache = saved.fastReviewScores && typeof saved.fastReviewScores === "object" ? saved.fastReviewScores : {};
    if (!state.target) state.target = FastReview.compactText(saved.talentTarget, 4000);
  }

  function applyCachedScoresToList() {
    if (!state.target) return;
    document.querySelectorAll('[data-qa-id="resumeCard"]').forEach((card) => {
      const link = card.querySelector('a[href*="SearchResumeMaster"]');
      const candidateId = link && FastReview.candidateIdFromUrl(link.href);
      const cached = candidateId && FastReview.cachedScoreForTarget(state.scoreCache[candidateId], state.target);
      const badge = card.querySelector(":scope > .fast-review-badge");
      if (cached && (badge?.dataset.scoreTarget !== cached.target || badge?.dataset.scorePercent !== String(cached.percent))) {
        renderBadge(card, cached);
      }
    });
  }

  function showDetailScore() {
    const candidateId = FastReview.candidateIdFromUrl(location.href);
    if (!candidateId || !state.target) return;
    const cached = FastReview.cachedScoreForTarget(state.scoreCache[candidateId], state.target);
    if (!cached) return;
    let panel = document.querySelector(".fast-review-detail-score");
    if (!panel) {
      panel = document.createElement("aside");
      panel.className = "fast-review-detail-score";
      document.body.appendChild(panel);
    }
    const confidence = Number.isFinite(cached.confidence) ? `${Math.round(cached.confidence * 100)}%` : "未知";
    panel.innerHTML = `<strong>AI 人才契合度</strong><span>${cached.percent}%</span><small>判斷信心：${confidence}</small>`;
    panel.classList.toggle("is-high", cached.percent >= 75);
    panel.classList.toggle("is-mid", cached.percent >= 50 && cached.percent < 75);
    panel.classList.toggle("is-low", cached.percent < 50);
  }

  loadScoreCache().then(() => {
    applyCachedScoresToList();
    showDetailScore();
    const observer = new MutationObserver(() => applyCachedScoresToList());
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
