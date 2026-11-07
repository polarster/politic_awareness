# 政治光譜自我探索

用問卷了解自己的政治傾向，對照台灣政黨（之後加入政治人物）的立場；每個立場都附出處。
結果和自我認同有落差時，可以和 Claude 對答，在使用者確認下修正作答。

- 需求文件：`docs/requirements.md`
- 資料格式：`docs/data-schema.md`
- **題目、預算項目、討論主題、政黨與立場資料都在 `data/`（以這裡為準）**

## 結構

```
data/          YAML 資料（題目、補充題、預算、討論主題、政黨、立場、精選表決 votes.yaml）
data/ly/       立法院記名表決整理檔 votes.json（scripts/ly_votes.py 產生）
scripts/       build_data.py：驗證 YAML 並輸出 web/src/generated/data.json 與 web/public/ly-votes.json
               ly_votes.py：從立法院議事錄抓取第 10、11 屆所有記名表決，依黨籍統計
web/           React + Vite 前端（計分全在前端）
api/           FastAPI 後端：/api/chat（Claude 代理）、/api/log（匿名作答記錄）
```

## 本機開發

```bash
# 後端
cd api
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # 填入 ANTHROPIC_API_KEY
set -a && . ./.env && set +a
.venv/bin/uvicorn app:app --no-access-log --port 8000

# 前端（另一個終端機）
cd web
npm install
npm run dev            # 會先跑 build_data.py；/api 由 vite proxy 轉到 :8000
```

測試：`cd web && npm test`、`cd api && .venv/bin/python -m pytest`

修改 `data/` 後跑 `python3 scripts/build_data.py` 重新產生 JSON（`npm run dev/build` 會自動跑），並重啟後端（system prompt 在啟動時建立）。

## 立院投票紀錄

網站的「立院投票紀錄」頁（`#/votes`）列出：
- 和題目相關的精選表決（`data/votes.yaml`），附白話說明與相關題目；
- 第 10、11 屆全部記名表決，可用法案名稱或立委姓名搜尋。

每筆都有各黨票數、逐人名單與立法院公報原文連結。更新資料：

```bash
python3 scripts/ly_votes.py          # 下載議事錄（快取於 build/ly_cache）並輸出 data/ly/votes.json
python3 scripts/build_data.py
```

資料來源為立法院議事暨公報資訊網，透過 g0v 立法院 API（ly.govapi.tw）取得議事錄文字檔。

## 隱私設計

- 計算全在瀏覽器；作答進度只存在 sessionStorage。
- `/api/log` 只在使用者勾選後送出，只存作答、重要度、預算、結構化修正、題庫版本、時間（到小時）。不存 IP、UA、cookie。
- 後端用 `--no-access-log` 啟動，避免 uvicorn 記錄 IP。限流用的 IP 只在記憶體中，視窗過後即丟棄。
- 對答內容不記錄。

## Claude 設定

- 模型預設 `claude-sonnet-5-5`，effort 預設 `low`；可用 `CLAUDE_MODEL`、`CLAUDE_EFFORT` 調整。
- 已啟用伺服器端 refusal fallback（`fallbacks: "default"`）。
- **全站用量上限**：`USD_BUDGET`（預設 $1）是 `USAGE_WINDOW_SECONDS`（預設 5 小時）滾動視窗內的總花費。每次問答依實際 token 用量與價格表（`PRICE_TABLE`，預設值在 `api/usage.py`）換算成美元。達到上限後 `/api/chat` 回 429。前端只顯示百分比（`GET /api/usage`），每 10 秒更新一次，每次對答回覆後也會立即更新。用量紀錄（只有時間戳 + 金額）存在 `api/usage.sqlite3`，重啟後延續。後端請用單一 worker 執行。
- 請在 Anthropic Console 設定每月預算上限。

## 授權

BSD 3-Clause，見 `LICENSE`。
