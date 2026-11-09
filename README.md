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
api/           FastAPI 後端：/api/chat（Claude 代理）、/api/log（匿名作答記錄）、/api/usage（用量百分比）、/api/health
```

## 本機開發

後端程式本身只讀 `PA_` 開頭的設定（完整清單見下方〈後端設定〉），舊的 `CLAUDE_EFFORT` 等名稱已不再讀取；Anthropic SDK 另外會讀 `ANTHROPIC_` 開頭的變數（也見〈後端設定〉）。
請用乾淨的環境啟動：`env -i` 只帶 PATH、HOME、LANG 與需要的 `PA_` 設定，不會繼承目前 shell（或 Claude Code）的環境變數。
Anthropic 金鑰放在 `.keys/claude_api.key`，用 `PA_ANTHROPIC_API_KEY_FILE` 指過去，不要寫在指令列（`/proc/<pid>/cmdline` 本機任何使用者都讀得到）。

後端一啟動就要讀 `web/src/generated/data.json`，檔案不存在時拒絕啟動。這個檔案不在 git 裡，要先用 `scripts/build_data.py` 產生（下面的「資料」那一步）。`build_data.py` 需要 PyYAML，而且 `npm run dev`、`npm run build` 也是用系統的 `python3` 執行它，所以系統的 python3 要有 PyYAML（Debian／Ubuntu：`sudo apt install python3-yaml`）。暫時沒辦法裝時，也可以先建好 `api/.venv` 並裝 `requirements-dev.txt`（含 PyYAML，指令見下方的「測試」），在專案根目錄用 `api/.venv/bin/python scripts/build_data.py` 產生。

```bash
# 金鑰檔：在自己的終端機執行，不要交給 Claude 代跑；金鑰不會出現在畫面或 shell history
mkdir -p .keys && chmod 700 .keys
( umask 077; read -rsp 'Anthropic API 金鑰: ' k && echo && [ -n "$k" ] && printf '%s\n' "$k" > .keys/claude_api.key && chmod 600 .keys/claude_api.key ) || echo '未寫入 claude_api.key'

# 資料：在專案根目錄產生 web/src/generated/data.json（後端啟動前一定要有）
python3 scripts/build_data.py

# 後端
cd api
python3 -m venv --upgrade-deps .venv && .venv/bin/pip install --require-hashes --no-deps -r requirements.txt
env -i PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 \
  PA_ANTHROPIC_API_KEY_FILE=../.keys/claude_api.key PA_CLAUDE_EFFORT=medium \
  .venv/bin/uvicorn app:app --no-access-log --no-proxy-headers --host 127.0.0.1 --port 8000

# 前端（另一個終端機）
cd web
npm install
npm run dev            # 會先跑 build_data.py；/api 由 vite proxy 轉到 127.0.0.1:8000
```

其他 `PA_` 設定（用量上限、限流等，見〈後端設定〉）要用時，加在 `env -i` 後面。後端不會自動讀取 `.env` 檔；`api/.env.example` 只是設定的範例與說明。

測試：`cd web && npm test`；後端的 pytest 等測試工具在 `requirements-dev.txt`（`requirements.txt` 只有執行期的套件），要先裝：`cd api && .venv/bin/pip install --require-hashes --no-deps -r requirements-dev.txt && .venv/bin/python -m pytest`

修改 `data/` 後跑 `python3 scripts/build_data.py` 重新產生 JSON（`npm run dev/build` 會自動跑）。後端偵測到 `data.json` 改變會自動重新載入題目、立場與 system prompt，不用重啟；新檔案讀不進來時會繼續用舊資料，並在後端 log 印警告。

## 後端設定

後端程式本身的設定都是環境變數，只讀 `PA_` 開頭的名稱，在啟動時讀取，改了要重啟後端。沒設定或設成空字串時用預設值；整數設定必須 ≥ 1，格式不對或超出範圍時後端拒絕啟動。環境裡若還有沒有前綴的舊名稱（`CLAUDE_MODEL`、`CLAUDE_EFFORT`、`TRUST_PROXY`、`USD_BUDGET`、`PRICE_TABLE` 等），啟動時會印警告（只列名稱），但不會讀取。

後端用的套件另外會讀自己的環境變數：
- Anthropic SDK：不論有沒有金鑰檔，都會讀 `ANTHROPIC_BASE_URL`、`ANTHROPIC_CUSTOM_HEADERS`（會改變請求和金鑰送到哪個主機、帶哪些標頭）與 `ANTHROPIC_LOG`（設成 `debug` 時，請求內容，包括對話，會寫進 log）。沒有金鑰檔時，還會依序找 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_PROFILE`、workload identity 的變數，最後是 `~/.config/anthropic`（或 `ANTHROPIC_CONFIG_DIR`）裡的 active profile；`env -i` 有帶 HOME，所以最後這一步仍然有效。
- HTTP 函式庫會讀 `HTTPS_PROXY` 等代理設定。

用 `env -i` 啟動，這些變數就不會從目前的 shell 帶進來；再設定 `PA_ANTHROPIC_API_KEY_FILE`，金鑰就只會來自那個檔案。

| 名稱 | 預設值 | 說明 |
|---|---|---|
| `PA_ANTHROPIC_API_KEY_FILE` | 未設定 | Anthropic 金鑰檔的路徑。讀不到或檔案是空的就拒絕啟動；其他帳號讀得到時印警告（請 `chmod 600`）。有設定時金鑰只來自這個檔案。沒設定時改由 Anthropic SDK 自己找：`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_PROFILE`、workload identity 的變數，最後是 `~/.config/anthropic` 的 profile（見表格上方）；用 `env -i` 時前兩個就得寫在指令列，不建議。 |
| `PA_CLAUDE_MODEL` | `claude-sonnet-5-5` | 模型 ID，只能有小寫英文、數字、`.`、`-`，格式不對時拒絕啟動。 |
| `PA_CLAUDE_EFFORT` | `medium` | 只接受 `low`、`medium`、`high`，其他值拒絕啟動。 |
| `PA_MAX_TOKENS` | `8000` | 每次回覆的 `max_tokens`。 |
| `PA_ALLOWED_ORIGINS` | `http://localhost:5173` | CORS 允許的前端來源，以逗號分隔。經 Vite proxy 呼叫 `/api` 時是同一個來源，用不到；前端和 API 分開部署時要設成前端的網址。 |
| `PA_CLIENT_IP_HEADER` | 未設定 | 反向代理放真實 client IP 的標頭名稱；目前的對外試用設成 `cf-connecting-ip`。見表格下方的說明。 |
| `PA_CHAT_RATE_COUNT` | `30` | 每個 client 在 `PA_CHAT_RATE_WINDOW` 內最多送幾次 `/api/chat`，超過回 429（在讀取 body 之前就擋下）。 |
| `PA_CHAT_RATE_WINDOW` | `600`（秒） | 上面那個限流的視窗。 |
| `PA_MAX_CONCURRENT_CHATS` | `2` | 全站同時進行的 Claude 呼叫上限，滿了回 503。能分辨個別 client 時，每個 client 同時只能有 1 個。 |
| `PA_MAX_USER_TURNS` | `20` | 每段對話使用者最多發言幾次（工具結果不算）。 |
| `PA_MAX_CHARS` | `60000` | 整段對話的文字量上限，兩種都檢查：字數（Unicode 字元數）不超過這個值，UTF-8 位元組不超過它的 3 倍（預設 180000）。超過回 413。 |
| `PA_CHAT_MAX_BODY_BYTES` | `262144`（256 KiB） | `/api/chat` 請求 body 的位元組上限（最小 16384），在解析之前就擋下。對話會原樣帶著每一輪 thinking 的 signature，很長的對話被擋（「這段對話太長了」）時可調高。 |
| `PA_USD_BUDGET` | `1.0` | 全站在 `PA_USAGE_WINDOW_SECONDS` 內的總花費上限（美元），用完後 `/api/chat` 回 429。設成 0 等於停用對答。 |
| `PA_USAGE_WINDOW_SECONDS` | `18000`（5 小時） | 用量上限的滾動視窗（秒），全站額度和每個 client 的子額度共用。後端用量已滿時回的 429 訊息會跟著這個值顯示（例如「這 2 小時」）；但前端用量條的「5 小時」文字是固定的，改這個值時，畫面文字不會跟著變。 |
| `PA_CLIENT_BUDGET_FRACTION` | `0.2` | 每個 client 在同一個視窗內最多可用全站額度的比例（0.01–1）。見表格下方的說明。 |
| `PA_PRICE_TABLE` | 未設定 | 價格表（JSON，每百萬 tokens 的美元），覆寫或新增 `api/usage.py` 的 `DEFAULT_PRICES`。見表格下方的說明。 |
| `PA_LOG_DAILY_LIMIT` | `500` | 每天（UTC）最多新增幾筆匿名作答，超過回 429。重送同一份作答會覆蓋原本那一筆，不會被每日上限擋下；但跨日重送時，那一筆的日期會改成當天，因此算進當天的筆數。 |
| `PA_DATA_PATH` | `web/src/generated/data.json` | 題庫與立場資料（`scripts/build_data.py` 的輸出）。啟動時檔案不存在或讀不進來就拒絕啟動；之後檔案改變時自動重新載入。 |
| `PA_LOG_DB_PATH` | `api/answers.sqlite3` | 匿名作答資料庫（格式見 `docs/data-schema.md`）。 |
| `PA_USAGE_DB_PATH` | `api/usage.sqlite3` | 全站用量紀錄（只有時間戳與金額），重啟後延續。 |

- **`PA_CLIENT_IP_HEADER`**：標頭的值必須是合法的 IP，否則改用連線的來源位址；IPv6 以 /64 為單位。只有在後端只能經 cloudflared → Vite 連到時才可信：Cloudflare 會覆寫這個標頭，外面的人改不了；但能直接連到 Vite 或後端的人（例如本機的其他程式）可以自己填，換成別的限流 key，所以前後端都只綁 127.0.0.1。沒設定時用連線的來源位址：經本機代理（Vite、cloudflared）進來的人會共用同一個限流 key，每個 client 的子額度與「同時 1 個」的限制也不會套用（以免變成全站上限），啟動時會印警告。不支援 `X-Forwarded-For`（使用者可以自己填），uvicorn 要加 `--no-proxy-headers`。
- **`PA_CLIENT_BUDGET_FRACTION`**：預設 0.2 × $1 = 每 5 小時 $0.20。以目前的 system prompt 估算，一次請求約 $0.016（快取命中）到 $0.085（未命中），大約等於每 5 小時、每個 IP 10 次上下的請求（快取失效時更少；回應 Claude 的建議卡、送回結果也算一次）。同一個公網 IP（電信 CGNAT、辦公室）或同一個 IPv6 /64 的人共用這份額度。要放寬就調高這個比例（例如 `PA_CLIENT_BUDGET_FRACTION=0.5`，次數大致等比例增加到 25 次上下），或調高 `PA_USD_BUDGET`（全站和每個 client 的額度一起變大），加在後端的 `env -i` 後面再重啟。只在能分辨個別 client 時套用（見 `PA_CLIENT_IP_HEADER`）。子額度只存在記憶體，重啟後歸零。
- **`PA_PRICE_TABLE`**：格式是 `{"模型": {"input": …, "output": …, "cache_write": …, "cache_read": …}}`。覆寫既有的模型時可以只給要改的欄位；新增模型時四個欄位都要給。不是 JSON 物件、缺欄位、負數或有不認得的欄位時拒絕啟動。回覆的模型不在價格表裡時，每個欄位改用全表的最高價格計算，並印警告。
- **檔案位置**：相對路徑以啟動時的工作目錄為準（預設值固定在 repo 裡，和工作目錄無關）。資料庫檔不存在時以 0600 建立，已存在但其他帳號讀得到時改回 0600；所在目錄不存在時以 0700 建立。建議放在 0700 的專用目錄，作答與用量兩個資料庫最好分開放。
- **固定的上限**（改程式才能調整）：`/api/log` 每個 client 每小時 5 次；請求 body 上限 `/api/log` 64 KiB、其他路徑 16 KiB，寫入資料庫的單筆作答 32 KiB；Claude 呼叫逾時 300 秒，失敗時最多重試 1 次。

## 對外開放（Cloudflare Tunnel，給朋友試用）

### 1. 建立登入帳密

請在自己的終端機（bash）執行，不要交給 Claude 代跑，也不要把密碼貼進對話：

```bash
mkdir -p .keys && chmod 700 .keys
openssl rand -base64 24   # 產生一組 32 字元的密碼；只顯示在畫面上，不會進 shell history
( umask 077; read -rp '帳號: ' u && read -rsp '密碼（至少 16 字元）: ' p && echo && [ -n "$u" ] && [ ${#p} -ge 16 ] && [[ $u != *:* ]] && printf '%s:%s\n' "$u" "$p" > .keys/site_login && chmod 600 .keys/site_login ) || echo '未寫入 site_login'
```

- 帳號也請用不好猜的字串。密碼少於 16 字元（弱密碼）時，啟動時會印警告；用弱密碼登入後只會看到「修改密碼」頁，改成 16 字元以上的密碼之前，頁面、原始碼、`/api` 都進不去。密碼空白或格式不對時一律拒絕登入。
- 登入後也可以在網頁上改密碼：開 `/__password`（網站底部「修改密碼」），輸入目前的密碼和新密碼（16～256 字元，不能有換行、前後空白）。新密碼會直接寫回 `.keys/site_login`（權限 600），其他裝置的登入立刻失效。猜「目前的密碼」和登入共用同一組限流。
- 在子殼層裡設 `umask 077`：新建立的檔案一建立就是 600，umask 也不會留在原本的 shell。umask 只管新檔案，檔案原本就存在時，寫入後的 `chmod 600` 會把權限收回 600。沒有輸入或格式不對時，不會覆寫現有的檔案。
- 也可以用 `install -m 600 /dev/null .keys/site_login && vim .keys/site_login`，內容是一行「帳號:密碼」。

### 2. 啟動

目前的做法：後端、前端（build + preview）、cloudflared 各開一個終端機，都從專案根目錄執行。前後端都只綁 127.0.0.1，外部連線一律經 Cloudflare Tunnel 進來：cloudflared → 前端 `127.0.0.1:5173`（登入閘道）→ `/api` 由 Vite 轉給後端 `127.0.0.1:8000`。

事先要照〈本機開發〉建好 `api/.venv`、在 `web/` 跑過 `npm install`，並產生過 `web/src/generated/data.json`：`npm run public` 雖然也會重新產生，但後端先啟動時就要讀這個檔案。

```bash
# 後端：多帶 PA_CLIENT_IP_HEADER，限流與每個 client 的額度才會用 Cloudflare 給的真實 IP
cd api && env -i PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 \
  PA_ANTHROPIC_API_KEY_FILE=../.keys/claude_api.key PA_CLIENT_IP_HEADER=cf-connecting-ip PA_CLAUDE_EFFORT=medium \
  .venv/bin/uvicorn app:app --no-access-log --no-proxy-headers --host 127.0.0.1 --port 8000

# 前端：build + preview。先跑 npm run build，再同時執行 vite build --watch 與 PUBLIC_DEV=1 vite preview
cd web && env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$HOME" LANG=C.UTF-8 npm run public

# 通道：印出 https://xxx.trycloudflare.com
env -i HOME="$HOME" "$(command -v cloudflared)" tunnel --no-autoupdate --url http://127.0.0.1:5173
```

- **build + preview（`npm run public`）**：沒有 HMR、`/@fs`、原始碼轉譯與 `/__open-in-editor`，攻擊面比開發伺服器小很多。存檔後幾秒內自動重新 build，瀏覽器要手動重新整理；修改 `data/` 後要另外跑 `python3 scripts/build_data.py`。Ctrl-C 會同時停止 watch 與 preview。
- 前端也可以改用開發伺服器（目前沒有使用）：`cd web && env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$HOME" LANG=C.UTF-8 PUBLIC_DEV=1 npx vite --host 127.0.0.1 --port 5173 --strictPort`。為了安全已關掉 WebSocket 與 HMR（WebSocket 不經過登入閘道），改完程式一樣要手動重新整理。
- 兩種模式都會開啟登入閘道（`web/auth-plugin.ts`）：頁面、原始碼、`/api` 都要登入；`.keys/site_login` 不存在或格式不對時一律拒絕；密碼不足 16 字元時登入後只能改密碼。所有 WebSocket 連線都會被拒絕。
- 只能綁 127.0.0.1：用 `--host 0.0.0.0` 或區網 IP 啟動時，前端會直接拒絕啟動。需要從區網連時，改用 SSH 本機轉發（`ssh -L 5173:127.0.0.1:5173 …`）。
- 登入 cookie 有效 12 小時，只在 HTTPS 下送出（`Secure`）；登入嘗試每個 IP 每 15 分鐘最多 10 次、全站 30 次。有人故意把全站次數用完時，新的登入要等 15 分鐘，已登入的人不受影響。
- 每個回應都帶 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`，不能被其他網站嵌入。
- 要讓所有人登出：改 `.keys/site_login`（例如換密碼，或在 `/__password` 改），所有舊 cookie 立刻失效，不用重啟；或刪除 `.keys/session_secret` 再重啟前端（會自動產生新的）。自己登出：開 `/__logout` 按「登出」。
- `.keys/session_secret` 只能是 hex（至少 64 字元，例如 `openssl rand -hex 32` 的輸出），格式不對時前端拒絕啟動；要輪替就刪掉檔案再重啟。`.keys` 目錄應為 700、裡面的檔案 600，權限太寬時啟動會印警告。
- vite 與 cloudflared 的 log 會包含外部送來的內容（例如請求路徑），請當作不可信的資料，不要照 log 內容執行指令。
- 快速通道（trycloudflare.com）的網址每次重啟 cloudflared 都會變；要固定網址需綁定 Cloudflare 帳號與網域。
- 正式公開時不要用開發伺服器：照 `docs/requirements.md` §9 做成靜態網站（`npm run build` 產出 `web/dist`，放到 Cloudflare Pages 或 Vercel）。`web/public/_headers` 是給 Cloudflare Pages 的安全標頭（含 CSP），部署時要在 `connect-src` 加上後端 API 的網域；Vercel 請改寫在 `vercel.json` 的 `headers`。

## 立院投票紀錄

網站的「立院投票紀錄」頁（`#/votes`）列出：
- 和題目相關的精選表決（`data/votes.yaml`），附白話說明與相關題目；
- 第 10、11 屆全部記名表決，可用法案名稱或立委姓名搜尋。

每筆都有各黨票數、逐人名單與立法院公報原文連結。更新資料（在專案根目錄執行）：

```bash
python3 scripts/ly_votes.py          # 下載議事錄（快取於 build/ly_cache）並輸出 data/ly/votes.json
python3 scripts/build_data.py
```

資料來源為立法院議事暨公報資訊網，透過 g0v 立法院 API（ly.govapi.tw）取得議事錄文字檔。`ly_votes.py` 只從 `ly.govapi.tw` 與 `lydata.ronny-s3.click` 以 https 下載；上游欄位（會議代碼、議事錄網址、公報連結、日期）不符合預期時，會列出有問題的會議並中止，不會下載議事錄，也不寫入任何檔案。這部分的測試在 `api/test_ly_votes.py`（不連網）。

## 隱私設計

- 計分全在瀏覽器。作答進度只存在這個分頁的 sessionStorage（顯示偏好，例如各軸權重，存在 localStorage），不會上傳。
- 匿名作答（`/api/log`）要使用者勾選才送出，勾選框預設不勾。只存：作答與重要度（含補充題）、城市與預算分配、對答中套用的修正（只有題號和選項，不含理由文字）、作答模式（完成思辨旅程時另含第一輪的答案，以及是否看過結果才進行）、題庫版本，以及收到的日期（UTC，只記到「日」）。
- 每一輪作答有一個前端隨機產生的 `submission_id`（UUID v4），只用來讓重送時覆蓋同一筆：資料庫只存它的 SHA-256 當主鍵，不存原值；同一輪再送一次是覆蓋原本那一筆，不會多一筆。資料表沒有自動編號（`WITHOUT ROWID`），除了日期之外不記錄送出的先後順序。因為不記名，送出後無法依個人刪除。
- 作答與用量兩個資料庫檔的權限都是 0600；作答資料庫開啟 `secure_delete`，覆蓋或刪除的內容會被清零。
- 後端不記錄 IP、User-Agent、cookie 或對話內容（前提是照上面用 `env -i` 啟動：Anthropic SDK 的 `ANTHROPIC_LOG=debug` 會把請求內容寫進 log，見〈後端設定〉）。對答內容會經後端轉給 Anthropic 產生回覆，但後端不存檔；每段對話另有一個隨機 id，只當作 `metadata.user_id` 傳給 Anthropic，也不存檔。用量資料庫只有「時間戳 + 金額」。呼叫 Anthropic 失敗時，log 只記錯誤類型、代碼與 request id，不記錯誤訊息原文。
- 限流與每個 client 的用量子額度需要分辨 client：IP（IPv6 取 /64）只以 HMAC 雜湊的形式存在記憶體，不寫入資料庫或 log；HMAC 的鹽在每次啟動時隨機產生，也不寫入任何地方。最後一次使用後超過各自的視窗（對答限流預設 10 分鐘、作答上傳 1 小時、用量子額度預設 5 小時）就清掉，後端每分鐘清一次；重啟後全部消失。
- uvicorn 以 `--no-access-log` 執行，不輸出記有 IP 的 access log；`--no-proxy-headers` 讓它不採用使用者可以偽造的 `X-Forwarded-For`。
- 對外試用時的登入閘道（`web/auth-plugin.ts`）為了限制登入嘗試次數，會把來源 IP 記在記憶體裡最多約 15 分鐘，不寫入檔案；登入成功就刪掉。

## Claude 設定

- 模型預設 `claude-sonnet-5-5`，effort 預設 `medium`；可用 `PA_CLAUDE_MODEL`、`PA_CLAUDE_EFFORT` 調整，effort 只接受 `low`、`medium`、`high`。不再讀取沒有前綴的 `CLAUDE_MODEL`、`CLAUDE_EFFORT`：Claude Code 會在自己的環境 export 同名的 `CLAUDE_EFFORT`，從它的 shell 重啟後端時會被悄悄帶進來。啟動指令請照上面用 `env -i`，並明寫 `PA_CLAUDE_EFFORT=medium`。
- 已啟用伺服器端 refusal fallback（`fallbacks: "default"`）。被拒的那次嘗試也會計費，一樣算進用量。
- **用量上限**：全站在 `PA_USAGE_WINDOW_SECONDS`（預設 5 小時）滾動視窗內最多花 `PA_USD_BUDGET`（預設 $1）；每個 client 另有子額度（全站額度的 `PA_CLIENT_BUDGET_FRACTION`，預設 0.2，約每 5 小時 10 次請求，見〈後端設定〉）。每次問答依實際 token 用量與價格表（`PA_PRICE_TABLE`，預設值在 `api/usage.py`）換算成美元；花費要等回覆後才知道，同時進行的幾次呼叫可能讓用量稍微超過上限。達到上限後 `/api/chat` 回 429。前端只顯示全站用量的百分比（`GET /api/usage`），每 10 秒更新一次（分頁在背景時暫停），每次對答回覆後也會立即更新。全站用量紀錄（只有時間戳 + 金額）存在 `PA_USAGE_DB_PATH`（預設 `api/usage.sqlite3`），重啟後延續。限流與子額度都在記憶體裡，後端請用單一 worker 執行。
- 請在 Anthropic Console 設定每月預算上限。

## 授權

BSD 3-Clause，見 `LICENSE`。
