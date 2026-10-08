(function (root) {
  "use strict";
  const SHEET_ID = "1FA_iLasxq_048kEopxAjPeXZAA4gdo-XDTGkrZLEFIs";
  const SHEET_GID = "202392536";
  const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${SHEET_GID}`;
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  const MAX_AGE_MS = 5 * 60 * 1000;

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    const input = String(text).replace(/^\ufeff/, "");
    for (let i = 0; i < input.length; i += 1) {
      const char = input[i];
      if (char === '"') {
        if (quoted && input[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = !quoted;
      } else if (!quoted && char === ",") {
        row.push(cell); cell = "";
      } else if (!quoted && (char === "\n" || char === "\r")) {
        if (char === "\r" && input[i + 1] === "\n") i += 1;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += char;
    }
    if (quoted) throw new Error("CSV 引號不完整，無法同步。");
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function clean(value) {
    const text = String(value || "").trim();
    return /^[-—–]+$/.test(text) ? "" : text;
  }
  function normalizeName(value) {
    return String(value || "").normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]/g, "");
  }
  function parseInvitationCsv(text) {
    const rows = parseCsv(text);
    const header = rows[0] || [];
    const column = (name) => header.findIndex((cell) => normalizeName(cell) === name);
    const nameColumn = column("人選姓名"), statusColumn = column("邀約狀況");
    if (nameColumn < 0 || statusColumn < 0) throw new Error("邀約表缺少「人選姓名」或「邀約狀況」欄位；請確認表格可讀取。");
    const fields = {
      invitedAt: column("發信邀約日"), updatedAt: column("HR最後更新日期"),
      firstDate: column("一面日期"), firstResult: column("一面結果"),
      secondDate: column("二面日期"), secondResult: column("二面結果")
    };
    return rows.slice(1).flatMap((cells, index) => {
      const name = clean(cells[nameColumn]);
      if (!name) return [];
      const record = { name, status: clean(cells[statusColumn]), row: index + 2 };
      for (const [field, position] of Object.entries(fields)) record[field] = clean(cells[position]);
      return [record];
    });
  }
  function maskedName(value) {
    return normalizeName(value).replace(/[*○〇●]/g, "*").replace(/([\p{Script=Han}])[Oo](?=[\p{Script=Han}])/gu, "$1*");
  }
  function matchName(name, records) {
    const normalized = maskedName(name);
    if (!normalized || !/[\p{L}]/u.test(normalized)) return { kind: "none", records: [] };
    const matches = (records || []).filter((record) => {
      const other = maskedName(record.name);
      return other.length === normalized.length && [...normalized].every((char, i) => char === "*" || other[i] === "*" || char === other[i]);
    });
    const masked = normalized.includes("*") || matches.some((record) => maskedName(record.name).includes("*"));
    return { kind: matches.length ? (masked ? "masked" : "exact") : "none", records: matches };
  }
  function recordStatus(record) {
    return [record.status || "狀態未填", record.firstResult && `一面：${record.firstResult}`, record.secondResult && `二面：${record.secondResult}`].filter(Boolean).join(" · ");
  }
  function recordLink(record) {
    return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${SHEET_GID}&range=B${record.row}:J${record.row}`;
  }
  root.Invitations = { SHEET_URL, CSV_URL, MAX_AGE_MS, parseCsv, parseInvitationCsv, normalizeName, matchName, recordStatus, recordLink };
  if (typeof module !== "undefined" && module.exports) module.exports = root.Invitations;
})(typeof globalThis !== "undefined" ? globalThis : this);
