(function () {
  "use strict";

  const state = { running: false, stopRequested: false, scoreCache: {}, target: "", refreshTimer: null };
  state.invitations = { records: [] };

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
    const detailCandidateId = FastReview.candidateIdFromUrl(location.href);
    if (detailCandidateId) {
      const candidate = FastReview.uncachedDetailCandidate(location.href, state.scoreCache, target);
      if (candidate) found.push(candidate);
      return found;
    }
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
      const cacheKey = FastReview.scoreCacheKey(candidateId, target);
      const cached = FastReview.cachedScoreForTarget(state.scoreCache[cacheKey], target);
      if (cached) {
        renderBadge(card, cached);
        continue;
      }
      found.push({ id: candidateId, url, card });
    }
    return found;
  }

  async function runScoring(target, limit) {
    const runTarget = FastReview.compactText(target, 4000);
    state.running = true;
    state.stopRequested = false;
    state.target = runTarget;
    const panel = getPanel();
    try {
      await loadScoreCache();
      clearStaleBadges();
      applyCachedScoresToList();
      const candidates = findCandidates(limit, runTarget);
      if (!candidates.length) {
        if (FastReview.candidateIdFromUrl(location.href)) {
          showDetailScore();
          panel.remove();
          return;
        }
        throw new Error("目前已載入的人才都已評估。請繼續往下捲載入更多人才後，再按一次評估。 ");
      }
      updatePanel(`找到 ${candidates.length} 位人才，正在讀取詳細資料…`, 0, candidates.length);
      candidates.forEach(({ card }) => { if (card) renderBadge(card, { status: "loading", target: runTarget }); });

      const profiles = [];
      for (let index = 0; index < candidates.length; index += 1) {
        if (state.stopRequested) throw new Error("已停止評估。 ");
        const candidate = candidates[index];
        const detail = await fetchProfile(candidate.url);
        const extracted = detail?.ok ? FastReview.extractResumeProfile(detail.body) : { ok: false, error: detail?.error };
        if (extracted.ok) profiles.push({ id: candidate.id, profile: extracted.text, source: "detail" });
        else if (candidate.card && state.target === runTarget) renderBadge(candidate.card, { status: "error", target: runTarget, error: extracted.error || "詳細頁無法讀取" });
        updatePanel(`讀取詳細資料 ${index + 1}/${candidates.length}`, index + 1, candidates.length);
      }

      if (!profiles.length) throw new Error("所有人才詳細頁都無法讀取；請確認登入狀態與頁面是否為人才列表。 ");

      const batchSize = 5;
      for (let start = 0; start < profiles.length; start += batchSize) {
        if (state.stopRequested) throw new Error("已停止評估。 ");
        const batch = profiles.slice(start, start + batchSize);
        updatePanel(`Jev 評估中 ${start + 1}–${Math.min(start + batch.length, profiles.length)}/${profiles.length}`, start, profiles.length);
        const response = await sendMessage({ type: "SCORE_CANDIDATES", target: runTarget, candidates: batch });
        if (!response?.ok) throw new Error(response?.error || "Jev 沒有回傳結果。 ");
        const batchUpdates = {};
        response.results.forEach((result) => {
          const candidate = candidates.find((item) => item.id === result.id);
          const profile = profiles.find((item) => item.id === result.id);
          if (candidate) {
            const savedResult = { ...result, source: profile?.source, target: runTarget, savedAt: Date.now() };
            const cacheKey = FastReview.scoreCacheKey(candidate.id, runTarget);
            state.scoreCache[cacheKey] = savedResult;
            batchUpdates[cacheKey] = savedResult;
            if (candidate.card && state.target === runTarget) renderBadge(candidate.card, savedResult);
          }
        });
        const merged = await sendMessage({ type: "MERGE_SCORE_CACHE", updates: batchUpdates });
        if (!merged?.ok) throw new Error(merged?.error || "無法儲存契合度結果。");
        state.scoreCache = merged.scores;
        if (FastReview.candidateIdFromUrl(location.href)) showDetailScore();
      }
      if (FastReview.candidateIdFromUrl(location.href)) {
        showDetailScore();
        panel.remove();
      } else {
        updatePanel(`完成：已評估 ${profiles.length} 位人才`, profiles.length, profiles.length, true);
      }
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
      badge.dataset.scoreTarget = result.target || state.target;
      delete badge.dataset.scorePercent;
      badge.className = "fast-review-badge is-loading";
      badge.textContent = "AI 讀取中";
      return;
    }
    if (result.status === "error") {
      badge.dataset.scoreTarget = result.target || state.target;
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
      const cacheKey = candidateId && FastReview.scoreCacheKey(candidateId, state.target);
      const cached = cacheKey && FastReview.cachedScoreForTarget(state.scoreCache[cacheKey], state.target);
      const badge = card.querySelector(":scope > .fast-review-badge");
      if (cached && (badge?.dataset.scoreTarget !== cached.target || badge?.dataset.scorePercent !== String(cached.percent))) {
        renderBadge(card, cached);
      }
    });
  }

  function clearStaleBadges() {
    document.querySelectorAll('[data-qa-id="resumeCard"] > .fast-review-badge[data-score-target]').forEach((badge) => {
      if (badge.dataset.scoreTarget !== state.target) badge.remove();
    });
  }

  function scheduleListRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      clearStaleBadges();
      applyCachedScoresToList();
      applyInvitations();
    }, 120);
  }

  function candidateNameFromCard(card) {
    const link = card.querySelector('[data-qa-id="cardBasicData"] a.name[href*="SearchResumeMaster"]');
    return link && FastReview.isCandidateProfileUrl(link.href) ? link.textContent.trim() : "";
  }

  function renderInvitation(container, name, detail = false) {
    const match = Invitations.matchName(name, state.invitations.records);
    const className = detail ? "fast-review-detail-invitation" : "fast-review-invitation";
    let badge = container.querySelector(`:scope > .${className}`);
    if (!match.records.length) { badge?.remove(); return; }
    const stale = Boolean(state.invitations.error) || Date.now() - state.invitations.syncedAt > Invitations.MAX_AGE_MS;
    const signature = JSON.stringify([name, match, state.invitations.syncedAt, stale]);
    if (badge?.dataset.signature === signature) return;
    if (!badge) {
      badge = document.createElement("a");
      badge.className = className;
      badge.target = "_blank";
      badge.rel = "noopener noreferrer";
      container.appendChild(badge);
    }
    badge.dataset.signature = signature;
    badge.classList.toggle("is-uncertain", match.kind === "masked" || match.records.length > 1);
    badge.classList.toggle("is-stale", stale);
    const label = match.kind === "masked" ? "疑似邀約紀錄" : "同名邀約紀錄";
    const statuses = [...new Set(match.records.map(Invitations.recordStatus))].join(" ／ ");
    badge.textContent = `${label}${match.records.length > 1 ? `（${match.records.length} 筆）` : ""}：${statuses}${stale ? "（舊資料）" : ""}`;
    badge.href = Invitations.recordLink(match.records[0]);
    const timestamp = state.invitations.syncedAt ? new Date(state.invitations.syncedAt).toLocaleString("zh-TW") : "未同步";
    badge.title = [
      "僅依姓名比對，請確認為同一位人選。點擊開啟邀約表。",
      ...match.records.map((record) => `第 ${record.row} 列｜${record.name}｜${Invitations.recordStatus(record)}｜發信：${record.invitedAt || "未填"}｜HR更新：${record.updatedAt || "未填"}｜一面：${record.firstDate || "未填"}｜二面：${record.secondDate || "未填"}`),
      `表格同步：${timestamp}${stale ? "；資料可能已更新，請在擴充功能同步" : ""}`
    ].join("\n");
  }

  function applyInvitations() {
    document.querySelectorAll('[data-qa-id="resumeCard"]').forEach((card) => {
      const container = card.querySelector('[data-qa-id="cardBasicData"]')?.parentElement;
      if (container) renderInvitation(container, candidateNameFromCard(card));
      else card.querySelector(".fast-review-invitation")?.remove();
    });
    const id = FastReview.candidateIdFromUrl(location.href);
    if (!id) {
      document.querySelector(".fast-review-detail-invitation")?.remove();
      return;
    }
    const nameElement = [...document.querySelectorAll("h2 > p.name")].find((element) => {
      return element.parentElement.querySelector(".code .copy-content")?.textContent.trim() === id;
    });
    renderInvitation(document.body, nameElement?.textContent.trim() || "", true);
  }

  async function refreshInvitations() {
    const result = await sendMessage({ type: "SYNC_INVITATIONS" });
    if (result?.data) state.invitations = result.data;
    applyInvitations();
  }

  function showDetailScore() {
    const candidateId = FastReview.candidateIdFromUrl(location.href);
    const existing = document.querySelector(".fast-review-detail-score");
    if (!candidateId || !state.target) {
      existing?.remove();
      return;
    }
    const cacheKey = FastReview.scoreCacheKey(candidateId, state.target);
    const cached = FastReview.cachedScoreForTarget(state.scoreCache[cacheKey], state.target);
    if (!cached) {
      existing?.remove();
      return;
    }
    let panel = existing;
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
    const observer = new MutationObserver(scheduleListRefresh);
    observer.observe(document.body, { childList: true, subtree: true });
  });
  chrome.storage.local.get("fastReviewInvitations").then((saved) => {
    if (saved.fastReviewInvitations) state.invitations = saved.fastReviewInvitations;
    applyInvitations();
    refreshInvitations();
  });
  setInterval(refreshInvitations, Invitations.MAX_AGE_MS);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.fastReviewScores) state.scoreCache = changes.fastReviewScores.newValue || {};
    if (changes.fastReviewInvitations) state.invitations = changes.fastReviewInvitations.newValue || { records: [] };
    if (changes.talentTarget) state.target = FastReview.compactText(changes.talentTarget.newValue, 4000);
    scheduleListRefresh();
    showDetailScore();
  });
})();
