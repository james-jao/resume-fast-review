const test = require("node:test");
const assert = require("node:assert/strict");
const Invitations = require("../invitations.js");

const csv = '\ufeff#,人選姓名,發信邀約日,HR最後更新日期,邀約狀況,一面日期,一面結果,二面日期,二面結果\r\n1,王小明,,2026/10/01,安排面談,10/03,進二面,10/08,不錄用\r\n2,陳怡君,,10/02,"因其他原因評估後，不邀約",--,--,--,--\r\n3,王小明,,10/05,人選婉拒,--,--,--,--\r\n4,王大明,,10/07,未連繫上,--,--,--,--\r\n';

test("解析真實邀約欄位、引號逗號與空列，保留表格列號", () => {
  const records = Invitations.parseInvitationCsv(csv);
  assert.equal(records.length, 4);
  assert.equal(records[0].row, 2);
  assert.equal(records[1].status, "因其他原因評估後，不邀約");
  assert.equal(records[0].secondResult, "不錄用");
  assert.equal(records[1].firstResult, "");
  assert.deepEqual(Invitations.parseCsv('a,b\n"line1\nline2","a""b"'), [["a", "b"], ["line1\nline2", 'a"b']]);
});

test("格式錯誤與登入 HTML 不得當成空表成功", () => {
  assert.throws(() => Invitations.parseInvitationCsv("<html>login</html>"), /欄位/);
  assert.throws(() => Invitations.parseInvitationCsv('人選姓名,備註\n王小明,測試'), /欄位/);
  assert.throws(() => Invitations.parseCsv('a,b\n"broken,b'), /CSV/);
  assert.deepEqual(Invitations.parseInvitationCsv('人選姓名,邀約狀況\n'), []);
});

test("完整姓名精確比對、保留多筆紀錄，不使用子字串或猜測最新紀錄", () => {
  const records = Invitations.parseInvitationCsv(csv);
  const match = Invitations.matchName(" 王 小 明 ", records);
  assert.equal(match.kind, "exact");
  assert.equal(match.records.length, 2);
  assert.equal(Invitations.matchName("王小", records).records.length, 0);
  assert.equal(Invitations.matchName("", records).records.length, 0);
  assert.equal(Invitations.matchName("李小明", records).records.length, 0);
});

test("遮蔽姓名只能提示疑似紀錄，全部遮蔽不可匹配", () => {
  const records = Invitations.parseInvitationCsv(csv);
  assert.equal(Invitations.matchName("王Ｏ明", records).kind, "masked");
  assert.equal(Invitations.matchName("王○明", records).records.length, 3);
  assert.equal(Invitations.matchName("王＊明", records).records.length, 3);
  assert.equal(Invitations.matchName("***", records).records.length, 0);
});

test("狀態保留邀約狀況及面試結果，不將列入表格等同已發出邀約", () => {
  const records = Invitations.parseInvitationCsv(csv);
  assert.equal(Invitations.recordStatus(records[0]), "安排面談 · 一面：進二面 · 二面：不錄用");
  assert.equal(Invitations.recordStatus(records[3]), "未連繫上");
  assert.match(Invitations.recordLink(records[0]), /gid=202392536&range=B2:J2/);
});
