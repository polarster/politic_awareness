import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MatchResult } from "../lib/scoring";
import type { ArgumentSide, Entity } from "../lib/types";
import { Side } from "./Arguments";
import { MatchDetail } from "./MatchList";
import { Methodology } from "./Methodology";

// 資料被竄改（或來源資料有誤）時，javascript:、data:、相對路徑都不能變成連結

const BAD = /href="\s*(javascript|data|vbscript):/i;

// vi.mock 會被提到檔案最前面，用到的資料也要用 vi.hoisted 準備
const { tampered } = vi.hoisted(() => ({
  tampered: [
    { id: "t1", type: "party", name: "測試甲黨", logo: "logos/t1.svg", logo_source: "javascript:alert(1)", logo_license: "CC0" },
    {
      id: "t2", type: "party", name: "測試乙黨", logo: "logos/t2.svg", logo_source: "data:text/html,<script>alert(1)</script>",
      logo_license: "CC BY 4.0", logo_author: "某人",
    },
    // 網址裡有 wikimedia 但不是 http(s)：舊的判斷會顯示成「Commons 檔案頁」連結
    { id: "t3", type: "party", name: "測試丙黨", logo: "logos/t3.svg", logo_source: "javascript://commons.wikimedia.org/%0Aalert(1)", logo_license: "CC0" },
    { id: "t4", type: "party", name: "測試丁黨", logo: "logos/t4.svg", logo_source: " https://commons.wikimedia.org/wiki/File:T4.svg", logo_license: "CC0" },
    { id: "t5", type: "party", name: "測試戊黨", logo: "logos/t5.svg", logo_source: "https://example.org/logo", logo_license: "CC0" },
  ] as Entity[],
}));

vi.mock("../data", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../data")>();
  return { ...mod, data: { ...mod.data, entities: tampered } };
});

describe("Arguments 的來源連結", () => {
  it("只有 http(s) 會變成連結，其他只顯示「來源 n：類型」", () => {
    const side: ArgumentSide = {
      text: "理由",
      sources: [
        { kind: "news", title: "標題", url: "javascript:alert(1)" },
        { kind: "gazette", title: "標題", url: "data:text/html,<b>x</b>" },
        { kind: "org", title: "標題", url: "https://example.org/a" },
        { kind: "research", title: "標題", url: "/ly-votes.json" },
      ],
    };
    const html = renderToStaticMarkup(<Side title="同意的理由" side={side} />);
    expect(html).not.toMatch(BAD);
    expect(html).toContain("<li>來源 1：新聞</li>");
    expect(html).toContain("<li>來源 2：立法院公報</li>");
    expect(html).toContain('<li><a href="https://example.org/a" target="_blank" rel="noreferrer">來源 3：民間團體</a></li>');
    expect(html).toContain("<li>來源 4：研究報告</li>");
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});

describe("MatchDetail 的出處連結", () => {
  it("不合格的網址只把標題顯示成純文字；沒有標題就不顯示", () => {
    const m: MatchResult = {
      entity: { id: "t1", type: "party", name: "測試甲黨" },
      layer: "national", score: 0.5, compared: 1, total: 1,
      items: [{
        id: "N01", user: 1, agreement: 0.5, weight: 1,
        stance: {
          question: "N01", value: -1, interpretation: "說明", grade: "A",
          evidence: [
            { grade: "A", kind: "vote", title: "惡意出處", url: "javascript:alert(document.cookie)" },
            { grade: "C", kind: "statement", url: "data:text/html,x", timestamp: 30 },
            { grade: "B", kind: "bill", title: "正常出處", url: "https://ly.gov.tw/x", timestamp: 30 },
            {
              grade: "A", kind: "vote", title: "表決紀錄", url: "JavaScript:alert(1)",
              vote: { body: "立法院", bill: "某法案", choice: "贊成", ref: "nuclear-act-2025" },
            },
          ],
        },
      }],
    };
    const html = renderToStaticMarkup(<MatchDetail m={m} />);
    expect(html).not.toMatch(BAD);
    expect(html).toContain("</span>惡意出處</li>");
    expect(html).toContain('<a href="https://ly.gov.tw/x?t=30" target="_blank" rel="noreferrer">正常出處</a>');
    expect(html).not.toContain("出處連結");
    // 表決的站內連結照常顯示，前面的分隔點跟著標題
    expect(html).toContain('表決紀錄 · <a href="#/votes/nuclear-act-2025">看各黨與每位立委的投票</a>');
  });
});

describe("Methodology 的黨徽來源", () => {
  it("只有 http(s) 會變成連結；不合格時連結和後面的「，」一起省略", () => {
    const html = renderToStaticMarkup(<Methodology onClose={() => {}} />);
    expect(html).not.toMatch(BAD);
    expect(html).toContain("<li>測試甲黨：CC0</li>");
    expect(html).toContain("<li>測試乙黨：CC BY 4.0，作者／來源：某人</li>");
    expect(html).toContain("<li>測試丙黨：CC0</li>");
    expect(html).toContain(
      '<li>測試丁黨：<a href="https://commons.wikimedia.org/wiki/File:T4.svg" target="_blank" rel="noreferrer">Commons 檔案頁</a>，CC0</li>',
    );
    expect(html).toContain('<li>測試戊黨：<a href="https://example.org/logo" target="_blank" rel="noreferrer">來源</a>，CC0</li>');
  });
});
