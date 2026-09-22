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

  function candidateProfileApiUrl(value) {
    if (!isCandidateProfileUrl(value)) return null;
    const url = new URL(value, "https://vip.104.com.tw/");
    const candidateId = url.searchParams.get("idno");
    const rawPath = url.searchParams.get("path_for_log") || "list_search";
    const pathForLog = /^[a-z0-9_-]+$/i.test(rawPath) ? rawPath : "list_search";
    return `https://auth.vip.104.com.tw/vipapi/resume/search/${candidateId}?path_for_log=${encodeURIComponent(pathForLog)}`;
  }

  const RESUME_MATCH_FIELDS = [
    "achievement",
    "careerSkillDescForMaster",
    "characteristic",
    "degreeLevelDesc",
    "degreeStatusDesc",
    "detailExpDesc",
    "driverLicenseDesc",
    "eduDesc",
    "eduOutput",
    "expCatTimeDesc",
    "expJobArr",
    "expPeriodDesc",
    "hopeSalaryDesc",
    "indCatNoDesc",
    "introduction",
    "jobCatNoDesc",
    "major",
    "majorCatDesc",
    "motto",
    "otherCourse",
    "pcskillDescForMaster",
    "proDesc2",
    "recentJobDesc",
    "remoteWork",
    "summaryDisplay",
    "talentDesc"
  ];
  const PRIVATE_FIELD = /(?:address|email|phone|mobile|contact|picture|photo|avatar|personalPic|idNo|pId|userName|nameEng)/i;

  function redactContactText(value) {
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[已移除 Email]")
      .replace(/(?:\+?886[-\s]?)?0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, "[已移除電話]");
  }

  function removePrivateFields(value) {
    if (Array.isArray(value)) return value.map(removePrivateFields);
    if (typeof value === "string") return redactContactText(value);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !PRIVATE_FIELD.test(key))
        .map(([key, item]) => [key, removePrivateFields(item)])
    );
  }

  function extractResumeProfile(body) {
    const resume = body?.data?.resume;
    if (!resume || typeof resume !== "object") {
      return { ok: false, error: "履歷 API 沒有回傳人才資料，請確認 104 登入狀態。" };
    }
    const selected = {};
    RESUME_MATCH_FIELDS.forEach((field) => {
      if (resume[field] !== undefined && resume[field] !== null && resume[field] !== "") {
        selected[field] = removePrivateFields(resume[field]);
      }
    });
    const text = compactText(JSON.stringify(selected), 18000);
    if (text.length < 100) return { ok: false, error: "履歷 API 回傳的媒合資料不足，未送出評估。" };
    return { ok: true, text };
  }

  function cachedScoreForTarget(entry, target) {
    if (!entry || typeof entry !== "object") return null;
    if (compactText(entry.target, 4000) !== compactText(target, 4000)) return null;
    if (!Number.isFinite(entry.percent) || entry.percent < 0 || entry.percent > 100) return null;
    if (entry.confidence !== null && entry.confidence !== undefined && !Number.isFinite(entry.confidence)) return null;
    return entry;
  }

  function scoreCacheKey(candidateId, target) {
    const id = String(candidateId || "").trim();
    const normalizedTarget = compactText(target, 4000);
    return id && normalizedTarget ? `${id}\u001f${normalizedTarget}` : null;
  }

  function uncachedDetailCandidate(value, scoreCache, target) {
    const id = candidateIdFromUrl(value);
    if (!id) return null;
    const cacheKey = scoreCacheKey(id, target);
    if (cachedScoreForTarget(scoreCache?.[cacheKey], target)) return null;
    return { id, url: new URL(value, "https://vip.104.com.tw/").href, card: null };
  }

  function buildEvaluationRequest(target, candidates) {
    const state = {
      hiring_need: compactText(target, 4000),
      candidates: candidates.map((candidate) => ({
        profile: compactText(candidate.profile)
      }))
    };
    const questions = {};
    candidates.forEach((candidate, index) => {
      questions[`candidate_${index}`] = {
        type: "score",
        instructions: {
          question: `人才 \`candidates[${index}].profile\` 與招募需求 \`hiring_need\` 的整體契合程度如何？只依據履歷中可見的證據判斷；缺少證據不能當作符合。`
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
    candidateProfileApiUrl,
    extractResumeProfile,
    cachedScoreForTarget,
    scoreCacheKey,
    uncachedDetailCandidate,
    buildEvaluationRequest,
    parseScoreResults
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.FastReview;
})(typeof globalThis !== "undefined" ? globalThis : this);
