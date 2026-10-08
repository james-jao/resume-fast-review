const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const Invitations = require("../invitations.js");

function worker(initial, fetcher) {
  let saved = initial;
  let listener;
  const context = vm.createContext({
    Invitations, FastReview: {}, importScripts() {}, AbortSignal,
    fetch: fetcher,
    chrome: {
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: {
        async get() { return { fastReviewInvitations: saved }; },
        async set(value) { saved = value.fastReviewInvitations; }
      } }
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve("../service-worker.js"), "utf8"), context);
  return { send: (force = false) => new Promise(resolve => listener({ type: "SYNC_INVITATIONS", force }, {}, resolve)), saved: () => saved };
}

test("同步解析 Google CSV，只存需要的欄位並合併並行請求", async () => {
  let requests = 0;
  const instance = worker(undefined, async (url, options) => {
    requests += 1;
    assert.equal(url, Invitations.CSV_URL);
    assert.equal(options.credentials, "omit");
    return { ok: true, text: async () => '人選姓名,邀約狀況,電話\n王小明,安排面談,0912345678' };
  });
  const [a, b] = await Promise.all([instance.send(true), instance.send(true)]);
  assert.equal(a.ok, true);
  assert.equal(b.data.records[0].name, "王小明");
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify(instance.saved()), /0912345678/);
  await instance.send();
  assert.equal(requests, 1);
});

test("同步失敗保留上次資料並顯示失敗；手動同步可立即重試", async () => {
  const previous = { records: [{ name: "王小明", status: "安排面談", row: 2 }], syncedAt: 1000 };
  let requests = 0;
  const instance = worker(previous, async () => {
    requests += 1;
    return requests === 1 ? { ok: false, status: 403 } : { ok: true, text: async () => '人選姓名,邀約狀況\n王小明,人選婉拒' };
  });
  const failed = await instance.send();
  assert.equal(failed.ok, false);
  assert.equal(instance.saved().syncedAt, 1000);
  assert.equal(instance.saved().records[0].status, "安排面談");
  assert.match(failed.error, /403/);
  await instance.send();
  assert.equal(requests, 1);
  assert.equal((await instance.send(true)).data.records[0].status, "人選婉拒");
});

test("Google 登入 HTML 不得覆蓋成功快取；空表可正常清除紀錄", async () => {
  const previous = { records: [{ name: "王小明", status: "安排面談", row: 2 }], syncedAt: 1000 };
  let body = "<html>Sign in</html>";
  const instance = worker(previous, async () => ({ ok: true, text: async () => body }));
  assert.equal((await instance.send(true)).ok, false);
  assert.equal(instance.saved().records.length, 1);
  body = '人選姓名,邀約狀況\n';
  assert.equal((await instance.send(true)).ok, true);
  assert.equal(instance.saved().records.length, 0);
});
