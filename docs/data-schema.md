# 資料格式草案（v0.1）

所有資料都以 YAML 檔放在 `data/` 目錄，由 `scripts/build_data.py` 驗證後轉成 `web/src/generated/data.json`，前端與後端共用這一份（見下方〈data.json〉）。

```
data/
  axes.yaml               # 維度定義
  questions.yaml          # 主問卷題目
  supplementary.yaml      # 補充題庫（Claude 對答用）
  budget.yaml             # 市政預算分配
  discussions.yaml        # 對答的討論主題
  votes.yaml              # 精選表決（引用 ly/votes.json 的表決）
  ly/votes.json           # 立法院記名表決整理檔（scripts/ly_votes.py 產生）
  entities/
    parties/<id>.yaml     # 政黨
    people/<id>.yaml      # 政治人物（第二階段）
  stances/<entity_id>.yaml  # 某對象對各題的立場和證據
  arguments/<主題>.yaml     # 各題的正反說法與出處
  explainers/<主題>.yaml    # 各題的名詞解釋、背景說明與白話說明
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
version: 2026.11-draft1      # 題庫版本號，不可含「+」；輸出時自動加上內容雜湊（見〈data.json〉），會一起寫進匿名紀錄
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
start_balance: 0             # 起始餘額（點數）
min_final_balance: 0         # 最後餘額至少要這麼多才能送出
steps: [-2, -1, 0, 1, 2]     # 每個項目可選的格數，0 是維持現況
cities:                      # 必填：使用者先選城市，兩市共用下面同一組項目
  - id: taipei
    name: 台北市
  - id: newtaipei
    name: 新北市
items:
  - id: B_EDUCATION
    kind: expense            # expense | revenue | surplus
    name: 教育
    detail: 降低班級人數、增聘教師、減輕教師行政負擔   # 可省略：顯示在項目名稱下方的補充說明
    cost_per_step: 1         # expense：每增加一格花 1 點，每減少一格得 1 點
    axis: city_priority      # axes.yaml 的維度 id，或 null（不計入任何維度）
    direction: -1            # 增加這一項，代表往 negative_pole（生活照顧優先）移；axis 為 null 時填 0
  - id: R_HOUSE_TAX
    kind: revenue
    name: 房屋稅（囤房稅）
    cost_per_step: 1         # revenue：每增加一格得 1 點，每減少一格花 1 點
    axis: city_priority
    direction: -1
  - id: S_RESERVE
    kind: surplus
    name: 還債或留作準備金
    min_step: 0              # 可省略：最低只能選到這一格（沒寫時是 steps 的最小值）；這裡表示結餘不能為負
    cost_per_step: 1         # surplus：每增加一格花 1 點
    axis: null
    direction: 0
```

- `cities` 的 `id` 是匿名作答 `city` 欄位的合法值，`name` 顯示在畫面上；後端載入 data.json 時會讀這份清單，少了 `cities` 就無法載入。
- 項目的 `id` 和題目共用同一組 id，不可重複；`axis` 必須是 axes.yaml 裡的維度，否則 build 失敗。
- 照顧類和成長類的項目只計入 `city_priority`，不重複計入全國層的經濟相關軸（見 requirements §5.1）；其他項目可以計入 `environment`、`social` 等軸，例如捷運與公車、治安與消防。
- 每個項目只能選 `min_step`（或 `steps` 的最小值）以上的格數；餘額的計算見各 `kind` 的註解。

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
      - grade: C             # A | B | C；A 級只能是 vote 或 bulletin（見 requirements §4）
        kind: platform       # vote | bulletin | bill | interpellation | platform | statement
                             # | interview | debate | social_interview
                             # bulletin：中選會選舉公報上候選人刊登的政見（A 級）
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

## arguments/<主題>.yaml（正反說法）

```yaml
arguments:
  - question: E06
    pro:
      text: "支持者認為，……"     # 120 字以內
      sources:
        - kind: gazette          # 來源類型，見下表
          title: "……"
          url: "https://..."
          date: "2018-01-09"     # 可省略
          speaker: "……"          # 可省略
    con:
      text: "反對者認為，……"
      sources: [ ... ]
      note: "……"                 # 可省略；只在 sources 為空時顯示，但會輸出到公開的 data.json
```

正反說法的文字以 120 字以內為原則。前端只顯示「來源 n：類型」，不顯示來源標題和發言人。

來源類型（`kind`）和前端顯示的標籤：

| kind | 標籤 | 說明 |
|---|---|---|
| gazette | 立法院公報 | |
| minutes | 議事錄 | |
| official | 官方文件 | 政府機關文件、法規、立法院議案等 |
| news | 新聞 | |
| org | 民間團體 | 民間團體以組織名義發表的聲明、報告、法律意見等 |
| research | 研究報告 | 學術或智庫的研究報告 |
| reference | 參考資料 | 只能用在 explainers，例如百科條目 |

## explainers/<主題>.yaml（名詞與背景、白話說明）

```yaml
explainers:
  - question: E06
    terms:
      - term: 加班時數上限
        text: "……"              # 120 字以內
        sources: [ ... ]         # 至少一個；欄位同上，但沒有 speaker
    background:                  # 可省略
      text: "……"                # 170 字以內
      sources: [ ... ]
    plain:                       # 正反說法的白話版，只改寫原說法，不加入新的事實或論點
      pro: "……"                 # 100 字以內
      con: "……"
```

explainers 的來源類型可用上表全部七種，也就是正反說法的六種再加上 reference。名詞、背景、白話說明的字數上限，以及內文不得出現政黨或政治人物名稱，都由 `scripts/build_data.py` 檢查。

## data.json（build 輸出）

`python3 scripts/build_data.py` 驗證所有 YAML 後輸出 `web/src/generated/data.json`（加 `--check` 只驗證、不寫檔）；有 `data/ly/votes.json` 時另輸出 `web/public/ly-votes.json`。頂層欄位：`version`、`votes`、`arguments`、`explainers`、`discussions`、`axes`、`questions`、`supplementary`、`budget`、`entities`、`stances`、`data_hash`。

- `version`：questions.yaml 的 `version` 加上「+」與內容雜湊，例如 `2026.11-draft4+2c6fa93e`。
  - 內容雜湊涵蓋維度（axes）、主問卷、補充題與整份 budget.yaml（含城市）：以 JSON 序列化（鍵排序、不跳脫中文、沒有空白）後取 SHA-256 的前 8 個 hex 字元，和鍵在 YAML 裡的順序無關。題目或計分相關的內容一改，版本就跟著變，不必手動改版本號；立場、正反說法等其他資料不影響版本。
  - 前端存的作答進度綁版本，版本不同就丟掉舊進度；後端只收 `quiz_version` 等於目前版本的匿名作答，否則回 400。
  - 因為「+」之後是自動加上的雜湊，questions.yaml 的 `version` 不可含「+」，否則 build 失敗。
- `data_hash`：整份輸出（含立場、討論主題、正反說法等，不含 `data_hash` 本身）用同樣方式序列化後的 SHA-256 前 12 個 hex 字元。`GET /api/health` 會連同 `quiz_version` 一起回報，用來確認後端載入的是哪一份資料（後端在 `data.json` 改變時會自動重新載入）。

## 匿名作答紀錄（後端，opt-in）

### 上傳格式（`POST /api/log`）

前端送出的 JSON，對應 `api/app.py` 的 `LogRecord`。不接受沒有列出的欄位；分數一律是 -2 到 2 的整數（不接受字串或小數），布林值不接受 0／1。

```json
{
  "submission_id": "3f1c2a9e-8b7d-4c2e-9f10-2b6a7d5e4c31",
  "quiz_version": "2026.11-draft4+2c6fa93e",
  "city": "taipei",
  "answers": { "N01": { "v": -1, "imp": true }, "N02": { "v": null, "imp": false }, "X01": { "v": 2, "imp": false } },
  "budget": { "B_HOUSING": 1, "R_HOUSE_TAX": -1 },
  "adjustments": [
    { "type": "answer_change", "question": "E01", "from": 0, "to": 1 },
    { "type": "importance_change", "question": "E02", "to": true },
    { "type": "supplementary_answer", "question": "X03", "to": -1 }
  ],
  "mode": "simple",
  "first_answers": null,
  "journey_after_results": null
}
```

| 欄位 | 格式 | 說明 |
|---|---|---|
| `submission_id` | UUID v4（小寫 hex），必填 | 前端每一輪作答隨機產生，存在該分頁的 sessionStorage。重送同一輪時覆蓋同一筆；資料庫只存它的 SHA-256（`id` 欄），不存原值。 |
| `quiz_version` | 字串，最多 64 字，必填 | 必須等於後端目前載入的 data.json `version`，否則回 400（請使用者重新整理）。 |
| `city` | 城市 id 或 null | 必須是 budget.yaml `cities` 裡的 `id` 之一。 |
| `answers` | `{題號: {"v": 分數或 null, "imp": 布林}}`，1–300 題，必填 | 題號必須是主問卷或補充題，而且至少要有一題主問卷。`v` 是 null 表示「不知道／無意見」；`imp` 預設 false。 |
| `budget` | `{預算項目 id: 分數}` 或 null，最多 100 項 | 項目必須是 budget.yaml 的項目。 |
| `adjustments` | 陣列，最多 300 筆，也不能超過題數的 3 倍 | 對答中套用的修正，只有結構化資料、沒有理由文字：`answer_change`（`question`、`from`：分數或 null、`to`：分數）、`importance_change`（`question`、`to`：布林）、`supplementary_answer`（`question` 必須是補充題、`to`：分數或 null）。 |
| `mode` | `"simple"` 或 `"full"`，預設 `"simple"` | `"full"` 表示完成了思辨旅程。 |
| `first_answers` | 格式同 `answers`，或 null | `"full"` 時必填：第一輪的答案（第一直覺）；`"simple"` 時必須是 null。 |
| `journey_after_results` | 布林或 null | `"full"` 時必填：思辨旅程是否在看過結果之後才進行；`"simple"` 時必須是 null。 |

其他限制：請求 body 最多 64 KiB，寫入資料庫的 `payload` 最多 32 KiB（UTF-8）；每個 client 每小時最多 5 次；每天（UTC）最多新增 `PA_LOG_DAILY_LIMIT`（預設 500）筆，超過回 429。重送同一份作答（同一個 `submission_id`）會覆蓋原本那一筆，不會被每日上限擋下；但跨日重送時，那一筆的 `day` 會改成當天，因此算進當天的筆數。

### 資料表（`PA_LOG_DB_PATH`，預設 `api/answers.sqlite3`）

```sql
CREATE TABLE answers (
  id TEXT PRIMARY KEY,         -- sha256(submission_id) 的 hex（64 字元）
  day TEXT NOT NULL,           -- 收到的日期（UTC，YYYY-MM-DD）；重送時改成重送那天
  quiz_version TEXT NOT NULL,  -- 題庫版本（含內容雜湊）
  payload TEXT NOT NULL        -- 上傳紀錄去掉 submission_id 與 quiz_version 後的 JSON
) WITHOUT ROWID;
CREATE INDEX answers_day ON answers(day);  -- 計算每日上限用
```

- 主鍵是隨機的雜湊值、沒有 rowid，資料表不保留送出順序；時間只記到「日」。
- 同一個 `submission_id` 再送一次會覆蓋整筆（`day`、`quiz_version`、`payload` 都換成新的）。
- 資料庫檔以 0600 建立（已存在但權限太寬時改回 0600），並開啟 `PRAGMA secure_delete`，覆蓋或刪除的內容會被清零。每天第一筆寫入後會 `VACUUM` 一次，重整檔案的頁面配置，讓它不反映先前的寫入順序。
- `payload` 依 `LogRecord` 的欄位順序輸出、沒有空白，例如：
  `{"city":"taipei","answers":{"N01":{"v":-1,"imp":true}},"budget":null,"adjustments":[],"mode":"simple","first_answers":null,"journey_after_results":null}`

不含 IP、cookie、user agent 或對話文字。

### 用量紀錄（`PA_USAGE_DB_PATH`，預設 `api/usage.sqlite3`）

資料表 `usage_cost (ts REAL NOT NULL, usd REAL NOT NULL)`：每次呼叫 Claude 的時間（Unix 秒）與換算出的花費（美元），超過用量視窗的列會被刪掉。只用來在重啟後延續全站用量上限；每個 client 的子額度只存在記憶體。檔案權限同樣是 0600。

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
