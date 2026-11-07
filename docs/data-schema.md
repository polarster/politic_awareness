# 資料格式草案（v0.1）

所有資料都以 YAML 檔放在 `data/` 目錄，由 build 步驟轉成 JSON 給前端使用。

```
data/
  axes.yaml               # 維度定義
  questions.yaml          # 主問卷題目
  supplementary.yaml      # 補充題庫（Claude 對答用）
  entities/
    parties/<id>.yaml     # 政黨
    people/<id>.yaml      # 政治人物（第二階段）
  stances/<entity_id>.yaml  # 某對象對各題的立場和證據
```

## axes.yaml

```yaml
version: 1
axes:
  - id: identity
    name: 兩岸與國家認同
    negative_pole: 台灣主體        # 值為 -2 的那一端
    positive_pole: 兩岸整合        # 值為 +2 的那一端
    description: ...
```

## questions.yaml

```yaml
version: 2026.11-draft1      # 題庫版本號，會一起寫進匿名紀錄
questions:
  - id: N01
    layer: national          # national | municipal
    axis: identity           # 可以是 null：不計入任何維度，只用在逐題對照
    direction: 1             # 1：同意代表往 positive_pole 移；-1：同意代表往 negative_pole 移
    text: 兩岸應以「九二共識」作為對話基礎。
    note: 題目背景說明（可以留空），在作答時讓使用者展開來看
```

`supplementary.yaml` 的格式和 `questions.yaml` 相同，另外加一個 `topics` 欄位（例如 `[class, welfare]`），讓 Claude 依話題挑題。

## budget.yaml（市政預算分配）

```yaml
version: 2026.11-draft1
start_balance: 0
min_final_balance: 0
steps: [-2, -1, 0, 1, 2]
items:
  - id: B_HOUSING
    kind: expense            # expense | revenue | surplus
    name: 社會住宅
    cost_per_step: 2         # expense：每增加一格花 2 點，每減少一格得 2 點
    axis: economy
    direction: -1            # 增加這一項，代表往 negative_pole（重分配）移
    cities: [taipei, newtaipei]
  - id: R_HOUSE_TAX
    kind: revenue
    name: 房屋稅（囤房稅）
    cost_per_step: 2         # revenue：每增加一格得 2 點，每減少一格花 2 點
    axis: economy
    direction: -1
    cities: [taipei, newtaipei]
  - id: S_RESERVE
    kind: surplus
    name: 還債或留作準備金
    cost_per_step: 1
    axis: null
    direction: 0
    cities: [taipei, newtaipei]
```

立場資料中，預算項目的 `question` 欄位填項目 id，`value` 只取 -1、0、1（方向）。

## entities

```yaml
# entities/parties/dpp.yaml
id: dpp
type: party                  # party | person
name: 民主進步黨
short: 民進黨
inclusion_reason: 立法院有席次   # 對應 requirements §3 的哪一條收錄規則
links:
  official: https://www.dpp.org.tw/
```

```yaml
# entities/people/miao-poya.yaml（第二階段）
id: miao-poya
type: person
name: 苗博雅
party: sdp
roles:
  - title: 台北市議員
    since: 2018-12-25
candidacy:
  election: 2026-local
  office: 台北市議員
  district: ...
inclusion_reason: 雙北現任議員候選人
```

## stances/<entity_id>.yaml

```yaml
entity: dpp
stances:
  - question: N01
    value: -2                # -2 到 +2；查無資料就不寫這筆
    interpretation: >        # 「詮釋」：為什麼判斷是這個值
      民進黨黨綱及歷任主席聲明均不接受九二共識。
    last_reviewed: 2026-11-07
    evidence:                # 至少一筆；這個立場的等級取所有出處中最高的等級
      - grade: C
        kind: platform       # vote | bill | interpellation | platform | statement
                             # | interview | debate | social_interview
        title: 民主進步黨黨綱
        url: https://...
        date: 1991-10-13
        venue: null          # 場合：例如節目名稱、辯論會名稱、議會會期
        quote: "..."         # 原文引文
        context: "..."       # 前後語境
        timestamp: null      # 影片的秒數，前端會轉成 ?t= 連結
        vote:                # 只有 kind: vote 才需要這一段
          body: 立法院       # 立法院 | 台北市議會 | 新北市議會
          bill: ...
          choice: 反對       # 贊成 | 反對 | 棄權 | 未投票
    superseded:              # 被較新發言取代的舊講法（可以留空）
      - value: 0
        evidence: [ ... ]
        note: 2019 年曾表示...
```

## 匿名作答紀錄（後端，opt-in）

```json
{
  "quiz_version": "2026.11-draft1",
  "hour": "2026-11-07T14",
  "answers": { "N01": { "v": -1, "imp": true }, "N02": { "v": null, "imp": false } },
  "supplementary": { "X01": { "v": 2, "imp": false } },
  "adjustments": [
    { "type": "answer_change", "question": "E01", "from": 0, "to": 1 },
    { "type": "importance_change", "question": "E02", "to": true }
  ]
}
```

不含 IP、cookie、user agent 或對話文字。

## Claude 工具定義（草案）

```json
[
  {
    "name": "ask_supplementary",
    "description": "從補充題庫挑一題請使用者作答。",
    "input_schema": { "type": "object",
      "properties": { "question_id": { "type": "string" }, "why": { "type": "string" } },
      "required": ["question_id", "why"] }
  },
  {
    "name": "propose_answer_change",
    "description": "根據對話內容，建議修改某題的作答。需要使用者確認才會生效。",
    "input_schema": { "type": "object",
      "properties": {
        "question_id": { "type": "string" },
        "new_value": { "type": "integer", "minimum": -2, "maximum": 2 },
        "reason": { "type": "string" } },
      "required": ["question_id", "new_value", "reason"] }
  },
  {
    "name": "propose_importance_change",
    "description": "建議調整某題的重要度標記。需要使用者確認才會生效。",
    "input_schema": { "type": "object",
      "properties": {
        "question_id": { "type": "string" },
        "important": { "type": "boolean" },
        "reason": { "type": "string" } },
      "required": ["question_id", "important", "reason"] }
  }
]
```

傳給 Claude 的 context 包含：
- 題目、使用者的作答和重要度、各維度位置
- 契合度最高的幾個對象，以及它們的立場和出處，供引用

工具執行的結果，例如「使用者已確認」或「使用者已拒絕」，由前端回傳給 Claude。
