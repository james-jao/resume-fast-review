const test = require("node:test");
const assert = require("node:assert/strict");
const {
  scoreToPercent,
  compactText,
  candidateProfileApiUrl,
  extractResumeProfile,
  buildEvaluationRequest,
  parseScoreResults
} = require("../lib.js");

test("辨識 104 真實 SearchResumeMaster 人才網址", () => {
  const url = "https://vip.104.com.tw/search/SearchResumeMaster?idno=1756775867113&sn=1";
  assert.equal(require("../lib.js").isCandidateProfileUrl(url), true);
  assert.equal(require("../lib.js").candidateIdFromUrl(url), "1756775867113");
});

test("將詳細頁網址轉成登入狀態下的履歷 JSON API", () => {
  const url = "https://vip.104.com.tw/search/SearchResumeMaster?idno=1756775867113&path_for_log=list_search";
  assert.equal(
    candidateProfileApiUrl(url),
    "https://auth.vip.104.com.tw/vipapi/resume/search/1756775867113?path_for_log=list_search"
  );
});

test("履歷 API 只保留媒合資料並移除聯絡與識別資訊", () => {
  const result = extractResumeProfile({
    data: {
      userName: "王小明",
      resume: {
        email: "candidate@example.com",
        phone: ["0912345678"],
        addressDesc: "台北市某路",
        personalPic: "https://example.com/photo.jpg",
        idNo: "1756775867113",
        expPeriodDesc: "8 年工作經驗",
        expJobArr: [{ companyName: "範例公司", jobName: ".NET 工程師" }],
        careerSkillDescForMaster: "C#、ASP.NET Core；聯絡 candidate@example.com 或 0912-345-678"
      }
    }
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /8 年工作經驗/);
  assert.match(result.text, /ASP\.NET Core/);
  assert.doesNotMatch(result.text, /candidate@example\.com|0912-345-678|台北市某路|photo\.jpg|1756775867113|王小明/);
});

test("Jev 五級分數正確轉成百分比並限制範圍", () => {
  assert.equal(scoreToPercent(0), 0);
  assert.equal(scoreToPercent(2), 50);
  assert.equal(scoreToPercent(4), 100);
  assert.equal(scoreToPercent(9), 100);
  assert.equal(scoreToPercent("bad"), null);
});

test("文字會清理空白並限制長度", () => {
  assert.equal(compactText("  A   B\n\n\n C  "), "A B\n\nC");
  assert.equal(compactText("abcdef", 3), "abc");
});

test("批次請求為每位人才建立獨立 Score 問題", () => {
  const request = buildEvaluationRequest("React 工程師", [
    { id: "a", profile: "三年前端經驗" },
    { id: "b", profile: "五年後端經驗" }
  ]);
  assert.equal(request.model, "jev-latest");
  assert.equal(request.questions.candidate_0.type, "score");
  assert.equal(request.questions.candidate_1.criteria.length, 5);
  assert.equal(request.state.candidates[1].profile, "五年後端經驗");
  assert.doesNotMatch(JSON.stringify(request), /\"id\"|candidate_id|\"a\"|\"b\"/);
});

test("依官方 Score 回應契約解析百分比與信心", () => {
  const results = parseScoreResults({
    answers: {
      candidate_0: { type: "score", score: 3.2, confidence: 0.72, probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.6, 4: 0.3 } }
    }
  }, [{ id: "a" }]);
  assert.deepEqual(results, [{ id: "a", percent: 80, score: 3.2, confidence: 0.72 }]);
  assert.throws(() => parseScoreResults({ answers: {} }, [{ id: "a" }]), /缺少 candidate_0/);
});
