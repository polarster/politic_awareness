import { describe, expect, it } from "vitest";
import { parseVoteFocus } from "./route";

const ids = new Set(["nuclear-act-2025", "院會-10-8-12#1"]);

describe("parseVoteFocus", () => {
  it("取出存在的表決 id", () => {
    expect(parseVoteFocus("#/votes/nuclear-act-2025", ids)).toBe("nuclear-act-2025");
    expect(parseVoteFocus(`#/votes/${encodeURIComponent("院會-10-8-12#1")}`, ids)).toBe("院會-10-8-12#1");
  });

  it("沒有 id 時回傳 undefined", () => {
    expect(parseVoteFocus("#/votes", ids)).toBeUndefined();
    expect(parseVoteFocus("#/votes/", ids)).toBeUndefined();
    expect(parseVoteFocus("", ids)).toBeUndefined();
  });

  it("不合法的百分比編碼不丟例外", () => {
    for (const h of ["#/votes/%", "#/votes/%E0%A4%A", "#/votes/%zz", "#/votes/%ED%A0%80"]) {
      expect(() => parseVoteFocus(h, ids), h).not.toThrow();
      expect(parseVoteFocus(h, ids), h).toBeUndefined();
    }
  });

  it("原型鏈上的名稱與未知 id 都當成找不到", () => {
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "unknown-vote"]) {
      expect(parseVoteFocus(`#/votes/${id}`, ids), id).toBeUndefined();
    }
  });
});
