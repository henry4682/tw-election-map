# tw-election-map

台灣選舉地圖：前端互動塗色預測地圖。純 HTML/CSS/JS，沒有 build 工具（沒有 npm/Vite），Alpine.js 跟 MapLibre GL JS 都用 CDN 載入。架構參考 [jacksonjude/USA-Election-Map](https://github.com/jacksonjude/USA-Election-Map)——那個專案也是純靜態頁面，資料直接吃預先匯出的 CSV/SVG 檔案，瀏覽器端解析，完全沒有後端 API。

**上線網址**：https://henry4682.github.io/tw-election-map/

這是主專案（後端 Laravel/Filament ETL、行政區界編輯工具，維持私有）的**前端獨立鏡像**，專門給 GitHub Pages 用。原始開發在主 repo 進行，這裡是定期同步過來、含實際資料的發布用版本。

## 目錄結構

- `index.html`：入口頁面
- `js/app.js`：Alpine 元件（地圖初始化、互動邏輯）
- `css/style.css`：手寫 CSS，沒有用框架
- `data/`：靜態資料檔案（GeoJSON 邊界 + 候選人/得票資料），由主專案後端的 `election:export-*` 系列指令產生
- `test/`：`node:test` 單元測試 + Playwright e2e smoke test（見下方「測試」）

## 執行方式

沒有 build 步驟，直接用任一個簡單的本機 HTTP server 開（用 `file://` 直接開瀏覽器可能會因為 CORS 擋掉 `fetch()` 讀 `data/` 底下的檔案，一律用 http-server 開）：

```bash
npx http-server
```

## 測試

`js/app.js` 裡不摸 DOM/MapLibre 的純函式（tooltip 格式化、投影座標換算、資料轉換等）用 Node 內建的 `node:test` 測試，沒有另外裝 Jest/Vitest 這類套件——跟這個前端「沒有 build 工具」的原則一致，`test/` 底下的測試檔可以直接 `require('../js/app.js')`（檔案末尾的 `module.exports` 只在 Node 環境生效，瀏覽器裡的 `<script>` 標籤載入方式不受影響）。

```bash
node --test "test/*.test.js"
```

⚠️ 一定要用引號包住 glob、明確指定檔名樣式——不能只給資料夾路徑（`node --test test/`），也不能完全不給參數（`node --test`）。

會建立 DOM 元素或操作 MapLibre 實例的函式、Alpine 元件本身的響應式綁定不在這裡測，那些需要真的瀏覽器環境，用 `test/e2e/` 底下的 Playwright smoke test：

```bash
cd test/e2e
npm install
npm test
```

## 部署：GitHub Pages

這個 repo 直接用 GitHub Pages 從 `main` branch 根目錄部署（Settings → Pages → Source: Deploy from a branch → `main` / `/root`），沒有額外的 build/發布腳本——repo 本身就是可以直接服務的靜態內容，`data/` 底下是真的資料檔案（不是像主 repo 那樣用 `.gitignore` 排除）。

因為資料檔案（村里層級歷屆選舉幾何+得票）動輒 10+MB，整個 `data/` 目前約 600MB，每次資料更新（重新執行匯出指令）都會讓這個 repo 的 git 歷史再增加一次同等量級的變更——這是刻意接受的取捨：資料只在需要更新時才重新整批同步一次，不是高頻操作。

主專案另外也部署在 Cloudflare Workers Static Assets（https://tw-election-map.henry194557.workers.dev），兩邊並存，各自獨立更新。

## 資料更新

資料由主 repo 後端的 `election:export-*` 系列指令產生，這裡只是同步過來的靜態拷貝。更新流程（在主 repo 那邊操作）：

1. 在主 repo 的 `laravel_app/` 底下跑完想發布的 `election:export-*` 指令，確認 `frontend/data/` 內容正確。
2. 把主 repo `frontend/` 的內容（程式碼 + `data/*.json`）整份同步過來這個 repo，commit、push。

目前是手動同步（複製檔案+commit），還沒有自動化腳本；如果更新頻率變高，值得比照主 repo 的 `scripts/publish-frontend.sh`（用 `git worktree` 同步到 deploy 分支的做法）另外寫一個同步腳本。

## 資料來源與授權

本專案（程式碼）採用 [MIT License](LICENSE)。地圖上顯示的資料本身不是本專案原創產出，來源如下：

- **選舉開票資料**：[中央選舉委員會（CEC）選舉資料庫](https://data.cec.gov.tw/) 公開的歷屆選舉原始資料（`votedata.zip`），屬政府公開資料，依中選會網站公告的開放資料授權條款使用；本專案僅做資料整理、彙總與視覺化呈現，未變更原始得票數字（詳見主專案 `laravel_app/README.md` 的 ETL 說明）。
- **行政區界圖資（GeoJSON）**：來源為內政部國土測繪中心村里界圖，經 [dkaoster/taiwan-atlas](https://github.com/dkaoster/taiwan-atlas) 專案轉製後取用；使用條款請參照該專案本身標示的授權。

如對資料授權範圍或引用方式有疑慮，請以中選會、內政部國土測繪中心及 taiwan-atlas 專案各自公告的條款為準；本 README 的說明僅供快速理解來源，不構成法律意見。
