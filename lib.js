(function (root) {
  "use strict";

  const SCORE_LEVELS = [
    "幾乎不符合需求，或有明確且重大的不符合",
    "只符合少數次要條件，多數重要條件沒有證據或不符合",
    "符合部分重要條件，但仍有明顯缺口或資料不足",
    "符合大多數重要條件，只有少量缺口",
    "高度符合所有重要條件，且履歷有清楚證據"
  ];

  function scoreToPercent(score, levelCount = SCORE_LEVELS.length) {
    const maximum = Math.max(1, levelCount - 1);
    const numeric = Number(score);
    if (!Number.isFinite(numeric)) return null;
    return Math.round(Math.min(1, Math.max(0, numeric / maximum)) * 100);
  }

  function compactText(value, maxLength = 12000) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxLength);
  }

  function isCandidateProfileUrl(value) {
    try {
      const url = new URL(value, "https://vip.104.com.tw/");
      return url.protocol === "https:"
        && url.hostname === "vip.104.com.tw"
        && url.pathname.toLowerCase() === "/search/searchresumemaster"
        && /^\d+$/.test(url.searchParams.get("idno") || "");
    } catch (_error) {
      return false;
    }
  }

  function candidateIdFromUrl(value) {
    if (!isCandidateProfileUrl(value)) return null;
    return new URL(value, "https://vip.104.com.tw/").searchParams.get("idno");
  }

  function buildEvaluationRequest(target, candidates) {
    const state = {
      hiring_need: compactText(target, 4000),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        profile: compactText(candidate.profile)
      }))
    };
    const questions = {};
    candidates.forEach((candidate, index) => {
      questions[`candidate_${index}`] = {
        type: "score",
        instructions: {
          question: `人才 \`candidates[${index}].profile\` 與招募需求 \`hiring_need\` 的整體契合程度如何？只依據履歷中可見的證據判斷；缺少證據不能當作符合。`,
          candidate_id: candidate.id
        },
        criteria: SCORE_LEVELS
      };
    });
    return { state, model: "jev-latest", questions };
  }

  function parseScoreResults(body, candidates) {
    if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") {
      throw new Error("Jev 回應缺少 answers。 ");
    }
    return candidates.map((candidate, index) => {
      const answer = body.answers[`candidate_${index}`];
      if (answer?.type !== "score" || !Number.isFinite(answer.score)) {
        throw new Error(`Jev 回應缺少 candidate_${index} 的 Score。`);
      }
      return {
        id: candidate.id,
        percent: scoreToPercent(answer.score),
        score: answer.score,
        confidence: Number.isFinite(answer.confidence) ? answer.confidence : null
      };
    });
  }

  root.FastReview = {
    SCORE_LEVELS,
    scoreToPercent,
    compactText,
    isCandidateProfileUrl,
    candidateIdFromUrl,
    buildEvaluationRequest,
    parseScoreResults
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.FastReview;
})(typeof globalThis !== "undefined" ? globalThis : this);
