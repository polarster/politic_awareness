import { describe, expect, it } from "vitest";
import { safeHref } from "./url";

describe("safeHref", () => {
  it("放行 http(s) 網址", () => {
    const u = "https://ppg.ly.gov.tw/ppg/publications/official-gazettes/113/01/07/details";
    expect(safeHref(u)).toBe(u);
    expect(safeHref("http://example.org/a?b=1#c")).toBe("http://example.org/a?b=1#c");
    expect(safeHref("HTTPS://Example.org")).toBe("https://example.org/");
  });

  it("擋下 javascript:、data: 等其他協定，包括大小寫與空白變形", () => {
    for (const u of [
      "javascript:fetch('/api/chat',{method:'POST'})",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\nscript:alert(1)",
      "\tjavascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.org/x",
    ]) {
      expect(safeHref(u), u).toBeUndefined();
    }
  });

  it("相對路徑、空字串與非字串都不輸出", () => {
    for (const u of ["", "/ly-votes.json", "//evil.example/x", "#/votes", "not a url", null, undefined, 42, {}]) {
      expect(safeHref(u), String(u)).toBeUndefined();
    }
  });
});
