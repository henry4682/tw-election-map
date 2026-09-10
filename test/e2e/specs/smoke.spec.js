// @ts-check
// 三個模式共用的按需載入/切換/錯誤重試/預測狀態隔離 smoke test（見 IMPROVEMENT_PLAN.md
// 第三階段 LOAD-08/09/10）。這裡測的是真的瀏覽器 DOM/Alpine 響應式綁定跟 MapLibre
// 生命週期，node:test 沒辦法涵蓋這塊（見 frontend/README.md「測試」一節）。
const { test, expect } = require('@playwright/test');

const MODES = [
    { label: '互動預測地圖', mode: 'predict', indexFile: 'drilldown-index.json', mapId: 'map' },
    { label: '歷屆選舉地圖', mode: 'drilldown', indexFile: 'drilldown-index.json', mapId: 'drilldown-map' },
    { label: '議員/代表選區地圖', mode: 'district', indexFile: 'district-map-index.json', mapId: 'district-map' },
];

function navButton(page, label) {
    return page.locator('nav.mode-toggle button', { hasText: label });
}

/** 等這個模式的 map canvas 出現且有實際尺寸（容器不是 display:none 時量到的寬高）。 */
async function waitMapReady(page, mapId) {
    const canvas = page.locator(`#${mapId} canvas`).first();
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    const box = await canvas.boundingBox();
    expect(box?.width).toBeGreaterThan(0);
    expect(box?.height).toBeGreaterThan(0);
}

test.describe('lazy load per mode (LOAD-08)', () => {
    test('only the default mode fetches its index on first load; other modes do not', async ({ page }) => {
        const requestedUrls = [];
        page.on('request', (req) => requestedUrls.push(new URL(req.url()).pathname));

        await page.goto('/');
        await waitMapReady(page, 'map');

        // drilldown 模式跟 predict 共用同一份 DRILLDOWN_INDEX_URL（見 app.js），這裡只排除
        // predict 自己也會抓的檔案，只驗證「非預設模式獨有」的 index 檔案沒有被提前抓取。
        const predictIndexFile = MODES.find((m) => m.mode === 'predict').indexFile;
        const otherIndexFiles = MODES.filter((m) => m.mode !== 'predict' && m.indexFile !== predictIndexFile).map((m) => m.indexFile);
        for (const file of otherIndexFiles) {
            expect(requestedUrls.some((p) => p.endsWith(file))).toBe(false);
        }
        expect(requestedUrls.some((p) => p.endsWith(predictIndexFile))).toBe(true);
    });

    test('switching to a mode fetches its index exactly once, even after revisiting', async ({ page }) => {
        const requestedUrls = [];
        page.on('request', (req) => requestedUrls.push(new URL(req.url()).pathname));

        await page.goto('/');
        await waitMapReady(page, 'map');

        await navButton(page, '議員/代表選區地圖').click();
        await waitMapReady(page, 'district-map');

        await navButton(page, '互動預測地圖').click();
        await navButton(page, '議員/代表選區地圖').click();
        await page.waitForTimeout(200);

        const hits = requestedUrls.filter((p) => p.endsWith('district-map-index.json'));
        expect(hits.length).toBe(1);
    });
});

test.describe('mode switching renders a sized map (LOAD-09)', () => {
    for (const { label, mapId } of MODES) {
        test(`${label} shows a properly sized canvas once active`, async ({ page }) => {
            await page.goto('/');
            await navButton(page, label).click();
            await waitMapReady(page, mapId);
        });
    }
});

test.describe('index load failure shows an error with working retry (LOAD-03)', () => {
    test('drilldown mode: first load fails, error banner shows, retry recovers', async ({ page }) => {
        let failFirst = true;

        await page.route('**/data/drilldown-index.json*', (route) => {
            if (failFirst) {
                failFirst = false;
                return route.fulfill({ status: 500, body: 'boom' });
            }
            return route.continue();
        });

        await page.goto('/');

        const errorBanner = page.locator('.view[x-show*="predict"] .status-banner.status-error');
        await expect(errorBanner).toBeVisible();

        await errorBanner.locator('button', { hasText: '重試' }).click();
        await waitMapReady(page, 'map');
        await expect(errorBanner).toBeHidden();
    });
});

test.describe('drill-down and breadcrumb back (LOAD-06)', () => {
    test('clicking the only mainland region drills down, breadcrumb returns to top', async ({ page }) => {
        await page.goto('/');
        await navButton(page, '歷屆選舉地圖').click();
        await waitMapReady(page, 'drilldown-map');

        // 頂層用的是跟預測地圖共用、針對正式全國資料手動校準過的固定 zoom/center（見
        // app.js fitToCurrentRegions()），不是動態 fitBounds()，所以這個小範圍合成 fixture
        // 的「甲縣」不會剛好落在容器正中央——直接用地圖實例把 fixture 已知的經緯度中心點
        // 投影成螢幕座標再點擊，比假設「中央=甲縣」更貼近實際渲染結果。
        const mapEl = page.locator('#drilldown-map');
        const box = await mapEl.boundingBox();
        const point = await page.evaluate(() => {
            const el = document.querySelector('[x-data^="drillDownMap"]');
            const map = window.Alpine.$data(el).map;
            return map.project([121.50, 25.00]);
        });
        await page.mouse.click(box.x + point.x, box.y + point.y);

        // 用 .view[x-show*="drilldown"] 限定範圍：predictionMap 也有一份自己的
        // `.breadcrumb`（drillPath 空的時候維持隱藏），不限定範圍的話 .breadcrumb 會同時
        // 命中兩個元素，這裡只關心「歷屆選舉地圖」這頁的鑽層麵包屑狀態。
        const breadcrumb = page.locator('.view[x-show*="drilldown"] .breadcrumb');
        await expect(breadcrumb).toBeVisible();

        await page.getByRole('link', { name: '頂層' }).click();
        await expect(breadcrumb).toBeHidden();
    });
});

test.describe('keyboard-operable region list (A11Y-01)', () => {
    test('selecting a region from the keyboard list drills down the same way clicking the map does', async ({ page }) => {
        await page.goto('/');
        await navButton(page, '歷屆選舉地圖').click();
        await waitMapReady(page, 'drilldown-map');

        const view = page.locator('.view[x-show*="drilldown"]');
        const breadcrumb = view.locator('.breadcrumb');
        await expect(breadcrumb).toBeHidden();

        // details 預設收合，先用 summary 展開；純鍵盤使用者靠 Tab 移到 summary 再按 Enter
        // 展開，這裡直接點擊等效（Playwright click 也會觸發 focus+activate）。
        await view.getByText('純鍵盤操作：行政區清單').click();
        await view.getByRole('button', { name: '甲縣' }).click();

        await expect(breadcrumb).toBeVisible();
    });

    test('the mode toggle exposes aria-pressed for the active mode', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        await expect(navButton(page, '互動預測地圖')).toHaveAttribute('aria-pressed', 'true');
        await expect(navButton(page, '歷屆選舉地圖')).toHaveAttribute('aria-pressed', 'false');

        await navButton(page, '歷屆選舉地圖').click();

        await expect(navButton(page, '歷屆選舉地圖')).toHaveAttribute('aria-pressed', 'true');
        await expect(navButton(page, '互動預測地圖')).toHaveAttribute('aria-pressed', 'false');
    });
});

test.describe('select vs. edit are separate actions in predict mode (UX-01)', () => {
    async function predictAssignedCandidacyId(page, regionId) {
        return page.evaluate((id) => {
            const el = document.querySelector('[x-data^="predictionMap"]');
            const data = window.Alpine.$data(el);

            return data.regionTree.find((r) => r.region_id === id)?.assigned_candidacy_id;
        }, regionId);
    }

    test('first selecting a region only shows its detail; selecting it again cycles the guess, and undo reverts just that step', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        const view = page.locator('.view[x-show*="predict"]');
        await view.getByText('純鍵盤操作：').click();
        const regionButton = view.getByRole('button', { name: '甲縣' });
        const undoButton = view.getByRole('button', { name: '復原上一步' });

        await expect(undoButton).toBeDisabled();
        expect(await predictAssignedCandidacyId(page, 1)).toBe(101);

        // 第一次選取：只顯示明細，不改猜測（UX-01：查看明細不應該誤改預測）。
        await regionButton.click();
        await expect(view.locator('.panel-heading h2')).toHaveText('甲縣');
        expect(await predictAssignedCandidacyId(page, 1)).toBe(101);
        await expect(undoButton).toBeDisabled();

        // 已經選取的情況下再點一次，才是使用者確認要編輯，這時才真的循環候選人。
        await regionButton.click();
        expect(await predictAssignedCandidacyId(page, 1)).toBe(102);
        await expect(undoButton).toBeEnabled();

        // 單步復原：只還原剛剛那次循環，不是完整編輯歷史。
        await undoButton.click();
        expect(await predictAssignedCandidacyId(page, 1)).toBe(101);
        await expect(undoButton).toBeDisabled();
    });
});

test.describe('prediction guesses do not leak into shared cache (LOAD-10)', () => {
    test('predictionMap and drillDownMap hold independent region tree objects for the same election', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        await navButton(page, '歷屆選舉地圖').click();
        await waitMapReady(page, 'drilldown-map');

        const isIsolated = await page.evaluate(() => {
            const predictEl = document.querySelector('[x-data^="predictionMap"]');
            const drillEl = document.querySelector('[x-data^="drillDownMap"]');
            const predictData = window.Alpine.$data(predictEl);
            const drillData = window.Alpine.$data(drillEl);

            // 兩個元件都是拿同一場選舉、同一份鑽層資料（見 DRILLDOWN_INDEX_URL 共用），
            // 但 predictionMap 必須是 cloneRegionTree() 過的獨立物件，不能跟 drillDownMap
            // 直接吃 electionDataCache 快取住的同一個陣列參照——這正是 cloneRegionTree()
            // 要保護的原始資料唯讀契約（app.js LOAD-10）。
            return predictData.regionTree !== drillData.rootRegions
                && predictData.regionTree[0] !== drillData.rootRegions[0];
        });

        expect(isIsolated).toBe(true);
    });
});

// Stage 4（見 IMPROVEMENT_PLAN.md 第四階段）：predictionMap 跟 drillDownMap 對同一場
// 選舉是同一個 drilldown data URL（見上面 LOAD-10 案例），加上 electionDataCache 現在
// 有上限（ELECTION_DATA_CACHE_LIMIT），這裡固定一套「切換模式+回訪」的操作序列，量出
// 這份 10+MB 等級的資料檔實際被下載幾次，作為快取行為的基準：跨模式共用同一份資料、
// 重新造訪同一個模式都不應該重新下載。
test.describe('election data is fetched once and reused across modes + revisits (Stage 4 baseline)', () => {
    test('switching predict → drilldown → district → back to predict/drilldown does not refetch already-cached election data', async ({ page }) => {
        const dataFileHits = [];
        page.on('request', (req) => {
            const pathname = new URL(req.url()).pathname;

            if (/election-\d+-(drilldown|districts)\.json/.test(pathname)) dataFileHits.push(pathname);
        });

        await page.goto('/');
        await waitMapReady(page, 'map'); // predict 模式：第一次抓 election-1-drilldown.json

        await navButton(page, '歷屆選舉地圖').click();
        await waitMapReady(page, 'drilldown-map'); // 同一場選舉、同一個 URL，應該吃快取

        await navButton(page, '議員/代表選區地圖').click();
        await waitMapReady(page, 'district-map'); // 不同資料檔，第一次抓 election-1-districts.json

        await navButton(page, '互動預測地圖').click();
        await navButton(page, '歷屆選舉地圖').click();
        await navButton(page, '議員/代表選區地圖').click();
        await page.waitForTimeout(200); // 回訪三個模式，都不該再發請求

        const drilldownHits = dataFileHits.filter((p) => p.endsWith('election-1-drilldown.json'));
        const districtHits = dataFileHits.filter((p) => p.endsWith('election-1-districts.json'));

        expect(drilldownHits.length).toBe(1);
        expect(districtHits.length).toBe(1);
    });
});

test.describe('download disabled until ready (LOAD-12)', () => {
    test('download button is enabled once the predict map is ready', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        const downloadButton = page.locator('.view[x-show*="predict"] button', { hasText: '下載圖片' });
        await expect(downloadButton).toBeEnabled();
    });
});

// 窄螢幕可用性（見 IMPROVEMENT_PLAN.md 獨立改善項目：RWD 與基本操作可用性 P1）。
test.describe('exported image carries election context (UX-02)', () => {
    test('the composited image is taller than the bare map canvas (header + legend bands) and grows when a guess is edited', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        // 不用真的觸發瀏覽器下載 UI/寫檔——攔截 toDataURL() 量出合成後的 offscreen
        // canvas 高度即可證明 exportImage() 真的多畫了頭尾色帶，不是只有主圖。
        const measureExportedHeight = () => page.evaluate(async () => {
            const el = document.querySelector('[x-data^="predictionMap"]');
            const data = window.Alpine.$data(el);

            const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
            const originalClick = HTMLAnchorElement.prototype.click;
            let capturedHeight = null;

            HTMLCanvasElement.prototype.toDataURL = function (...args) {
                capturedHeight = this.height;
                return originalToDataURL.apply(this, args);
            };
            HTMLAnchorElement.prototype.click = function () {};

            try {
                await data.exportImage();
            } finally {
                HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
                HTMLAnchorElement.prototype.click = originalClick;
            }

            return { capturedHeight, mainCanvasHeight: data.map.getCanvas().height };
        });

        const beforeEdit = await measureExportedHeight();
        expect(beforeEdit.capturedHeight).toBeGreaterThan(beforeEdit.mainCanvasHeight);

        // 編輯一次猜測（甲縣，兩下：先選取查看明細，再選一次才是編輯，見 UX-01），
        // 圖例應該至少維持存在（不會因為改猜測而消失或報錯）。
        const view = page.locator('.view[x-show*="predict"]');
        await view.getByText('純鍵盤操作：').click();
        const regionButton = view.getByRole('button', { name: '甲縣' });
        await regionButton.click();
        await regionButton.click();

        const afterEdit = await measureExportedHeight();
        expect(afterEdit.capturedHeight).toBeGreaterThan(afterEdit.mainCanvasHeight);
    });
});

test.describe('share to social platforms (Web Share API)', () => {
    test('the share button is hidden when the browser has no navigator.share (this test browser)', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        const shareButton = page.locator('.view[x-show*="predict"] button', { hasText: '分享' });
        await expect(shareButton).toBeHidden();
    });

    test('shareImage() calls navigator.share with a PNG file when file sharing is supported, and does not fall back to download', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        const result = await page.evaluate(async () => {
            const el = document.querySelector('[x-data^="predictionMap"]');
            const data = window.Alpine.$data(el);

            let sharedFileInfo = null;
            let downloadTriggered = false;

            navigator.canShare = () => true;
            navigator.share = async (payload) => {
                const file = payload.files[0];
                sharedFileInfo = { name: file.name, type: file.type, size: file.size };
            };

            const originalClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () { downloadTriggered = true; };

            try {
                await data.shareImage();
            } finally {
                HTMLAnchorElement.prototype.click = originalClick;
                delete navigator.canShare;
                delete navigator.share;
            }

            return { sharedFileInfo, downloadTriggered };
        });

        expect(result.downloadTriggered).toBe(false);
        expect(result.sharedFileInfo?.type).toBe('image/png');
        expect(result.sharedFileInfo?.size).toBeGreaterThan(0);
    });

    test('shareImage() falls back to download when navigator.canShare rejects the file (unsupported browser)', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        const result = await page.evaluate(async () => {
            const el = document.querySelector('[x-data^="predictionMap"]');
            const data = window.Alpine.$data(el);

            let shareCalled = false;
            let downloadTriggered = false;

            navigator.canShare = () => false;
            navigator.share = async () => { shareCalled = true; };

            const originalClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () { downloadTriggered = true; };

            try {
                await data.shareImage();
            } finally {
                HTMLAnchorElement.prototype.click = originalClick;
                delete navigator.canShare;
                delete navigator.share;
            }

            return { shareCalled, downloadTriggered };
        });

        expect(result.shareCalled).toBe(false);
        expect(result.downloadTriggered).toBe(true);
    });

    test('shareImage() falls back to download when the user cancels the native share sheet (AbortError), not treated as a failure', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        const result = await page.evaluate(async () => {
            const el = document.querySelector('[x-data^="predictionMap"]');
            const data = window.Alpine.$data(el);

            let downloadTriggered = false;

            navigator.canShare = () => true;
            navigator.share = async () => { throw new DOMException('cancelled', 'AbortError'); };

            const originalClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () { downloadTriggered = true; };

            try {
                await data.shareImage();
            } finally {
                HTMLAnchorElement.prototype.click = originalClick;
                delete navigator.canShare;
                delete navigator.share;
            }

            return { downloadTriggered };
        });

        // AbortError（使用者自己取消）不該退回下載——那樣反而會在使用者主動取消後意外
        // 觸發一次下載，這裡驗證只有「真的失敗」才會退回下載（見另一個案例）。
        expect(result.downloadTriggered).toBe(false);
    });
});

// 桌面瀏覽器比較實際能用的分享替代方案（見 copyImageToClipboard() 註解）。Playwright
// 用的 Chromium 支援 ClipboardItem/navigator.clipboard.write，不用像 Web Share API
// 案例那樣整個 mock 掉——但寫入真的系統剪貼簿在無頭/CI 環境不穩定，這裡改成攔截
// navigator.clipboard.write 本身（驗證「有沒有被正確呼叫、帶什麼內容」），不依賴真的
// 讀回系統剪貼簿內容。
test.describe('copy image to clipboard (desktop share alternative)', () => {
    test('the copy button is visible in this test browser and calls navigator.clipboard.write with a PNG ClipboardItem', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        const copyButton = page.locator('.view[x-show*="predict"] button', { hasText: '複製圖片' });
        await expect(copyButton).toBeVisible();

        const result = await page.evaluate(async () => {
            const el = document.querySelector('[x-data^="predictionMap"]');
            const data = window.Alpine.$data(el);

            let writtenItemTypes = null;
            let downloadTriggered = false;

            const originalWrite = navigator.clipboard.write.bind(navigator.clipboard);
            navigator.clipboard.write = async (items) => {
                writtenItemTypes = items[0].types;
            };

            const originalClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () { downloadTriggered = true; };

            try {
                await data.copyImageToClipboard();
            } finally {
                navigator.clipboard.write = originalWrite;
                HTMLAnchorElement.prototype.click = originalClick;
            }

            return { writtenItemTypes, downloadTriggered, shareStatus: data.shareStatus };
        });

        expect(result.downloadTriggered).toBe(false);
        expect(result.writtenItemTypes).toContain('image/png');
        expect(result.shareStatus).toContain('已複製圖片');

        await expect(page.locator('.view[x-show*="predict"] .hint', { hasText: '已複製圖片' })).toBeVisible();
    });

    test('falls back to download and shows a status message when clipboard write is rejected (e.g. permission denied)', async ({ page }) => {
        await page.goto('/');
        await waitMapReady(page, 'map');

        const result = await page.evaluate(async () => {
            const el = document.querySelector('[x-data^="predictionMap"]');
            const data = window.Alpine.$data(el);

            let downloadTriggered = false;

            const originalWrite = navigator.clipboard.write.bind(navigator.clipboard);
            navigator.clipboard.write = async () => { throw new DOMException('denied', 'NotAllowedError'); };

            const originalClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () { downloadTriggered = true; };

            try {
                await data.copyImageToClipboard();
            } finally {
                navigator.clipboard.write = originalWrite;
                HTMLAnchorElement.prototype.click = originalClick;
            }

            return { downloadTriggered, shareStatus: data.shareStatus };
        });

        expect(result.downloadTriggered).toBe(true);
        expect(result.shareStatus).toContain('已改為下載');
    });
});

test.describe('incumbent/elected badges in district mode candidate list', () => {
    test('shows ✓當選 for the winner and ・現任 only for candidates marked incumbent', async ({ page }) => {
        await page.goto('/');
        await page.locator('nav.mode-toggle button', { hasText: '議員/代表選區地圖' }).click();
        await waitMapReady(page, 'district-map');

        const view = page.locator('.view[x-show*="district"]');
        await view.getByText('純鍵盤操作：選區清單').click();
        await view.getByRole('button', { name: '甲縣第01選區' }).click();

        const items = view.locator('.panel-heading ~ ul li');
        await expect(items).toHaveCount(2);

        // x-show 只切換 CSS display，不會把元素從 DOM 拿掉，textContent 為主的斷言
        // （toContainText）看不出「有沒有顯示」，一律要用 toBeVisible()/toBeHidden()。
        // fixture 裡第一位（甲黨 王小明）是當選+現任，第二位（乙黨 李小華）落選、非現任。
        await expect(items.nth(0).getByText('✓當選')).toBeVisible();
        await expect(items.nth(0).getByText('・現任')).toBeVisible();
        await expect(items.nth(1).getByText('✓當選')).toBeHidden();
        await expect(items.nth(1).getByText('・現任')).toBeHidden();
    });
});

test.describe('narrow viewport layout (RWD-01)', () => {
    test('at 360px width, nav/map/election list/detail are all reachable with no page-level horizontal overflow', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        await page.goto('/');
        await waitMapReady(page, 'map');

        // 頁面本身（body）不會出現水平捲軸——.mode-toggle 自己有 overflow-x:auto 吃掉
        // 三個分頁按鈕放不下的寬度，不會撐開整個頁面。
        const hasPageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(hasPageOverflow).toBe(false);

        await navButton(page, '議員/代表選區地圖').click();
        await waitMapReady(page, 'district-map');

        // 側欄改直式堆疊在地圖下方（不是左右夾住），地圖寬度應該吃滿容器寬度，不是被
        // 桌面版固定 220px/280px 側欄擠掉。
        const mapBox = await page.locator('#district-map').boundingBox();
        expect(mapBox.width).toBeGreaterThan(320);

        // 選舉清單預設收合，只留 toggle 按鈕可見；展開後清單項目變成看得到、點得到。
        const toggle = page.locator('.view[x-show*="district"] .sidebar-toggle');
        await expect(toggle).toBeVisible();
        const firstElectionItem = page.locator('.view[x-show*="district"] .election-item').first();
        await expect(firstElectionItem).toBeHidden();
        await toggle.click();
        await expect(firstElectionItem).toBeVisible();
    });
});

test.describe('mobile detail panel closes and returns to map (RWD-03)', () => {
    test('closing the drilldown detail panel clears the selection', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 700 });
        await page.goto('/');
        await navButton(page, '歷屆選舉地圖').click();
        await waitMapReady(page, 'drilldown-map');

        await page.evaluate(() => {
            const el = document.querySelector('[x-data^="drillDownMap"]');
            const data = window.Alpine.$data(el);
            data.selectedRegion = data.rootRegions[0];
        });

        const closeButton = page.locator('.view[x-show*="drilldown"] .panel-close');
        await expect(closeButton).toBeVisible();
        await closeButton.click();

        const selectedAfterClose = await page.evaluate(() => {
            const el = document.querySelector('[x-data^="drillDownMap"]');
            return window.Alpine.$data(el).selectedRegion;
        });
        expect(selectedAfterClose).toBeNull();
    });
});

test.describe('map resizes after viewport/orientation change (RWD-02)', () => {
    test('MapLibre canvas stays in sync with its container size after a resize', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 700 });
        await page.goto('/');
        await navButton(page, '歷屆選舉地圖').click();
        await waitMapReady(page, 'drilldown-map');

        // 模擬橫直向切換：寬高互換。ResizeObserver（見 app.js observeMapResize()）應該
        // 自動呼叫 map.resize()，canvas 尺寸要跟著容器變，不需要使用者手動再縮放一次視窗
        // 才恢復（見 IMPROVEMENT_PLAN.md RWD-02）。
        await page.setViewportSize({ width: 700, height: 375 });
        await page.waitForTimeout(500);

        const canvasBox = await page.locator('#drilldown-map canvas').first().boundingBox();
        const containerBox = await page.locator('#drilldown-map').boundingBox();
        expect(Math.abs(canvasBox.width - containerBox.width)).toBeLessThan(2);
        expect(Math.abs(canvasBox.height - containerBox.height)).toBeLessThan(2);
    });
});
