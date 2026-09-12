// IMPROVEMENT_PLAN.md 第四階段第 3 項：以下幾個型別涵蓋三個模式共用的資料形狀，給
// candidateColorFrom()/notableResultsOf()/pieChartSvgFor() 這類反覆被三個模式呼叫的
// 共用函式標註參數/回傳型別，取代原本「要嘛看 exporter 產出的 JSON、要嘛看呼叫端怎麼用」
// 才能知道形狀的狀態。只寫在共用純函式這層，不是要把整個檔案改成嚴格型別檢查（沒有導入
// TypeScript/JSDoc 型別檢查工具鏈，純粹當文件用，編輯器可以利用這些標註做基本的自動完成/
// 型別提示，但不會真的擋下型別不符的呼叫）。
/**
 * @typedef {Object} Candidate
 * @property {number} candidacy_id
 * @property {string} color - 合法色碼字串（見 isValidHexColor()），呼叫端不應假設
 *   一定是合法值——資料來源包含使用者可控的自訂政黨顏色，讀取時一律經
 *   candidateColorFrom() 過濾，不要直接讀 .color。
 * @property {string} label - 顯示用名稱（通常是「政黨 候選人姓名」或候選人姓名）。
 * @property {string|null} [party_name] - 無黨籍或查無資料時為 null。
 */

/**
 * @typedef {Object} VoteResult
 * @property {number} candidacy_id
 * @property {number} votes
 */

/**
 * 鑽層/預測地圖共用的行政區節點形狀。predictionMap() 專用欄位（assigned_candidacy_id/
 * assigned_party）只存在於 cloneRegionTree() 複製出來的樹上，drillDownMap() 直接用
 * electionDataCache 裡唯讀的原始樹則不會有這兩個欄位（見 deepFreeze() 唯讀契約）。
 * @typedef {Object} RegionNode
 * @property {number} region_id
 * @property {string} name
 * @property {string|null} geometry_hash - 參照共用幾何表（見 fetchGeometriesFor()/
 *   geometryFor()）的內容雜湊，不是這個節點自己內嵌完整 GeoJSON geometry；少數行政區
 *   沒有幾何資料是 null（見 CLAUDE.md「地圖上看到白色色塊」已知資料缺口），呼叫端一律
 *   透過 geometryFor() 取得實際 geometry，不要直接讀這個欄位。
 * @property {VoteResult[]} results - 依票數 DESC 排序。
 * @property {number} actual_winner_candidacy_id
 * @property {number} [assigned_candidacy_id] - 僅 predictionMap() 的複製樹上會寫入。
 * @property {{party_name: string, color: string}|null} [assigned_party] - 同上，
 *   「指定政黨」跟 assigned_candidacy_id 是兩條互斥的上色路徑，見 colorFor() 註解。
 * @property {RegionNode[]|null} [children]
 */

/**
 * @typedef {Object} District
 * @property {number} district_id
 * @property {string} name
 * @property {string|null} geometry_hash - 見 RegionNode 的同名欄位註解。
 * @property {string} color
 * @property {number} total_seats
 * @property {{party_name: string|null, color: string, seats: number}[]} party_seats
 * @property {(Candidate & {votes: number, is_elected: boolean, is_incumbent: boolean|null, flipped: boolean|null})[]} candidates
 *   - is_incumbent/flipped 是 null 代表這筆候選資格是在後端補上這兩個欄位之前匯入的，
 *     或（flipped）找不到可比對的上一屆同類型選舉，都不是「確定不是現任/沒換人」，
 *     畫面上不要顯示成負面結果。
 */

// 各 index entry 都帶 content_hash（見對應的 election:export-* 指令 rebuildIndex()），
// 附加成 query string 版本號：資料沒變 hash 不變，正式部署設定長效 cache 時瀏覽器能沿用
// 快取；資料一改 hash 跟著變、URL 也跟著變，等同自動失效，不需要額外的快取清除流程。
// hash 沒有值（例如 index 是舊版沒有這個欄位、或找不到對應 entry）就不附加，退回原本
// 沒有版本號的 URL，行為不變。
const withVersion = (url, hash) => (hash ? `${url}?v=${hash}` : url);

const DRILLDOWN_INDEX_URL = 'data/drilldown-index.json';
const drillDownDataUrl = (id, hash) => withVersion(`data/election-${id}-drilldown.json`, hash);

const DISTRICT_MAP_INDEX_URL = 'data/district-map-index.json';
const districtMapDataUrl = (id, hash) => withVersion(`data/election-${id}-districts.json`, hash);

// 對應後端 ElectionResultsMapBuilder 的 SCHEMA_VERSION_* 常數，兩邊要一起改。
// 2：region/district 節點改成 geometry_hash 參照共用幾何表。
// 3：共用幾何表改成按縣市分片，頂層節點多一個 geometry_chunk 欄位（見
// fetchGeometriesFor()/geometryFor() 註解）。
const SCHEMA_VERSION_DRILLDOWN = 3;
const SCHEMA_VERSION_DISTRICT_MAP = 3;

// 鑽層地圖等選舉資料檔案動輒 10+MB（全國村里層級幾何+得票），使用者在幾個屆別之間
// 來回切換時不重新 fetch/解析同一份——只在這次瀏覽 session 的記憶體裡快取，重新整理
// 頁面就清空，不用 localStorage/IndexedDB 這類持久化儲存（單一檔案就超過 localStorage
// 額度，且沒有跨 session 保留的必要，換取的好處抵不過額外的持久化/失效管理複雜度）。
//
// IMPROVEMENT_PLAN.md 第四階段：原本這裡是不設上限的 Map，來回切換夠多屆別會讓記憶體
// 一直長。還沒有真的裝置/多場選舉的記憶體量測數字可以精算「多少最好」，這裡先抓一個
// 「一次瀏覽 session 通常不會同時仔細比較超過幾屆」的保守值，之後有實測數據再調整，
// 不假裝這是量測出來的最佳值。Map 的 key 插入順序拿來當「最近使用」順序：每次命中/
// 寫入都搬到最後，超過上限就砍最舊（最前面）的一筆。
const ELECTION_DATA_CACHE_LIMIT = 6;
const electionDataCache = new Map();

// 同一個 URL 可能被兩個模式在還沒等到第一次 fetch 完成前就都呼叫到（例如冷啟動時
// 使用者在預測地圖的預設選舉還在下載時就切去歷屆選舉地圖，兩邊預設選舉剛好相同、
// 對到同一個 drilldown data URL）——原本兩邊會分別發一次 10+MB 的請求。這裡讓同一個
// URL 進行中的請求共用同一個 promise，只有第一個呼叫端真的觸發 fetch。失敗不放進
// electionDataCache（沿用原本的行為），in-flight 記錄則不論成功失敗都要在 settle 後
// 清掉，不然失敗的 URL 會卡住、永遠不會重試。
const electionDataInFlight = new Map();

/** 命中或剛抓到資料都呼叫這個，把 url 搬到 Map 尾端（=最近使用），超過上限砍最舊的。 */
function touchElectionDataCache(url, data) {
    electionDataCache.delete(url);
    electionDataCache.set(url, data);

    while (electionDataCache.size > ELECTION_DATA_CACHE_LIMIT) {
        electionDataCache.delete(electionDataCache.keys().next().value);
    }
}

// content_hash（見 withVersion()）解決的是「同一種格式、資料內容變了」的快取失效問題；
// schema_version 解決的是不同問題——「格式本身變了」（後端 exporter 新增/移除/改名欄位），
// 讓這種情況能被明確發現，不會因為前端邏輯剛好沒讀到新欄位/剛好沒爆錯而靜默顯示錯誤或
// 不完整的畫面。只是 console.warn 不擋畫面：版本號通常代表「格式加了新東西」而非「舊
// 讀法完全失效」，多數情況下畫面還是能正常顯示大部分內容，貿然擋住整頁對使用者反而更糟。
function checkSchemaVersion(kind, data, expectedVersion) {
    if (data.schema_version !== undefined && data.schema_version !== expectedVersion) {
        console.warn(
            `[${kind}] 資料檔 schema_version=${data.schema_version}，前端預期 ${expectedVersion}，` +
            '資料格式可能已變更，畫面顯示的內容不保證完整，請確認前後端版本是否同步更新。'
        );
    }
}

/**
 * IMPROVEMENT_PLAN.md 第四階段第 3 項：electionDataCache 快取的是三個模式共用的同一份
 * 物件（見 fetchElectionData()），「原始資料不能被寫」這條契約原本只靠約定維持——
 * predictionMap() 記得用 cloneRegionTree() 複製一份才寫入猜測欄位，drillDownMap()/
 * districtMap() 只讀不寫——沒有東西會在真的不小心對著共用節點賦值時報錯，污染會悄悄
 * 發生在其他模式看到的資料上，不好排查。這裡在資料進快取前整棵深度凍結，讓這種誤寫
 * 直接失效——這個檔案是用一般 <script> 標籤載入（非 module、沒有 'use strict'），瀏覽器
 * 對凍結物件賦值的行為是「非嚴格模式下靜默失敗」而不是丟例外（同樣的程式碼放進
 * ES module 或加 'use strict' 才會丟 TypeError；這裡刻意不改成那樣，全域套用嚴格模式
 * 是更大範圍的行為改動，不屬於這次的最小變更）。看不到錯誤訊息，但至少能保證污染不會
 * 真的寫進共用快取、擴散到其他消費者看到的資料。凍結只設內部旗標不複製，對同一份資料，
 * 成本比 cloneRegionTree() 整棵複製還低，不是這裡量級的資料會壓垮的操作。
 */
function deepFreeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;

    Object.freeze(value);

    for (const key of Object.keys(value)) {
        deepFreeze(value[key]);
    }

    return value;
}

/**
 * 五個模式共用：index/選舉資料原本都是「fetch 完直接 .json()」，非 2xx 回應（404/500）
 * 不會被當成錯誤，之後對著 undefined/錯誤格式的資料操作才會出問題，而且是不好追查的
 * 症狀。統一在這裡檢查 res.ok，讓呼叫端能用一般的 try/catch 接住「載入失敗」這個情境，
 * 顯示看得懂的錯誤訊息，而不是放著 unhandled rejection 或畫面卡在「載入中」不動。
 */
async function fetchJsonOrThrow(url) {
    const res = await fetch(url);

    if (! res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    return res.json();
}

async function fetchElectionData(url, kind, expectedVersion) {
    if (electionDataCache.has(url)) {
        const data = electionDataCache.get(url);
        touchElectionDataCache(url, data);

        return data;
    }

    if (electionDataInFlight.has(url)) {
        return electionDataInFlight.get(url);
    }

    const request = fetchJsonOrThrow(url)
        .then((data) => {
            checkSchemaVersion(kind, data, expectedVersion);
            deepFreeze(data);
            touchElectionDataCache(url, data);

            return data;
        })
        .finally(() => {
            electionDataInFlight.delete(url);
        });

    electionDataInFlight.set(url, request);

    return request;
}

const GEOMETRIES_DIR = 'data/geometries';
const SCHEMA_VERSION_GEOMETRIES = 1;
const geometryChunkPromises = new Map(); // 分片 key（縣市名稱）=> Promise<Map<hash, geometry>>

/**
 * 幾何去重＋分片：drilldown/district 資料原本每個節點都直接內嵌自己的 GeoJSON
 * geometry，同一個村里/選區的形狀在 50+ 場選舉的匯出檔案裡幾乎逐字重複——量測過拿掉
 * 重複後，全部村里/選區形狀只佔原本大小的一小部分（見 IMPROVEMENT_PLAN.md 資料量測
 * 章節）。現在資料改成每個節點存 `geometry_hash` 參照共用幾何表，前端渲染前才 resolve
 * 回實際的 geometry。
 *
 * 這份共用表原本是單一一個 geometries.json（壓縮後 8MB+，累加了所有 65 場選舉曾經
 * 用過的形狀），不管使用者這次要看哪個選舉/縣市都得整份下載完才能畫圖——改成按縣市
 * 分片存放（frontend/data/geometries/<縣市>.json，見後端 DedupsGeometry trait），
 * 每個選舉頂層節點（regions/districts）自帶 `geometry_chunk` 欄位指出要抓哪一片。
 * fetchGeometriesFor() 只抓「這次載入的選舉實際會用到」的分片，平行下載，不用像以前
 * 那樣不管使用者要看哪裡都先付一次全國共用表的下載成本；已經抓過的分片會跨選舉/跨
 * session（頁面沒重整期間）快取，不重複下載。
 */
function fetchGeometryChunk(chunkKey) {
    if (! geometryChunkPromises.has(chunkKey)) {
        const url = `${GEOMETRIES_DIR}/${encodeURIComponent(chunkKey)}.json`;
        const promise = fetchJsonOrThrow(url).then((payload) => {
            checkSchemaVersion('geometries', payload, SCHEMA_VERSION_GEOMETRIES);

            const store = new Map(Object.entries(payload.geometries));

            deepFreeze(payload);

            return store;
        }).catch((e) => {
            // 失敗（常見是手機網路不穩）不能把 rejected promise 留在快取裡——不重設的話
            // 這個分片會永遠卡在失敗狀態，之後任何用得到這個縣市的選舉都救不回來，畫面
            // 卡死在「載入中」。重設成沒快取讓下一次呼叫重新發請求。
            geometryChunkPromises.delete(chunkKey);

            throw e;
        });

        geometryChunkPromises.set(chunkKey, promise);
    }

    return geometryChunkPromises.get(chunkKey);
}

/**
 * 從一份選舉資料的頂層節點（drilldown 的 regions／district-map 的 districts）找出
 * 各自標記的 geometry_chunk，去重回傳。往下鑽層看到的子節點（鄉鎮/村里）沒有自己的
 * geometry_chunk 欄位——它們跟頂層祖先歸在同一個分片，只要抓到頂層那些分片就夠了。
 * @param {{geometry_chunk?: string|null}[]} topLevelItems
 * @returns {string[]}
 */
function chunkKeysFor(topLevelItems) {
    return [...new Set(topLevelItems.map((item) => item.geometry_chunk).filter((key) => key))];
}

/**
 * 三個模式共用：抓齊某份選舉資料需要的所有幾何分片（平行下載），合併成單一個
 * hash → geometry 的 Map 回傳，呼叫端（geometryFor()）不用知道分片這件事、也不用改。
 * @param {{geometry_chunk?: string|null}[]} topLevelItems
 * @returns {Promise<Map<string, object>>}
 */
async function fetchGeometriesFor(topLevelItems) {
    const chunks = await Promise.all(chunkKeysFor(topLevelItems).map((key) => fetchGeometryChunk(key)));

    const merged = new Map();
    for (const chunk of chunks) {
        for (const [hash, geometry] of chunk) merged.set(hash, geometry);
    }

    return merged;
}

/**
 * 三個模式共用：把節點的 geometry_hash 解析成實際的 GeoJSON geometry。節點本來就沒有
 * 幾何資料（geometry_hash 是 null，見已知資料缺口）或查不到對應的 hash（理論上不會
 * 發生，除非資料損毀）都回傳 null，呼叫端沿用既有「geometry 是 null 就跳過這個節點」
 * 的處理方式，不需要另外分支。
 * @param {{geometry_hash?: string|null}} node
 * @param {Map<string, object>} geometryStore
 * @returns {object|null}
 */
function geometryFor(node, geometryStore) {
    return node.geometry_hash ? (geometryStore.get(node.geometry_hash) ?? null) : null;
}

/**
 * IMPROVEMENT_PLAN.md 第四階段第 4 項：三個模式的 loadElection() 開頭原本各自重複一段
 * 一模一樣的邏輯——遞增請求序號（見 LOAD-01/LOAD-02）、重置 switchError、fetch 資料、
 * 把「HTTP/JSON 失敗」跟「這次請求已經過期（使用者切去更新的一次）」分開處理，只有
 * fetchElectionData() 的 url/kind/expectedVersion 三個參數不同。抽出來讓三個模式共用，
 * 呼叫端看到回傳 null 就直接 return（代表過期或失敗、該做的錯誤狀態已經處理好了），
 * 拿到非 null 才繼續往下做各模式自己的資料指派跟地圖重建。
 *
 * 注意：呼叫端仍要在自己的資料指派完成後，若後續還有 await（目前三個模式都沒有），
 * 要自行再檢查一次 seq——這裡回傳前的檢查只保證「fetch 完成當下」還沒過期。
 */
async function loadElectionOrHandleError(component, url, kind, expectedVersion) {
    const seq = ++component._loadSeq;
    component.switchError = '';

    let data;
    try {
        data = await fetchElectionData(url, kind, expectedVersion);
    } catch (e) {
        if (seq !== component._loadSeq) return null;

        if (component.election) {
            // 已經有舊地圖顯示中：保留它，只顯示這次切換失敗的提示，不動 status。
            component.switchError = `切換失敗，目前仍顯示「${component.election.name}」的結果。`;
        } else {
            component.status = 'error';
            component.errorMessage = '選舉資料載入失敗，請檢查網路連線後重試。';
        }
        return null;
    }

    // 這次請求發起後,又有更新的一次 loadElection() 被觸發(使用者再次切換屆別)
    // ——這次已經過期,不能覆蓋較新請求寫入的狀態,直接放棄。
    if (seq !== component._loadSeq) return null;

    return data;
}

// 金門/連江離台灣本島太遠，跟主圖畫在同一個座標系裡會小到很難注意到——比照專案既有
// 靜態 SVG 地圖（ElectionResultsMapBuilder）的 inset 框做法，另外開小地圖獨立展示，
// 放在主圖的西北方（左上角）。
const INSET_COUNTIES = [
    { countyName: '金門縣', label: '金門' },
    { countyName: '連江縣', label: '馬祖' },
];

const INSET_BOX_SIZE_DESKTOP = 140;
const INSET_BOX_SIZE_MOBILE = 84;
const INSET_MOBILE_BREAKPOINT = 640;

// 手機版螢幕窄，140px 見方的金門/馬祖小圖框太佔畫面（尤其橫向兩個框並排時），窄螢幕
// 改用縮小版尺寸；子框（烏坵/東引這種遠方離島）跟間距照比例一起縮，不然縮小後主框裝
// 不下子框。用 getter 而非固定常數是因為要吃「當下」的 innerWidth，不能在模組載入時
// 就算死——使用者可能中途旋轉裝置或調整視窗。
function insetBoxSize() {
    return window.innerWidth < INSET_MOBILE_BREAKPOINT ? INSET_BOX_SIZE_MOBILE : INSET_BOX_SIZE_DESKTOP;
}

function insetSubBoxSize() {
    return window.innerWidth < INSET_MOBILE_BREAKPOINT ? 30 : 46;
}

function insetGap() {
    return window.innerWidth < INSET_MOBILE_BREAKPOINT ? 6 : 10;
}

// 鑽層地圖頂層行政區集合跟預測地圖一樣會混到金門/連江——差別是縣市長選舉頂層本身就是
// 「金門縣/連江縣」這兩筆，鄉鎮市長/原住民區長選舉頂層則直接是底下個別鄉鎮（沒有縣市
// 這層代稱可比對），用固定名單同時涵蓋兩種頂層粒度。行政區名稱在全國範圍內本來就不會
// 重複（村里以上的行政區劃分層級是唯一的），照名稱比對不會誤觸其他縣市同名行政區。
const DRILLDOWN_INSET_GROUPS = [
    { label: '金門', names: ['金門縣', '金城鎮', '金湖鎮', '金沙鎮', '金寧鄉', '烈嶼鄉', '烏坵鄉'] },
    { label: '馬祖', names: ['連江縣', '南竿鄉', '北竿鄉', '莒光鄉', '東引鄉'] },
];

/**
 * 鑽層結果地圖（drillDownMap）整合了村里長席次地圖/原住民選區地圖之後，election-{id}-
 * drilldown.json 裡有些選舉類型的「行政區」在某個深度以上其實不是同一場共用候選人名單的
 * 選舉——村里長每個村里各自獨立一場小選舉、原住民鄉鎮市民代表/區民代表每個鄉鎮市區各自
 * 獨立一場，往上（縣市/鄉鎮市區）看到的 results 只是後端 SQL 把不相干候選人的票數硬加在
 * 一起，數字沒有意義（見 ElectionResultsMapBuilder::drillDownExportDataFor() 的通用查詢
 * 邏輯，它不知道「這個 candidacy_id 只在這一個行政區出現過」）。
 *
 * 這裡記錄每種類型「往下第幾層開始才是同一場真的共用候選人名單的選舉」（0=頂層自己就是，
 * 不用特殊處理；1=鄉鎮市區層級開始才是；2=村里層級開始才是）。比這個深度淺的層級改用
 * aggregatePartyResults() 算「底下每個政黨贏了幾個單位」的多數決，不是直接讀 region.results。
 */
const DRILLDOWN_AGGREGATE_FROM_DEPTH = {
    village_chief: 2,
    township_representative_plains_indigenous: 1,
    indigenous_district_representative: 1,
};

/** predictionMap()/drillDownMap() 共用：在地圖容器裡疊一個 inset 用的定位框 DOM 元素。 */
function createInsetBox(parent, label, size, x, y, nested = false) {
    const el = document.createElement('div');
    el.className = nested ? 'inset-map inset-map--nested' : 'inset-map';
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    if (label) {
        const labelEl = document.createElement('span');
        labelEl.className = 'inset-label';
        labelEl.textContent = label;
        el.appendChild(labelEl);
    }

    parent.appendChild(el);

    return el;
}

/**
 * predictionMap()/drillDownMap() 共用：移除一組 inset MapLibre 實例跟它們動態產生的 DOM
 * 容器。inset 容器是執行期用 document.createElement 建立、掛在主圖容器底下的，不會因為
 * 換一份資料自動消失，一定要手動移除，不然每次切換屆別/鑽層 inset 框會越疊越多。
 */
function teardownInsetMaps(insetMaps) {
    for (const { map, container } of insetMaps) {
        map.remove();
        container.remove();
    }

    return [];
}

/**
 * predictionMap()/drillDownMap()/districtMap() 共用：主圖容器尺寸一變就叫 MapLibre
 * resize()，不然容器縮放後地圖畫布還停在舊尺寸（灰邊/裁切），使用者要手動縮放視窗一次
 * 才會恢復（見 IMPROVEMENT_PLAN.md RWD-02）。ResizeObserver 涵蓋所有會改變容器尺寸的
 * 情境——窄螢幕下收合/展開選舉清單或明細面板（見 RWD 版面）、手機橫直向切換、手機瀏覽器
 * 網址列出現/消失造成的動態視窗高度變化——不用在每個觸發點各自手動呼叫一次 resize()。
 * 用 requestAnimationFrame 併掉同一幀內的多次觸發，避免 resize 期間的中間尺寸也各自
 * 觸發一次 MapLibre 重繪。呼叫端要在換掉/銷毀 this.map 時 disconnect()，不然舊的
 * observer 會一直留著、對已經 remove() 的地圖實例呼叫 resize() 而噴例外。
 */
function observeMapResize(map, container) {
    if (typeof ResizeObserver === 'undefined' || ! container) return null;

    let pending = false;
    const observer = new ResizeObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            map.resize();
        });
    });

    observer.observe(container);

    return observer;
}

/**
 * IMPROVEMENT_PLAN.md 第四階段第 4 項：三個模式的 loadElection() 換屆別時都要整個重建
 * 地圖（不同選舉的層級/行政區集合不一樣，就地更新比重建更複雜），這段流程原本三個模式
 * 各自重複一份完全一樣的邏輯——清掉舊 inset、resize observer、舊 map 實例，蓋一個新的，
 * 等 'load' 事件才加資料來源/圖層/掛互動事件。只有 containerId、sourceId（圖層命名
 * 跟著它走，`${sourceId}-fill`/`${sourceId}-line`）、是否要 preserveDrawingBuffer
 * （只有預測地圖的下載圖片功能需要）、featureCollection 的算法，跟圖層/互動掛好之後
 * 還要做的收尾（各模式的 initInsetMaps()/fitToCurrentRegions() 呼叫順序）不同，抽成
 * 這裡統一處理，呼叫端只帶會變的部分進來。
 *
 * featureCollection 故意寫成呼叫時才算的 thunk，不是先算好的值：原本三個模式都是在
 * 'load' 事件裡才呼叫 this.featureCollectionFor(...)，這裡維持同樣的時序，不要求呼叫端
 * 在呼叫 rebuildMap() 之前就先把資料準備好。
 */
function rebuildMap(component, { containerId, sourceId, preserveDrawingBuffer = false, featureCollection, onLoaded }) {
    component.insetMaps = teardownInsetMaps(component.insetMaps);
    component._resizeObserver?.disconnect();

    if (component.map) {
        component.map.remove();
        component.map = null;
    }

    component.map = new maplibregl.Map({
        container: containerId,
        style: { version: 8, sources: {}, layers: [] },
        center: [121, 23.7],
        zoom: 6.8,
        // preserveDrawingBuffer: true 是「下載圖片」功能需要的，MapLibre 的 WebGL
        // context 預設不保留繪圖緩衝區，沒開這個選項 toDataURL() 會產出空白/全黑圖片。
        ...(preserveDrawingBuffer ? { preserveDrawingBuffer: true } : {}),
    });

    component._resizeObserver = observeMapResize(component.map, document.getElementById(containerId));

    component.map.on('load', () => {
        component.map.addSource(sourceId, { type: 'geojson', data: featureCollection() });

        component.map.addLayer({
            id: `${sourceId}-fill`,
            type: 'fill',
            source: sourceId,
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1 },
        });

        component.map.addLayer({
            id: `${sourceId}-line`,
            type: 'line',
            source: sourceId,
            paint: { 'line-color': '#fcfcfb', 'line-width': 1 },
        });

        component.wireInteractions(component.map, `${sourceId}-fill`);
        onLoaded?.();
    });
}

/**
 * predictionMap()/drillDownMap()/districtMap() 共用：窄螢幕下明細面板改到地圖下方（見
 * RWD 版面），點行政區看到明細後想「關閉並回到地圖」時，捲動回主圖容器頂端——桌面版
 * 地圖跟明細本來就左右並排看得到，這裡呼叫不會有明顯效果，只有窄螢幕直式堆疊時才有感。
 */
function scrollToMapPane(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bboxOfRing(points) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    for (const [lon, lat] of points) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    }

    return { minLon, minLat, maxLon, maxLat };
}

/**
 * 平面座標下的多邊形面積（shoelace 公式），只用來在同一個縮尺下比較「誰比較大」，
 * 不是真實地理面積（沒有校正投影），見 smallestFeature() 為什麼夠用。
 */
function ringArea(geometry) {
    const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
    let total = 0;

    for (const polygon of polygons) {
        const ring = polygon[0];
        let sum = 0;

        for (let i = 0; i < ring.length - 1; i++) {
            const [x1, y1] = ring[i];
            const [x2, y2] = ring[i + 1];
            sum += x1 * y2 - x2 * y1;
        }

        total += Math.abs(sum) / 2;
    }

    return total;
}

/**
 * MapLibre 對同一個 mousemove/click 座標命中多個重疊 feature 時，`e.features` 的排序
 * 不保證等於畫面上的疊圖順序（畫面繪製順序穩定跟隨 GeoJSON feature 陣列順序，但
 * hit-test 命中順序是內部空間索引決定的，兩者不是同一套邏輯，不能假設一致）。
 *
 * 縣市級 choropleth 為了蓋掉「新北市內環洞口跟臺北市/基隆市自己的邊界對不準」這個
 * 已知坑（見後端 ElectionResultsMapBuilder::countyGeometries() 註解），把外層縣市的
 * 內環強制填實——這代表新北市的填色範圍其實整個蓋住臺北市，兩者在臺北市範圍內同時
 * 「命中」，若照抄 `e.features[0]` 當作滑鼠指到的縣市，命中順序剛好相反時，hover
 * 臺北市會顯示成新北市（2026-09-08 使用者實測回報）。
 *
 * 修法：命中多個 feature 時自己挑面積最小的——「小的蓋大的」本來就是這批圖既有的
 * 疊圖規則（見 countyGeometries() 的 `ORDER BY ST_Area DESC` 由大到小疊上去），
 * 用同一條規則決定滑鼠事件該算哪一個，不依賴 MapLibre 沒有保證的 hit-test 順序。
 * 只命中一個 feature（絕大多數情況，沒有重疊）時直接回傳，不做多餘的面積計算。
 */
function smallestFeature(features) {
    if (features.length <= 1) return features[0];

    return features.reduce((smallest, f) => (ringArea(f.geometry) < ringArea(smallest.geometry) ? f : smallest));
}

// 面積小於主要陸地這個比例的群組直接略過，不開巢狀框——金門縣還有一個叫東碇島的無人
// 小礁岩（面積只有金門本島的 0.02%，比烏坵鄉的 1% 小兩個數量級），這種等級的離島放大到
// 46px 的框裡因為頂點數太少（只有 37 個點）看起來就是一個沒意義的色塊，不是真的能辨識
// 出形狀的地方，開框反而讓人以為是渲染壞掉。
const MIN_CLUSTER_AREA_RATIO = 0.005;

/**
 * 把一個縣市的 MultiPolygon 拆成幾群「彼此靠近的陸地」（如金門本島+小金門一群、遠在
 * 130 公里外的烏坵鄉自己一群），依總面積由大到小排序回傳每群的 bbox。inset 框放大到
 * 「填滿主要陸地」時，其餘偏遠的群組自然會被裁到框外看不到——呼叫端要為每一個夠大、
 * 有意義的額外群組各自開一個巢狀小框，不能直接丟掉，不然使用者根本不知道那塊地方存在。
 *
 * 用「離最大那塊陸地夠不夠近」分群（0.3 度，約 33 公里），不用精確知道地名，對任何
 * 縣市的類似離島狀況都通用。
 */
function clusterParts(geometry, maxClusterDegrees = 0.3) {
    const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];

    const parts = polygons.map((polygon) => {
        const b = bboxOfRing(polygon[0]);

        return { ...b, cx: (b.minLon + b.maxLon) / 2, cy: (b.minLat + b.maxLat) / 2, area: (b.maxLon - b.minLon) * (b.maxLat - b.minLat) };
    });

    const remaining = [...parts];
    const clusters = [];

    while (remaining.length) {
        const seed = remaining.reduce((a, b) => (b.area > a.area ? b : a));
        const group = remaining.filter((p) => Math.hypot(p.cx - seed.cx, p.cy - seed.cy) < maxClusterDegrees);
        clusters.push(group);

        for (const p of group) {
            remaining.splice(remaining.indexOf(p), 1);
        }
    }

    clusters.sort((a, b) => b.reduce((s, p) => s + p.area, 0) - a.reduce((s, p) => s + p.area, 0));

    const mainArea = clusters[0].reduce((s, p) => s + p.area, 0);
    const significant = clusters.filter((group, i) => i === 0 || group.reduce((s, p) => s + p.area, 0) >= mainArea * MIN_CLUSTER_AREA_RATIO);

    return significant.map((group) => ({
        bbox: group.reduce(
            (acc, p) => [
                [Math.min(acc[0][0], p.minLon), Math.min(acc[0][1], p.minLat)],
                [Math.max(acc[1][0], p.maxLon), Math.max(acc[1][1], p.maxLat)],
            ],
            [[Infinity, Infinity], [-Infinity, -Infinity]]
        ),
    }));
}

// 以下是預測地圖（predictionMap）跟鑽層地圖（drillDownMap）共用的純函式：兩邊都是
// 「一個行政區帶 results 陣列（依票數 DESC）+ 一份候選人清單（含 color/label）」的資料
// 形狀，上色/圖例/圓餅圖邏輯完全一樣，只是行政區跟候選人清單的來源不同（預測地圖全國
// 共用一份候選人；鑽層地圖每場選舉自己一份，各縣市/鄉鎮的候選人不同組但用同一個
// candidacy_id 空間，仍可用同一份查表邏輯）。

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const FALLBACK_CANDIDATE_COLOR = '#898781';

/**
 * 政黨顏色最終會被塞進 pieChartSvgFor() 的 SVG 字串再用 x-html 顯示，若不是合法色碼
 * （例如自訂政黨顏色被直接改過 localStorage）就可能跳脫 fill="..." 屬性注入任意屬性/
 * 節點，所以在拿到顏色的地方就擋掉不合法值，不留到渲染時才處理。
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidHexColor(value) {
    return typeof value === 'string' && HEX_COLOR_PATTERN.test(value);
}

/**
 * @param {Candidate[]} candidates
 * @param {number} candidacyId
 * @returns {string} 合法色碼；查無資料或色碼不合法一律回傳中性色 FALLBACK_CANDIDATE_COLOR。
 */
function candidateColorFrom(candidates, candidacyId) {
    const color = candidates.find((c) => c.candidacy_id === candidacyId)?.color;

    return isValidHexColor(color) ? color : FALLBACK_CANDIDATE_COLOR;
}

/**
 * @param {Candidate[]} candidates
 * @param {number} candidacyId
 * @returns {string}
 */
function candidateLabelFrom(candidates, candidacyId) {
    return candidates.find((c) => c.candidacy_id === candidacyId)?.label ?? '無資料';
}

/**
 * @param {Candidate[]} candidates
 * @param {number} candidacyId
 * @returns {string|null}
 */
function partyNameFrom(candidates, candidacyId) {
    return candidates.find((c) => c.candidacy_id === candidacyId)?.party_name ?? null;
}

/**
 * @param {VoteResult[]} results
 * @param {number} candidacyId
 * @returns {number} 0~1 之間的得票率；總票數為 0 時回傳 0。
 */
function voteShareOf(results, candidacyId) {
    const total = results.reduce((s, r) => s + r.votes, 0);

    if (total <= 0) return 0;

    const result = results.find((r) => r.candidacy_id === candidacyId);

    return result ? result.votes / total : 0;
}

/**
 * 得票率轉 0~1 的「淺到深」混色比例。門檻抓預測地圖（總統/不分區立委）的實際資料
 * 分布校準（見 predictionMap 原本的說明），鑽層地圖沿用同一組門檻——都是「該行政區
 * 領先候選人得票率」這個同性質的量，沒有另外校準的必要。
 *
 * minRatio 原本是 0.25，改成真實政黨代表色後太淡看不清楚——尤其民眾黨的青色本身就淺，
 * 混到只剩 25% 顏色時幾乎跟白色背景融在一起（見使用者回報的截圖）。0.45 讓「領先幅度
 * 最小」的行政區也還看得出是哪個政黨的色調，同時 maxRatio 端（領先幅度大）不動。
 */
function shareToBlendRatio(share) {
    const minShare = 0.35;
    const maxShare = 0.55;
    const minRatio = 0.45;
    const maxRatio = 1.0;
    const t = Math.min(1, Math.max(0, (share - minShare) / (maxShare - minShare)));

    return minRatio + t * (maxRatio - minRatio);
}

function hexToRgb(hexColor) {
    const hex = hexColor.replace('#', '');

    return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16),
    };
}

/** RGB（0~255）轉 HSL（h/s/l 都是 0~1），shareToFillColor() 只調 l、保留 h/s 用。 */
function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;

    if (max === min) return { h: 0, s: 0, l };

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;

    switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
    }

    return { h: h / 6, s, l };
}

/** HSL（h/s/l 都是 0~1）轉 hex 色碼，shareToFillColor() 用來把調整過的 l 轉回顏色。 */
function hslToHex(h, s, l) {
    const toChannel = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;

        return p;
    };

    let r, g, b;

    if (s === 0) {
        r = g = b = l;
    } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = toChannel(p, q, h + 1 / 3);
        g = toChannel(p, q, h);
        b = toChannel(p, q, h - 1 / 3);
    }

    const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * 得票率轉顏色：固定候選人色本身的色相（hue）跟飽和度（saturation），只調明度
 * （lightness）——領先幅度大明度低（接近候選人真正的顏色），領先幅度小明度高（比較淺）。
 *
 * 原本是直接跟白色混 RGB（見這個函式的舊版本），但那種混法會同時把飽和度往 0 拖，混到
 * 只剩 minRatio 那端時，任何顏色最後都趨近灰白色，淺色系的政黨色（如民眾黨的青色）幾乎
 * 看不出色相、深色系的政黨色（如國民黨的深藍）混出來的淡藍紫色又跟其他政黨的淺色系混在
 * 一起分不清楚（見使用者兩次回報的截圖）。改成只調明度、色相/飽和度不變，淺色端還是同一個
 * 色相的「淺版」而不是「趨近灰白」，各政黨之間即使在領先幅度小的行政區也維持可辨識的色相
 * 差異。
 */
const PARTY_SHADE_COUNT = 4;

// cyclePartyLeadShade() 用：每一階深淺配一個中文標籤，跟 270toWin 那種選舉地圖
// Safe/Likely/Lean 分級是同一個概念——固定幾個有意義的名字，不是純數字深淺，選區明細
// 面板（見 index.html）顯示「目前指定哪一階」時用得到。索引對應 colorShades() 由淺到深
// 的順序，長度要跟 PARTY_SHADE_COUNT 一致。
const LEAD_SHADE_LABELS = ['微幅領先', '領先', '明顯領先', '大幅領先'];

/**
 * duplicatePartyWithColor() 用：固定色相/飽和度，明度平均攤開成幾種深淺讓使用者直接挑，
 * 不用像原本 nextShadeColor() 那樣每點一次複製才看得到下一階是什麼顏色——一次列出來，
 * 猜同一個政黨要拆成幾個候選人時可以直接比較著選，不用「複製→看不滿意→移除→再複製」
 * 反覆試。跟 shareToFillColor()「只調明度、保留色相」是同一個原則。
 * @param {string} hexColor
 * @param {number} [count]
 * @returns {string[]}
 */
function colorShades(hexColor, count = PARTY_SHADE_COUNT) {
    const { h, s } = rgbToHsl(hexToRgb(hexColor));
    // 最深階原本壓到 24% 明度，深藍、深綠、深紅在小色塊與地圖上都容易看成近黑色。
    // 把可選範圍收斂到 38%～72%，保留四階差異，同時讓不同色相在深色端仍清楚可辨。
    const minL = 0.38;
    const maxL = 0.72;

    return Array.from({ length: count }, (_, i) => hslToHex(h, s, minL + (maxL - minL) * (i / (count - 1))));
}

function shareToFillColor(hexColor, share) {
    const ratio = shareToBlendRatio(share);
    const { h, s, l } = rgbToHsl(hexToRgb(hexColor));
    const lightBoost = 0.22;
    const maxLightness = 0.88;
    const lightness = Math.min(maxLightness, l + (1 - ratio) * lightBoost);

    return hslToHex(h, s, lightness);
}

/**
 * @param {VoteResult} result
 * @param {VoteResult[]} results
 * @returns {string} 到小數點後 1 位的百分比字串（不含 % 符號），總票數為 0 時回傳 '0.0'。
 */
function votePctOf(result, results) {
    const total = results.reduce((s, r) => s + r.votes, 0);

    return total > 0 ? ((result.votes / total) * 100).toFixed(1) : '0.0';
}

// 「主要政黨」名單/預測地圖政黨選取清單共用同一份 election:export-current-ly-parties
// 匯出的真實查詢結果（現任立法院各政黨席次，見 ElectionResultsMapBuilder::
// legislativePartySeatsFor()）——不是寫死三大黨，是「目前立院實際有席次的政黨」。兩處
// 原本各自想各寫一份，改成都讀這一份，維護一次。fetch 用同一個 Promise 快取，
// predictionMap()/drillDownMap() 兩邊的 init() 都會呼叫，只實際打一次網路請求。
const CURRENT_LY_PARTIES_URL = 'data/current-ly-parties.json';
const PARTY_DICTIONARY_URL = 'data/party-dictionary.json';
let currentLyPartiesData = [];
let currentLyPartyNames = new Set();
let currentLyPartiesPromise = null;

function loadCurrentLyParties() {
    if (! currentLyPartiesPromise) {
        // 這份檔案沒有像 election-*.json 那樣的 content_hash 版本號可以拼進 URL 觸發快取
        // 失效（見 withVersion() 註解），檔案本身又小，直接 no-store 跳過瀏覽器快取最簡單
        // ——不然政黨顏色改了、使用者只整頁重新整理，還是可能拿到瀏覽器快取住的舊版本
        // （像這次色碼從無障礙色盤改成官方代表色，使用者回報這裡還是舊的橘色）。
        currentLyPartiesPromise = fetch(CURRENT_LY_PARTIES_URL, { cache: 'no-store' })
            .then((res) => res.json())
            .then((data) => {
                currentLyPartiesData = data.parties ?? [];
                currentLyPartyNames = new Set(currentLyPartiesData.map((p) => p.party_name));

                return { parties: currentLyPartiesData, failed: false };
            })
            // 抓不到（如檔案還沒匯出，或暫時斷線）不整個掛掉，退回「只看得票率」規則、
            // 政黨選取清單顯示空清單（使用者仍可加自訂政黨），比噴出 unhandled rejection
            // 更穩妥。但不能把這次失敗永久當成「查無政黨」快取住——把 promise 清空，
            // 下次呼叫端會重新 fetch，並用 failed:true 讓呼叫端跟「真的沒有政黨資料」
            // 區分開來。
            .catch(() => {
                currentLyPartiesData = [];
                currentLyPartyNames = new Set();
                currentLyPartiesPromise = null;

                return { parties: [], failed: true };
            });
    }

    return currentLyPartiesPromise;
}

async function loadPartyDictionary() {
    try {
        const data = await fetchJsonOrThrow(PARTY_DICTIONARY_URL);

        return Array.isArray(data.parties) ? data.parties : [];
    } catch (e) {
        return [];
    }
}

function shortPartyName(name) {
    return name === '無黨籍及未經政黨推薦' ? '無黨籍' : name;
}

/**
 * tooltip 改版：只顯示領先者一人資訊不夠，改列出「得票率 >5%」或「主要政黨候選人」
 * 這兩種都算「值得顯示」的候選人（票數 DESC，跟 results 原本的排序一致），涵蓋兩種
 * 情境——小黨/無黨籍候選人衝到有意義的得票率、或現任立院有席次的政黨候選人即使得票率
 * 不高也想讓人看到「這裡有大黨在選」。找不到 candidates 名單裡的候選人（理論上不會
 * 發生，防禦性處理）視為非主要政黨，只依得票率判斷。
 *
 * `notablePartyNames` 預設吃模組層級的 `currentLyPartyNames`（實際執行時的正常路徑），
 * 開放成參數只是為了讓這個函式在不必先 fetch `current-ly-parties.json` 的情況下也能
 * 單獨測試——呼叫端不用改。
 * @param {VoteResult[]} results
 * @param {Candidate[]} candidates
 * @param {Set<string>} [notablePartyNames]
 * @returns {VoteResult[]}
 */
function notableResultsOf(results, candidates, notablePartyNames = currentLyPartyNames) {
    const total = results.reduce((s, r) => s + r.votes, 0);

    if (total <= 0) return [];

    return results.filter((r) => {
        const share = r.votes / total;
        const partyName = candidates.find((c) => c.candidacy_id === r.candidacy_id)?.party_name;

        return share > 0.05 || notablePartyNames.has(partyName);
    });
}

/**
 * 圓餅圖手畫 SVG path 字串，不用圖表套件（保持前端輕量，見 CLAUDE.md）。
 *
 * ⚠️ 回傳的 HTML 字串要用 x-html 綁定，不能用 <template x-for> 產生 <path>——實測
 * <template x-for> 直接當 <svg> 的子元素時，Alpine 複製節點沒有正確帶上 SVG namespace，
 * 畫出來的 <path> 是空的且後續每次重新算都會噴 ReferenceError。這裡塞的內容全部是自己
 * 算出來的數字，色碼則來自 candidateColorFrom()，該處已擋掉非合法色碼（自訂政黨
 * 顏色可能被直接改過 localStorage），所以塞進這裡的字串不會跳脫 fill="..." 屬性。
 * @param {VoteResult[]} results
 * @param {Candidate[]} candidates
 * @returns {string} `<path>` 元素組成的 SVG 字串片段，總票數為 0 時回傳空字串。
 */
function pieChartSvgFor(results, candidates) {
    const total = results.reduce((s, r) => s + r.votes, 0);

    if (total <= 0) return '';

    const cx = 60;
    const cy = 60;
    const r = 50;
    let cumulative = 0;

    return results.map((res) => {
        const fraction = res.votes / total;
        const color = candidateColorFrom(candidates, res.candidacy_id);

        if (fraction >= 0.999) {
            return `<path d="M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z" fill="${color}"></path>`;
        }

        const startAngle = cumulative * 2 * Math.PI;
        cumulative += fraction;
        const endAngle = cumulative * 2 * Math.PI;
        const largeArc = fraction > 0.5 ? 1 : 0;
        const x1 = (cx + r * Math.sin(startAngle)).toFixed(2);
        const y1 = (cy - r * Math.cos(startAngle)).toFixed(2);
        const x2 = (cx + r * Math.sin(endAngle)).toFixed(2);
        const y2 = (cy - r * Math.cos(endAngle)).toFixed(2);

        return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${color}" stroke="#141820" stroke-width="2"></path>`;
    }).join('');
}

/**
 * UX-02：分享/複製圖片以前完全沒有文字語境——不知道是哪場選舉、顏色深淺代表歷史
 * 實際得票率還是使用者自己改的猜測、也沒有圖例對照顏色是哪個政黨。這裡走訪整棵猜測樹
 * 算出匯出圖片要用的兩份資訊：(1) 圖例——只列黨籍跟顏色（不列候選人名字），不能只用
 * 頂層 candidates 清單，「指定政黨」（見 colorFor() 註解）用的是使用者自訂政黨顏色，
 * 不在 candidates 裡；(2) hasEdits——只要有任一節點跟換屆別時 initGuesses() 設的實際
 * 結果不同（循環過候選人或指定過政黨），就代表這不是單純的實際結果地圖，要在圖片上
 * 明確標示為預測。
 * @param {RegionNode[]} regions - predictionMap() cloneRegionTree() 出來的可寫樹。
 * @param {Candidate[]} candidates
 * @returns {{legend: {label: string, color: string}[], hasEdits: boolean}}
 */
function summarizePredictionState(regions, candidates) {
    const legendByKey = new Map();
    let hasEdits = false;

    const visit = (nodes) => {
        for (const node of nodes) {
            if (node.assigned_party) {
                hasEdits = true;
                legendByKey.set(`party:${node.assigned_party.party_name}`, {
                    label: node.assigned_party.party_name,
                    color: node.assigned_party.color,
                });
            } else {
                if (node.assigned_candidacy_id !== node.actual_winner_candidacy_id) hasEdits = true;

                const partyName = partyNameFrom(candidates, node.assigned_candidacy_id) ?? '無黨籍/其他';
                legendByKey.set(`party:${partyName}`, {
                    label: partyName,
                    color: candidateColorFrom(candidates, node.assigned_candidacy_id),
                });
            }

            if (node.children?.length) visit(node.children);
        }
    };

    visit(regions);

    return { legend: [...legendByKey.values()], hasEdits };
}

/**
 * 匯出圖片左上角標題用：算「頂層每個行政區（縣市/選區）目前顏色對應哪個政黨」的政黨
 * 拿下數量，由多到少排序。只看頂層（regions 本身，不遞迴 children）——這是總統/縣市長
 * 這種單一當選人地圖，頂層每個節點恰好對應一個縣市，數縣市數才有意義；議員/代表這種
 * 多席次地圖不會用到這個函式（見 districtMap() 自己的 party_seats 統計）。
 * @param {RegionNode[]} regions
 * @param {Candidate[]} candidates
 * @returns {{partyName: string, color: string, count: number}[]}
 */
function partyLeadCountsFor(regions, candidates) {
    const counts = new Map();

    for (const node of regions) {
        const partyName = node.assigned_party
            ? node.assigned_party.party_name
            : (partyNameFrom(candidates, node.assigned_candidacy_id) ?? '無黨籍/其他');
        const color = node.assigned_party
            ? node.assigned_party.color
            : candidateColorFrom(candidates, node.assigned_candidacy_id);

        const entry = counts.get(partyName) ?? { partyName, color, count: 0 };
        entry.count += 1;
        counts.set(partyName, entry);
    }

    return [...counts.values()].sort((a, b) => b.count - a.count);
}

const MERCATOR_TILE_SIZE = 512;

function mercatorX(lon) {
    return lon / 360 + 0.5;
}

function mercatorY(lat) {
    const rad = (lat * Math.PI) / 180;
    return 0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI);
}

/**
 * 手動算「把 bbox 塞進一個正方形小容器」對應的 zoom/center，取代 MapLibre 自己的
 * fitBounds()——實測 fitBounds() 在「容器很小（inset 這種 140px 見方的小地圖）+ bbox
 * 長寬比明顯不是正方形」的組合下算出的 zoom 偏高，畫面內容會溢出容器邊界被裁掉（懷疑是
 * 內部只用其中一個軸的比例換算 zoom，沒有取兩軸中較保守、才能保證兩個方向都塞得下的
 * 那個），排查過不是 padding 設定值的問題（padding 從 0 到 26 結果幾乎一樣）。用經緯度轉
 * Web Mercator 正規化座標後，兩個軸各自算出「剛好塞滿容器」需要的 zoom，取較小值（較
 * 保守、兩軸都塞得下）才是正確答案。
 */
function cameraForBounds(bbox, containerSize, paddingPx) {
    const [[minLon, minLat], [maxLon, maxLat]] = bbox;
    const spanX = mercatorX(maxLon) - mercatorX(minLon);
    const spanY = mercatorY(minLat) - mercatorY(maxLat);
    const available = containerSize - paddingPx * 2;
    const zoom = Math.min(Math.log2(available / (spanX * MERCATOR_TILE_SIZE)), Math.log2(available / (spanY * MERCATOR_TILE_SIZE)));

    return { center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2], zoom };
}

/** 一組 GeoJSON feature（Polygon 或 MultiPolygon 混合皆可）的聯合外框，供 fitBounds 用。 */
function unionBBox(features) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    for (const feature of features) {
        const geometry = feature.geometry;

        if (! geometry) continue;

        const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];

        for (const polygon of polygons) {
            const b = bboxOfRing(polygon[0]);
            minLon = Math.min(minLon, b.minLon);
            minLat = Math.min(minLat, b.minLat);
            maxLon = Math.max(maxLon, b.maxLon);
            maxLat = Math.max(maxLat, b.maxLat);
        }
    }

    return [[minLon, minLat], [maxLon, maxLat]];
}

// localStorage 存自訂政黨用的 key，前綴跟這個專案的其他 localStorage 用途（目前只有
// 這一個）區隔，避免萬一同網域下其他頁面也用 localStorage 時互相污染。
const CUSTOM_PARTIES_STORAGE_KEY = 'tw-election-map:custom-parties';

// 「猜測地圖」（predictionMap）改成可以選任意行政區層級，資料直接借用鑽層地圖
// （drillDownMap）的巢狀樹（election-{id}-drilldown.json），不再有自己專屬的一份扁平
// 縣市清單——只挑「頂層底下至少還有一層可以往下鑽」的選舉類別：president/
// legislator_at_large/legislator_*_indigenous/county_mayor 頂層是「縣市」，legislator
// （區域立委）頂層是「選區」，這 6 種頂層底下都是「鄉鎮市區→村里」兩層巢狀；merged/
// township_mayor（鄉鎮市/直轄市原住民區長）頂層直接是「鄉鎮市區」，底下少一層縣市，只有
// 「村里」一層可鑽，一樣適用同一套「顯示層級/填色層級」機制（見下面 levels getter 依每筆
// 資料自己的 level 欄位決定各層級要顯示的名稱，層數不用寫死）。
// 不分區/山地原民/平地原民立委沒有選區地理邊界，「一格一格猜」這種地圖互動對這三類沒有
// 意義（全國不分區的得票不會因為使用者住哪個村里而不同）——這三類改成在區域立委畫面旁邊
// 讓使用者直接輸入政黨席次（見 predictionMap() 的 otherLegislatorCategories／
// OTHER_LEGISLATOR_TYPES），不再是地圖選單裡可以切換的獨立項目；歷屆結果地圖
// （drillDownMap()）不受影響，還是照常列出這三類的歷史地圖。
const PREDICT_ELECTION_TYPES = new Set([
    'president',
    'county_mayor',
    'legislator',
    'merged',
    'township_mayor',
]);

/** 見 PREDICT_ELECTION_TYPES 註解：這三類立委改用方格塗色，不走地圖。 */
const OTHER_LEGISLATOR_TYPES = [
    'legislator_at_large',
    'legislator_mountain_indigenous',
    'legislator_plains_indigenous',
];

// 憲法增修條文第 4 條規定的固定席次，2008 年第 7 屆立委選制改革後沿用至今沒再變過
// （不像區域立委席次會隨行政區劃調整），直接寫死，不用另外從資料算。
const OTHER_LEGISLATOR_SEAT_COUNTS = {
    legislator_at_large: 34,
    legislator_mountain_indigenous: 3,
    legislator_plains_indigenous: 3,
};

// 選單只列每種類型最新一屆（見 init()），不需要靠年份/選舉全名區分同類型的不同屆，選單
// 選項改成這份短名稱，比原始 election.name（帶年份+完整官方選舉名稱，兩個資訊在只列一屆
// 時都是多餘的）更好掃視。
const PREDICT_ELECTION_TYPE_LABELS = {
    president: '總統選舉',
    legislator: '立委選舉',
    legislator_at_large: '不分區立委',
    legislator_mountain_indigenous: '山地原民立委',
    legislator_plains_indigenous: '平地原民立委',
    county_mayor: '縣市長',
    merged: '鄉鎮市自治區長',
    township_mayor: '鄉鎮市自治區長',
};

// 對應鑽層資料每個節點的 level 欄位（見 ElectionResultsMapBuilder 匯出時寫入的值），
// 決定「顯示層級/填色層級」選單要顯示的中文名稱。
const PREDICT_LEVEL_LABELS = {
    county: '縣市',
    district: '選區',
    township: '鄉鎮市區',
    village: '村里',
};

/**
 * 把巢狀行政區樹攤平成「全國在某個層級的清單」（例如 depth=1 就是全國所有鄉鎮市區，不分
 * 縣市混在同一個陣列）。少數行政區的資料可能沒有到那麼細（見已知資料缺口），走到沒有
 * children 的節點就提早停下來，那個節點本身就是這個分支能給的最細層級，不是 bug。
 * @param {RegionNode[]} regions
 * @param {number} depth
 * @returns {RegionNode[]}
 */
function flattenAtLevel(regions, depth) {
    if (depth <= 0) return regions;

    return regions.flatMap((r) => (
        r.children && r.children.length ? flattenAtLevel(r.children, depth - 1) : [r]
    ));
}

/**
 * 從某個行政區節點往下走 remainingDepth 層，收集「填色層級」實際要看的節點集合——
 * remainingDepth<=0（已經在填色層級）或提早碰到沒有 children 的節點（資料只到這裡）都
 * 回傳節點自己這一筆，其餘情況遞迴收集子節點。predictionMap() 的上色/點擊邏輯共用這個
 * 集合：只有一筆就是「直接猜測」，超過一筆就是「往下層猜測結果聚合」。
 * @param {RegionNode} region
 * @param {number} remainingDepth
 * @returns {RegionNode[]}
 */
function effectiveFillNodes(region, remainingDepth) {
    if (remainingDepth <= 0 || ! region.children || ! region.children.length) return [region];

    return region.children.flatMap((c) => effectiveFillNodes(c, remainingDepth - 1));
}

/**
 * predictionMap() 專用：election-*-drilldown.json 的資料是共用 electionDataCache 快取住的
 * 同一份物件（見 fetchElectionData()），但猜測模式會直接在節點上寫 assigned_candidacy_id/
 * assigned_party（見 initGuesses()/onRegionClick()）——原始資料唯讀契約要求猜測狀態不能
 * 污染這份快取，不然理論上未來其他消費者讀到同一個 URL 會拿到帶著使用者猜測痕跡的資料。
 *
 * 做法是淺複製每個節點物件本身（連同 children 陣列一路遞迴淺複製），但不複製節點內的
 * results 等大型欄位——那些欄位的值本來就不會被猜測邏輯改寫，共用同一個參照不影響
 * 隔離效果。幾何資料現在只是個 geometry_hash 字串參照共用表（見 fetchGeometriesFor()），
 * 淺複製天然就不會動到真正的幾何內容，不需要另外考慮。
 * @param {RegionNode[]} regions - 可能是 deepFreeze() 過的唯讀樹，回傳值一定是全新的
 *   可寫物件（見 deepFreeze() 相關單元測試），呼叫端不用先自己複製一份。
 * @returns {RegionNode[]}
 */
function cloneRegionTree(regions) {
    return regions.map((r) => ({
        ...r,
        children: r.children ? cloneRegionTree(r.children) : r.children,
    }));
}

/**
 * 五個模式共用：x-show 只切換顯示，五個元件本身都在頁面載入時就被 Alpine 建立，若各自的
 * init() 立刻 fetch/建圖，等於一次載入五份資料、建五個 MapLibre 實例，使用者可能根本沒切
 * 過去看。改成「已經是目前選取的模式」才立刻開始，否則訂閱 $store.ui.mode，第一次切到
 * 這個模式才觸發真正的載入（一次性，觸發後解除訂閱），之後切走保留實例不銷毀（見
 * IMPROVEMENT_PLAN.md 第一階段第 5 項——銷毀重建策略留到第四階段依量測結果再決定）。
 */
function watchModeOnce(component, mode, onActive) {
    if (Alpine.store('ui').mode === mode) {
        onActive();
        return;
    }

    // component.$watch() 的 magic 在目前用的 Alpine 版本不會回傳可呼叫的解除訂閱函式
    // （回傳 undefined）——之前這裡寫 `const unwatch = component.$watch(...)` 再於 callback
    // 裡呼叫 `unwatch()`，實際執行會是呼叫 undefined 而丟例外，被 Alpine 的 effect 錯誤處理
    // 吞掉，導致整個 callback 提前中斷、onActive()（真正觸發 fetch/建圖的那步）永遠不會執行
    // ——三個模式裡除了預設模式，其餘全部切過去都會卡在 loading（這裡有靠瀏覽器測試才抓到，
    // 純 node:test 沒辦法涵蓋這種要素實跑 Alpine 生命週期才會暴露的問題）。改用旗標讓 callback
    // 自己一次性失效，不依賴 $watch 是否有提供解除訂閱的回傳值；watcher 本身留著繼續訂閱，
    // 之後每次 mode 變動都還是會呼叫到這個 callback，但旗標擋下第二次以後的實際動作。
    let triggered = false;

    component.$watch('$store.ui.mode', (value) => {
        if (triggered || value !== mode) return;

        triggered = true;
        // 等 x-show 實際套用、容器有真正的寬高之後才建圖，不然 MapLibre 用還在
        // display:none 的容器量到的尺寸初始化，畫面會是空的，要等使用者手動縮放視窗
        // 才會恢復（見 IMPROVEMENT_PLAN.md LOAD-09）。
        component.$nextTick(() => onActive());
    });
}

const TOOLTIP_CURSOR_OFFSET = 14;

/**
 * 三個模式共用：hover tooltip 原本固定往游標右下偏移，容器（地圖）右側/下方邊界附近
 * 會被裁掉一部分看不到（UI-01）。改成量出 tooltip 實際尺寸後，容器放不下右下角就翻到
 * 游標左上，再整體夾在容器範圍內，避免翻過去之後換成另一側溢出。純函式只算座標，方便
 * 不用真的量 DOM 也能測試邊界情境。
 */
function tooltipPositionFor(cursor, tooltipSize, containerSize, offset = TOOLTIP_CURSOR_OFFSET) {
    let x = cursor.x + offset;

    if (x + tooltipSize.width > containerSize.width) {
        x = cursor.x - offset - tooltipSize.width;
    }

    x = Math.max(0, Math.min(x, containerSize.width - tooltipSize.width));

    let y = cursor.y + offset;

    if (y + tooltipSize.height > containerSize.height) {
        y = cursor.y - offset - tooltipSize.height;
    }

    y = Math.max(0, Math.min(y, containerSize.height - tooltipSize.height));

    return { x, y };
}

/**
 * tooltip 剛顯示或內容剛換（候選人名單長度不同）時，量到的尺寸才是準的，所以先用游標
 * 偏移量顯示一次（避免等 $nextTick 這段時間顯示在 (0,0)），量到實際尺寸後再校正一次。
 */
function updateTooltipPosition(component, mapEl, clientX, clientY) {
    const rect = mapEl.getBoundingClientRect();
    const cursor = { x: clientX - rect.left, y: clientY - rect.top };

    component.tooltipPos = { x: cursor.x + TOOLTIP_CURSOR_OFFSET, y: cursor.y + TOOLTIP_CURSOR_OFFSET };

    component.$nextTick(() => {
        const tooltipEl = mapEl.querySelector('.tooltip');

        if (! tooltipEl) return;

        const tooltipRect = tooltipEl.getBoundingClientRect();

        component.tooltipPos = tooltipPositionFor(
            cursor,
            { width: tooltipRect.width, height: tooltipRect.height },
            { width: rect.width, height: rect.height }
        );
    });
}

function predictionMap() {
    return {
        // 一定要在這個物件字面量裡先宣告（不能只靠 init() 第一次 `this._initialized = true`
        // 動態建立這個屬性）：三個模式共用同一個 <div id="app" x-data> 當共同祖先 scope，
        // 拿掉這行先宣告、只留 init() 裡動態賦值，實測會讓其他兩個模式的 init() 第一次讀
        // `this._initialized` 就已經是 true、直接提前 return，watchModeOnce() 永遠不會被
        // 呼叫，整個模式卡在 loading（用瀏覽器 smoke test 重現過兩次：拿掉這行 5 個測試案例
        // 失敗、加回來全過，不是理論推測）。其餘欄位都在各自 loadElection() 才第一次賦值，
        // 不受影響——只有這個「元件掛載時、資料還沒載入前就要讀」的旗標會踩到。
        _initialized: false,
        // 切換屆別時前一次 loadElection() 若還沒解析完（fetch 還在等），後到的結果不能
        // 覆蓋後發但先解析完的較新請求——每次 loadElection() 遞增這個序號，await 之後
        // 比對序號還是不是自己發起時的那個，不是就代表已經被更新的請求取代，直接放棄
        // 寫入任何狀態。
        _loadSeq: 0,
        // 'loading' | 'error' | 'empty' | 'ready'：index 還沒載完/index 載入失敗/index 是
        // 空陣列/正常顯示中，見 init()、loadElection()。switchError 是另一條獨立的訊息——
        // 已經有舊地圖顯示中、切換屆別失敗時用，不動 status（保留舊地圖跟它的 ready 狀態）。
        status: 'loading',
        errorMessage: '',
        switchError: '',
        map: null,
        insetMaps: [],
        election: null,
        candidates: [],
        regionTree: [],
        // 幾何去重（見 fetchGeometriesFor() 註解）：loadElection() 抓到之後存這裡，
        // featureCollectionFor()/initInsetMaps() 等要畫圖的地方都透過 geometryFor() 查。
        geometryStore: null,
        elections: [],
        selectedElectionId: null,
        editorOpen: false,

        displayLevelIndex: 0,
        fillLevelIndex: 0,

        // 只看某一個頂層行政區（如單一縣市/單一選區）用：null 代表全國，有值時頂層（沒
        // drillPath）不是攤平全國，而是只攤平這一個頂層節點底下的子行政區，見
        // currentRegions() 註解。
        selectedRootId: null,

        // 鑽入路徑：從「顯示層級」的頂層節點往下鑽，只在填色層級比顯示層級深的時候會用到
        // （見 onRegionClick() 註解），[] 代表還在顯示層級的頂層（全國攤平，或
        // selectedRootId 選定的單一行政區攤平）。
        drillPath: [],
        selectedRegion: null,

        // 保留既有單步復原狀態欄位，供其他直接指定路徑清理；地圖本身在未選畫筆時只查看
        // 明細，不再建立新的候選人循環編輯（見 selectRegionById()）。
        lastEdit: null,

        // 分享/下載圖片本身都沒有明顯的畫面變化（系統分享選單是瀏覽器層級的操作，頁面
        // 本身看不出來發生了什麼），用這個暫時提示告訴
        // 使用者結果；flashShareStatus() 設定後幾秒自動清空，不用使用者自己關掉。
        shareStatus: '',
        _shareStatusTimer: null,

        // 「指定政黨給選取行政區」用：currentLyParties 是現任立院有席次的政黨，起始值來自
        // current-ly-parties.json，但這裡存的是複製出來的獨立副本，使用者可以直接改名字/
        // 顏色（見 start()）——「政黨」跟「候選人」故意模糊掉，改名成候選人名字一樣能用；
        // _defaultLyParties 是沒被改過的原始版本，resetToActual() 用來復原。customParties
        // 是使用者自己加的，存 localStorage（純前端狀態，不寫回資料庫，見 CLAUDE.md 前端
        // 規則）。
        currentLyParties: [],
        _defaultLyParties: [],
        customParties: [],
        newPartyLabel: '',
        newPartyColor: '#6b7280',
        partyDictionary: [],
        partySearchResults: [],
        _partySearchTimer: null,

        /** 政黨選取清單：現任立院政黨 + 使用者自訂政黨，兩者用同一份清單給塗格子/查詢用。 */
        get assignableParties() {
            return [...this.currentLyParties, ...this.customParties];
        },

        /** 見 index.html：每一列政黨旁邊列出的深淺選項，直接點喜歡的那個複製，不用一直點同一顆按鈕猜下一階是什麼顏色。 */
        colorShades(hexColor) {
            return colorShades(hexColor);
        },

        /**
         * 複製一份、套用選好的深淺：同一個政黨底下想拆成好幾個候選人時，不用每次手動調色，
         * 直接點 colorShades() 列出來的其中一個深淺；使用者對顏色不滿意還是可以自己用色盤
         * 調。新項目名稱加一個沒被佔用的編號後綴，避免撞名——assignableParties 好幾個地方
         * 靠 party_name 當識別（selectParty()/paintOtherLegislatorSeat() 等），撞名會讓
         * 查詢查到錯的那筆。
         */
        duplicatePartyWithColor(party, color, list = this.currentLyParties) {
            const index = list.indexOf(party);

            if (index === -1) return;

            const baseName = party.party_name.trim();
            let n = 2;

            while (list.some((p) => p.party_name === `${baseName} ${n}`)) n += 1;

            // currentLyParties 的 x-for 用 p.id 當 :key（見 start()），新複製出來的這筆
            // 沒有 id 的話會是 undefined——好幾筆 undefined 撞在一起，Alpine 沒辦法正確
            // 分辨是哪一筆，畫面可能整筆不出現或跟別筆共用/蓋掉 DOM，複製看起來像「沒有
            // 反應」。customParties 的 x-for 用 index 當 key 不受影響，但補一個 id 統一
            // 兩邊的物件形狀，不用另外分兩種寫法。
            list.splice(index + 1, 0, {
                id: `${party.id ?? baseName}-dup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                party_name: `${baseName} ${n}`,
                color,
            });

            if (list === this.customParties) this.persistCustomParties();
        },

        removeCurrentLyParty(party) {
            const index = this.currentLyParties.indexOf(party);

            if (index !== -1) this.currentLyParties.splice(index, 1);
        },

        // 見 OTHER_LEGISLATOR_TYPES 註解：不分區/山地原民/平地原民立委不走地圖，改成
        // 方格塗色——每一類固定席次數（OTHER_LEGISLATOR_SEAT_COUNTS）攤成一排格子，跟
        // 「指定政黨給選取的OO」共用同一份政黨清單/同一個「目前選取政黨」狀態
        // （activePartyName，見下方），不用另外列一份重複的政黨按鈕。跟區域立委地圖猜
        // 出來的席次加總，湊出整個立法院的預測組成（見 index.html 對應區塊、
        // totalLegislatorSeatsByParty()）。只在 election.type === 'legislator'（區域
        // 立委）時顯示，見 loadElection() 重設。
        otherLegislatorCategories: OTHER_LEGISLATOR_TYPES.map((type) => ({
            type,
            label: PREDICT_ELECTION_TYPE_LABELS[type],
            // 每格是 null（還沒塗）或 {party_name, color}，陣列長度=固定席次數，不會變動。
            squares: Array.from({ length: OTHER_LEGISLATOR_SEAT_COUNTS[type] }, () => null),
        })),

        // 「目前選取政黨」：兩種用途共用同一個狀態——(1) 有選取行政區時點政黨清單，直接
        // 指定給那個行政區（見 selectParty()，沿用原本 assignPartyToSelected() 的一次性
        // 套用行為）；(2) 不分區/山地/平地原民立委塗格子時當畫筆（見
        // paintOtherLegislatorSeat()）。原本兩處各自列一份政黨按鈕清單，使用者要用同一個
        // 政黨還得在兩份重複清單裡各點一次；合併成一份清單、一個狀態後，選一次到處都能用。
        activePartyName: null,
        _seatPaintDragging: false,
        _lastSeatPaintKey: null,

        /** 選取／取消畫筆；不修改目前查看中的行政區，真正填色一律發生在下一次點地圖時。 */
        selectParty(party) {
            this.activePartyName = this.activePartyName === party.party_name ? null : party.party_name;
        },

        /** 修改主色後直接選為畫筆，讓「選顏色→點地圖」的操作成立。 */
        activateParty(party) {
            this.activePartyName = party.party_name;
        },

        /** 點同色系深淺時，直接把該色設為這支畫筆並選取，不再建立另一筆候選人。 */
        selectPartyShade(party, color, shouldPersist = false) {
            party.color = color;
            this.activePartyName = party.party_name;

            if (shouldPersist) this.persistCustomParties();
        },

        /**
         * 見 otherLegislatorCategories／activePartyName 註解：沒選政黨時點格子等同橡皮擦
         * （清空，不管原本是誰的顏色）；已選政黨時點「已經是同一個政黨」的格子視為使用者
         * 想取消，切回空白，跟地圖那邊「再點一次切換」的手感不同、但這裡格子只有兩種狀態
         * （空白/某政黨）不是候選人循環，直接 toggle 比再點一次跳下一個政黨更直覺。
         */
        paintOtherLegislatorSeat(category, index) {
            const brush = this.activePartyName
                ? this.assignableParties.find((p) => p.party_name === this.activePartyName)
                : null;

            if (! brush) {
                category.squares[index] = null;
                return;
            }

            const current = category.squares[index];
            category.squares[index] = current?.party_name === brush.party_name
                ? null
                : { party_name: brush.party_name, color: brush.color };
        },

        /** 按下後開始連續填色；拖曳經過的格子只套用畫筆，不做 toggle，避免來回經過被清空。 */
        beginSeatPaintDrag(category, index) {
            this._seatPaintDragging = true;
            this._lastSeatPaintKey = `${category.type}:${index}`;
            this.fillOtherLegislatorSeat(category, index);
        },

        continueSeatPaintDrag(category, index) {
            if (this._seatPaintDragging) this.fillOtherLegislatorSeat(category, index);
        },

        endSeatPaintDrag() {
            this._seatPaintDragging = false;
            this._lastSeatPaintKey = null;
        },

        continueSeatPaintAtPoint(event) {
            if (! this._seatPaintDragging) return;

            const square = document.elementFromPoint(event.clientX, event.clientY)?.closest('.seat-square');
            if (! square) return;

            const category = this.otherLegislatorCategories.find((item) => item.type === square.dataset.seatCategory);
            const index = Number(square.dataset.seatIndex);
            const key = `${category?.type}:${index}`;

            if (! category || ! Number.isInteger(index) || key === this._lastSeatPaintKey) return;

            this._lastSeatPaintKey = key;
            this.fillOtherLegislatorSeat(category, index);
        },

        fillOtherLegislatorSeat(category, index) {
            const brush = this.activePartyName
                ? this.assignableParties.find((p) => p.party_name === this.activePartyName)
                : null;

            category.squares[index] = brush
                ? { party_name: brush.party_name, color: brush.color }
                : null;
        },

        /** 見 index.html：每一類格子上方顯示「已塗 X／固定席次數」，不用另外數。 */
        otherLegislatorPaintedCount(category) {
            return category.squares.filter((s) => s).length;
        },

        /**
         * 區域立委地圖猜出來的政黨席次（partyLeadCountsFor() 本來是給匯出圖片標題用的，
         * 這裡拿來重用：this.regionTree 頂層每個節點就是一個選區＝一席，跟匯出圖片算
         * 「頂層每個行政區對應哪個政黨」是同一件事）＋使用者塗好的三類格子，同一個政黨
         * 名稱的席次直接加總，湊出整個立法院的預測總表，依席次由多到少排序。
         */
        get totalLegislatorSeatsByParty() {
            if (this.election?.type !== 'legislator') return [];

            const totals = new Map();

            for (const { partyName, color, count } of partyLeadCountsFor(this.regionTree, this.candidates)) {
                const displayName = shortPartyName(partyName);
                totals.set(displayName, { party_name: displayName, color, seats: count });
            }

            for (const category of this.otherLegislatorCategories) {
                for (const square of category.squares) {
                    if (! square) continue;

                    const existing = totals.get(square.party_name);

                    if (existing) existing.seats += 1;
                    else totals.set(square.party_name, { party_name: square.party_name, color: square.color, seats: 1 });
                }
            }

            return [...totals.values()].sort((a, b) => b.seats - a.seats);
        },

        /**
         * 右側總覽共用的統計資料。立委以「區域席次＋三類席次格」計算；其他選舉則以目前
         * 填色層級的預測贏家計算。這裡直接讀現有預測狀態，因此每次塗地圖或席次格後，
         * Alpine 會同步重算圓環、排名與比例帶。
         */
        get predictionSummaryEntries() {
            let entries;

            if (this.election?.type === 'legislator') {
                entries = this.totalLegislatorSeatsByParty.map((entry) => ({
                    party_name: entry.party_name,
                    color: isValidHexColor(entry.color) ? entry.color : FALLBACK_CANDIDATE_COLOR,
                    count: entry.seats,
                }));
            } else {
                const totals = new Map();

                for (const node of this.allFillNodes) {
                    const candidacyId = node.assigned_candidacy_id ?? node.actual_winner_candidacy_id;
                    const partyName = node.assigned_party?.party_name
                        ?? partyNameFrom(this.candidates, candidacyId)
                        ?? candidateLabelFrom(this.candidates, candidacyId);
                    const candidateColor = node.assigned_party?.color
                        ?? candidateColorFrom(this.candidates, candidacyId);
                    const color = isValidHexColor(candidateColor) ? candidateColor : FALLBACK_CANDIDATE_COLOR;
                    const existing = totals.get(partyName);

                    if (existing) existing.count += 1;
                    else totals.set(partyName, { party_name: partyName, color, count: 1 });
                }

                entries = [...totals.values()].sort((a, b) => b.count - a.count);
            }

            const total = entries.reduce((sum, entry) => sum + entry.count, 0);

            return entries.map((entry) => ({
                ...entry,
                percentage: total ? (entry.count / total) * 100 : 0,
            }));
        },

        get predictionSummaryTotal() {
            return this.predictionSummaryEntries.reduce((sum, entry) => sum + entry.count, 0);
        },

        /** CSS conic-gradient 避免再引入圖表套件，也不把外部名稱寫進 SVG/HTML。 */
        get predictionDonutStyle() {
            const entries = this.predictionSummaryEntries;

            if (! entries.length) return `background:${FALLBACK_CANDIDATE_COLOR}`;

            let cursor = 0;
            const stops = entries.map((entry) => {
                const start = cursor;
                cursor += entry.percentage;
                return `${entry.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
            });

            return `background:conic-gradient(${stops.join(',')})`;
        },

        get predictionDonutLabel() {
            const unit = this.election?.type === 'legislator' ? '席' : `個${this.fillLevelLabel}`;
            const breakdown = this.predictionSummaryEntries
                .map((entry) => `${entry.party_name} ${entry.count} ${unit}`)
                .join('，');

            return `預測分布：${breakdown || '尚無資料'}`;
        },

        /**
         * 這場選舉巢狀樹實際有幾層、每層叫什麼名字——不是寫死的，沿著樹的第一個分支一路
         * 往下走，讀每個節點自己的 level 欄位轉成中文名稱（見 PREDICT_LEVEL_LABELS）。
         * 縣市長/總統/不分區立委頂層是「縣市」，區域立委頂層是「選區」，兩種都是三層
         * （頂層→鄉鎮市區→村里），這裡不用另外分兩套邏輯。
         */
        get levels() {
            const result = [];
            let node = this.regionTree[0];

            while (node) {
                result.push({ label: PREDICT_LEVEL_LABELS[node.level] ?? node.level ?? '' });
                node = node.children?.[0];
            }

            return result.length ? result : [{ label: '' }];
        },

        /** 填色層級可選範圍：不能比顯示層級淺（見 setDisplayLevel() 註解）。 */
        get fillLevelOptions() {
            return this.levels.map((l, i) => ({ ...l, index: i })).filter((l) => l.index >= this.displayLevelIndex);
        },

        get fillLevelLabel() {
            return this.levels[this.fillLevelIndex]?.label ?? '';
        },

        /** 目前這一批地圖節點的深度（相對整棵樹的根）：頂層是 displayLevelIndex，鑽進去每層 +1。 */
        get currentDepth() {
            return this.displayLevelIndex + this.drillPath.length;
        },

        /**
         * 頂層（drillPath 空）預設攤平全國所有頂層節點；selectedRootId 有值時只攤平那一個
         * 頂層節點自己底下的子行政區（flattenAtLevel() 的 regions 參數換成只有它一筆，
         * depth 還是 displayLevelIndex，效果就是「只看這個縣市/選區底下的鄉鎮市區/村里」，
         * 不用整棵樹的其他分支）。
         */
        get currentRegions() {
            if (this.drillPath.length) return this.drillPath[this.drillPath.length - 1].children ?? [];

            const roots = this.selectedRootId
                ? this.regionTree.filter((r) => r.region_id === this.selectedRootId)
                : this.regionTree;

            return flattenAtLevel(roots, this.displayLevelIndex);
        },

        /**
         * 顯示層級的頂層、且還沒指定單一行政區時才會混到金門/連江——鑽進任何一個節點、或
         * selectedRootId 已經鎖定單一行政區之後，子集合彼此靠近不需要排除（鎖定的行政區
         * 剛好就是金門/連江本身時更不能排除，不然會把使用者選的行政區自己濾掉）。
         */
        get mainRegions() {
            if (this.drillPath.length || this.selectedRootId) return this.currentRegions;

            const insetNames = INSET_COUNTIES.map((i) => i.countyName);
            return this.currentRegions.filter((r) => ! insetNames.includes(r.name));
        },

        get drillBreadcrumb() {
            return this.drillPath.map((r) => ({ region_id: r.region_id, name: r.name }));
        },

        /** 全國在填色層級的節點清單（不受目前鑽到哪裡影響），legend 計數用。 */
        get allFillNodes() {
            return this.regionTree.flatMap((r) => effectiveFillNodes(r, this.fillLevelIndex));
        },

        /** 「指定政黨給選取的行政區」清單自己的計數，見 index.html 的「或指定政黨」區塊。 */
        get partyTally() {
            const counts = {};
            for (const node of this.allFillNodes) {
                if (! node.assigned_party) continue;

                const name = node.assigned_party.party_name;
                counts[name] = (counts[name] ?? 0) + 1;
            }
            return counts;
        },

        async init() {
            if (this._initialized) return;
            this._initialized = true;

            watchModeOnce(this, 'predict', () => this.start());
        },

        async start() {
            this.status = 'loading';

            // 見 currentLyParties／resetToActual() 註解：這裡要各自複製一份獨立物件，不能
            // 直接用 partiesResult.parties 那個模組層級共用陣列——使用者會直接改名字/顏色，
            // 共用陣列被改到會連帶影響其他也讀這份快取的呼叫端。_defaultLyParties 額外存一份
            // 沒被改過的版本，resetToActual() 用它復原。
            const [partiesResult, partyDictionary] = await Promise.all([
                loadCurrentLyParties(),
                loadPartyDictionary(),
            ]);
            this.currentLyParties = partiesResult.parties.map((p, i) => ({ ...p, party_name: shortPartyName(p.party_name), id: `ly-${i}` }));
            this.partyDictionary = partyDictionary.map((p) => ({ ...p, party_name: shortPartyName(p.party_name) }));
            this._defaultLyParties = this.currentLyParties.map((p) => ({ ...p }));
            this.loadCustomPartiesFromStorage();

            let all;
            try {
                all = await fetchJsonOrThrow(DRILLDOWN_INDEX_URL);
            } catch (e) {
                this.status = 'error';
                this.errorMessage = '選舉清單載入失敗，請檢查網路連線後重試。';
                return;
            }

            // drilldown-index.json 依日期由新到舊排序；猜測地圖只列每個選單短名稱（見
            // PREDICT_ELECTION_TYPE_LABELS）最新一屆——歷屆資料鑽層結果地圖已經有完整的
            // 可以看，這裡選單塞進好幾種類型 x 好幾屆歷史選舉反而太長，「猜測」這個遊戲
            // 本身也是對最近一屆比較有意義（見使用者回報：選單太長，只要最新一屆代表就好）。
            // 用短名稱（不是 type）去重——merged／township_mayor 兩個 type 顯示同一個「鄉鎮市
            // 自治區長」短名稱（見合併村里長選舉的說明），不去重會在選單裡出現兩筆同名選項。
            const seenLabels = new Set();
            this.elections = all.filter((e) => {
                if (! PREDICT_ELECTION_TYPES.has(e.type)) return false;

                const label = this.electionLabel(e);

                if (seenLabels.has(label)) return false;

                seenLabels.add(label);
                return true;
            });

            if (! this.elections.length) {
                this.status = 'empty';
                return;
            }

            await this.loadElection(this.elections[0].id);
        },

        /** index 載入失敗時的重試入口（見 index.html 的錯誤區塊按鈕）。 */
        retryInit() {
            this._initialized = false;
            this.init();
        },

        /** 選單顯示用的短名稱（見 PREDICT_ELECTION_TYPE_LABELS 註解），查不到就退回選舉全名。 */
        electionLabel(election) {
            return PREDICT_ELECTION_TYPE_LABELS[election.type] ?? election.name;
        },

        loadCustomPartiesFromStorage() {
            try {
                const raw = localStorage.getItem(CUSTOM_PARTIES_STORAGE_KEY);
                const parsed = raw ? JSON.parse(raw) : [];

                // 解析成功不代表形狀正確（可能是舊格式或被直接改過的 localStorage）；
                // 只留下 party_name 是字串、color 是合法色碼的項目，其餘捨棄而不是讓
                // 整頁失效或把不合法色碼一路帶進之後的 x-html 渲染（見 isValidHexColor）。
                this.customParties = Array.isArray(parsed)
                    ? parsed.filter((p) => p && typeof p.party_name === 'string' && p.party_name.trim() && isValidHexColor(p.color))
                    : [];
            } catch (e) {
                // 無痕視窗/瀏覽器封鎖 localStorage 時讀取會丟例外，當作沒有自訂政黨即可，
                // 不影響其他功能。
                this.customParties = [];
            }
        },

        persistCustomParties() {
            try {
                localStorage.setItem(CUSTOM_PARTIES_STORAGE_KEY, JSON.stringify(this.customParties));
            } catch (e) {
                // 同上，寫入失敗（容量滿/被封鎖）不影響當次操作，只是不會存起來。
            }
        },

        queuePartySearch() {
            clearTimeout(this._partySearchTimer);
            this._partySearchTimer = setTimeout(() => {
                const query = this.newPartyLabel.trim().toLocaleLowerCase('zh-TW');
                this.partySearchResults = query
                    ? this.partyDictionary.filter((p) => p.party_name.toLocaleLowerCase('zh-TW').includes(query)).slice(0, 8)
                    : [];
            }, 250);
        },

        choosePartySuggestion(party) {
            this.newPartyLabel = party.party_name;
            this.newPartyColor = isValidHexColor(party.color) ? party.color : FALLBACK_CANDIDATE_COLOR;
            this.partySearchResults = [];
        },

        addCustomParty() {
            const label = this.newPartyLabel.trim();

            if (! label) return;

            const color = isValidHexColor(this.newPartyColor) ? this.newPartyColor : FALLBACK_CANDIDATE_COLOR;

            this.customParties.push({ party_name: label, color });
            this.persistCustomParties();
            this.newPartyLabel = '';
            this.partySearchResults = [];
        },

        removeCustomParty(index) {
            this.customParties.splice(index, 1);
            this.persistCustomParties();
        },

        /**
         * 指定政黨給目前選取的行政區：跟點地圖切換候選人是兩條平行的「設定顯示顏色」路徑，
         * 各自獨立存在同一個節點物件上（assigned_party / assigned_candidacy_id），顯示時看
         * assigned_party 是否有值決定要用哪一個（見 colorFor()）。沒有選取行政區時什麼都
         * 不做——UI 上按鈕本來就會停用（見 index.html），這裡加一層防禦。
         */
        assignPartyToSelected(party) {
            if (! this.selectedRegion) return;

            this.selectedRegion.assigned_party = { party_name: party.party_name, color: party.color };
            this.lastEdit = null;
            this.renderCurrentLevel();
        },

        /** 遞迴把整棵樹的猜測狀態重設回實際結果，換屆別/「重設為實際結果」都會用到。 */
        initGuesses(regions) {
            for (const r of regions) {
                r.assigned_candidacy_id = r.actual_winner_candidacy_id;
                r.assigned_party = null;

                if (r.children) this.initGuesses(r.children);
            }
        },

        /**
         * 切換屆別：先把舊的主圖+所有 inset MapLibre 實例跟它們動態產生的 DOM 容器清乾淨
         * （inset 容器是 initInsetMaps() 執行期用 document.createElement 建立、掛在 #map
         * 底下的，不會因為換一份資料自動消失，一定要手動移除，不然每次切換屆別 inset 框會
         * 越疊越多），再用新選舉的資料整個重建。資料直接借用鑽層地圖那份巢狀樹（見上面
         * PREDICT_ELECTION_TYPES 註解），顯示層級/填色層級都重設回「縣市」——不同屆別的
         * 巢狀深度理論上可能不同（見已知資料缺口），保留上一屆選的層級可能對不上新資料。
         */
        async loadElection(id) {
            id = Number(id);
            const hash = this.elections.find((e) => e.id === id)?.content_hash;

            const data = await loadElectionOrHandleError(this, drillDownDataUrl(id, hash), 'drilldown', SCHEMA_VERSION_DRILLDOWN);

            if (! data) return;

            // fetchGeometriesFor() 只抓這份資料實際用得到的縣市分片（見該函式註解），
            // 失敗常見是弱網路——沒有這層 try/catch 的話畫面會永遠卡在「載入中」轉
            // 圈圈，因為底下沒有任何程式碼會把 status 改成別的值。
            let geometryStore;
            try {
                geometryStore = await fetchGeometriesFor(data.regions);
            } catch (e) {
                if (this.election) {
                    this.switchError = `切換失敗，目前仍顯示「${this.election.name}」的結果。`;
                } else {
                    this.status = 'error';
                    this.errorMessage = '地圖幾何資料載入失敗，請檢查網路連線後重試。';
                }
                return;
            }

            this.geometryStore = geometryStore;
            this.selectedElectionId = id;
            this.election = data.election;
            this.candidates = data.candidates;
            // cloneRegionTree()：猜測模式要改寫節點狀態，不能直接用 electionDataCache
            // 快取住的共用物件（見該函式註解的原始資料唯讀契約說明）。
            this.regionTree = cloneRegionTree(data.regions);
            this.initGuesses(this.regionTree);

            this.displayLevelIndex = 0;
            this.fillLevelIndex = 0;
            this.selectedRootId = null;
            this.drillPath = [];
            this.selectedRegion = null;
            // 換屆別整棵 regionTree 都會換掉新物件，lastEdit 記的是舊物件參照，留著會指向
            // 已經不在畫面上的舊節點，復原只會是無效操作，一併清掉。
            this.lastEdit = null;
            // 不分區/山地原民/平地原民立委塗好的格子是針對「這一次選舉」的猜測，換屆別
            // （或切去總統/縣市長）沒有意義繼續留著，一併清空；面板本身只在
            // election.type === 'legislator' 時才會顯示（見 totalLegislatorSeatsByParty()）。
            this.clearOtherLegislatorSeats();
            this.activePartyName = null;
            this.status = 'ready';

            rebuildMap(this, {
                containerId: 'map',
                sourceId: 'regions',
                preserveDrawingBuffer: true,
                featureCollection: () => this.featureCollectionFor(this.mainRegions),
                onLoaded: () => {
                    // rebuildMap() 的共用相機初始值仍是 6.8；預測地圖首次載入也要走一次
                    // renderCurrentLevel()，才會套用這個模式自己的全國縮放比例。
                    this.renderCurrentLevel();
                    this.initInsetMaps();
                },
            });
        },

        /**
         * 顯示層級改變：換一個全國攤平的層級當頂層，填色層級若比新的顯示層級淺就跟著
         * 提升（填色層級不能比顯示層級淺，見 fillLevelOptions()——沒有「顯示縣市形狀，
         * 但只看縣市自己一筆猜測」以外更淺的填色概念）。退回顯示層級頂層、整個重建。
         */
        setDisplayLevel(index) {
            this.displayLevelIndex = Number(index);

            if (this.fillLevelIndex < this.displayLevelIndex) {
                this.fillLevelIndex = this.displayLevelIndex;
            }

            this.drillPath = [];
            this.selectedRegion = null;
            this.insetMaps = teardownInsetMaps(this.insetMaps);
            this.renderCurrentLevel();
            this.initInsetMaps();
        },

        /** 填色層級改變：目前顯示的行政區集合不變，只有顏色（猜測聚合的深淺）要重算。 */
        setFillLevel(index) {
            this.fillLevelIndex = Number(index);
            this.renderCurrentLevel();
        },

        /**
         * 切換「只看單一行政區」：id 是空字串（<option value="">全國</option>）就回到全國
         * 攤平，否則鎖定那一個頂層節點，見 currentRegions() 註解。跟切換顯示層級一樣要
         * 退回顯示層級頂層（drillPath 清空）整個重建，不然舊的鑽層路徑可能跟新選的行政區
         * 對不上（例如原本鑽在 A 縣市底下，改選 B 縣市，路徑卻還留著 A 的節點）。
         */
        setSelectedRoot(id) {
            this.selectedRootId = id ? Number(id) : null;

            this.drillPath = [];
            this.selectedRegion = null;
            this.insetMaps = teardownInsetMaps(this.insetMaps);
            this.renderCurrentLevel();
            this.initInsetMaps();
        },

        /**
         * insets 只在「還沒鑽層、顯示層級=縣市、還沒鎖定單一行政區」這個組合下有意義——
         * 鑽進任何節點、或已經鎖定單一行政區之後子集合彼此靠近不會混到金門/連江；顯示
         * 層級不是縣市時，金門/連江的鄉鎮市/村里會被展開成好幾個獨立節點，散落在全國攤平
         * 清單裡，直接畫在主圖即可，另開小圖反而複雜化，見已知限制。
         */
        initInsetMaps() {
            if (this.drillPath.length || this.displayLevelIndex !== 0 || this.selectedRootId) return;

            const mapEl = document.getElementById('map');
            const boxSize = insetBoxSize();
            const subBoxSize = insetSubBoxSize();
            const gap = insetGap();
            let offsetBottom = 12;

            for (const { countyName, label } of INSET_COUNTIES) {
                const county = this.currentRegions.find((r) => r.name === countyName);

                if (! county) continue;

                const clusters = clusterParts(geometryFor(county, this.geometryStore));

                const box = createInsetBox(mapEl, label, boxSize, 12, 0);
                // 全畫面預測介面的控制列浮在左上角，inset 改固定在左下角，避免兩者互相遮擋；
                // 用 bottom 定位也能在視窗高度改變時自動貼齊底部，不必額外重算像素座標。
                box.style.top = 'auto';
                box.style.bottom = `${offsetBottom}px`;
                this.mountInsetMap(box, county, clusters[0].bbox, 14, label);

                // 主要陸地以外還有其他遠方離島群組（如金門的烏坵鄉），各自疊一個巢狀小框
                // 在主框右下角，跟靜態 SVG 地圖的 inset_group() 是同一套概念。
                let subOffsetY = boxSize - subBoxSize - 4;

                for (let i = 1; i < clusters.length; i++) {
                    const subBox = createInsetBox(box, '', subBoxSize, boxSize - subBoxSize - 4, subOffsetY, true);
                    this.mountInsetMap(subBox, county, clusters[i].bbox, 6);
                    subOffsetY -= subBoxSize + 4;
                }

                offsetBottom += boxSize + gap;
            }
        },

        mountInsetMap(container, region, bbox, padding, label = '') {
            // interactive: false 會連 click/mousemove 監聽都一起關掉（不是只關拖曳/縮放），
            // insets 需要保留點擊切換預測候選人的功能，改成逐一關閉手勢控制。
            // preserveDrawingBuffer: true 跟主圖同理，是「下載圖片」把 inset 一起合成進去
            // 所需要的，沒開這個選項 inset 的 canvas 內容會是空的。
            const map = new maplibregl.Map({
                container,
                style: { version: 8, sources: {}, layers: [] },
                attributionControl: false,
                preserveDrawingBuffer: true,
                dragPan: false,
                scrollZoom: false,
                doubleClickZoom: false,
                dragRotate: false,
                keyboard: false,
                touchZoomRotate: false,
                boxZoom: false,
            });

            map.on('load', () => {
                map.addSource('region', { type: 'geojson', data: this.featureCollectionFor([region]) });

                map.addLayer({
                    id: 'region-fill',
                    type: 'fill',
                    source: 'region',
                    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1 },
                });

                map.addLayer({
                    id: 'region-line',
                    type: 'line',
                    source: 'region',
                    paint: { 'line-color': '#fcfcfb', 'line-width': 1 },
                });

                map.fitBounds(bbox, { padding, animate: false });
                this.wireInteractions(map, 'region-fill');
            });

            this.insetMaps.push({ map, regionName: region.name, container, label });
        },

        wireInteractions(map, layerId) {
            map.on('click', layerId, (e) => this.onRegionClick(e));
        },

        /**
         * 到填色層級（或資料只到這裡，見 effectiveFillNodes() 註解）就直接用這個節點自己的
         * 猜測+得票率深淺；還沒到填色層級，顏色是底下填色層級節點目前猜測的多數決（哪個
         * 候選人/政黨被猜中最多次）+ 佔比深淺，兩種情況共用同一組 shareToFillColor() 上色
         * 公式，只是「深淺」代表的量不同（得票率 vs. 猜測佔比）。
         */
        colorFor(region, remainingDepth) {
            const fillNodes = effectiveFillNodes(region, remainingDepth);

            if (fillNodes.length === 1) {
                const node = fillNodes[0];

                if (node.assigned_party) return node.assigned_party.color;

                return shareToFillColor(
                    this.candidateColor(node.assigned_candidacy_id),
                    voteShareOf(node.results, node.assigned_candidacy_id),
                );
            }

            const counts = {};
            for (const node of fillNodes) {
                const key = node.assigned_party ? `party:${node.assigned_party.party_name}` : `id:${node.assigned_candidacy_id}`;
                counts[key] = (counts[key] ?? 0) + 1;
            }

            const [leadingKey, leadingCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
            const leadingColor = leadingKey.startsWith('party:')
                ? fillNodes.find((n) => n.assigned_party?.party_name === leadingKey.slice(6))?.assigned_party.color
                : this.candidateColor(Number(leadingKey.slice(3)));

            return shareToFillColor(leadingColor, leadingCount / fillNodes.length);
        },

        featureCollectionFor(regions) {
            const remainingDepth = this.fillLevelIndex - this.currentDepth;

            return {
                type: 'FeatureCollection',
                // 少數行政區沒有幾何資料（regions.boundary 上游資料缺口，見
                // CLAUDE.md「地圖上看到白色色塊」已知限制），過濾掉不畫，不是 bug。
                features: regions.map((region) => ({ region, geometry: geometryFor(region, this.geometryStore) }))
                    .filter(({ geometry }) => geometry)
                    .map(({ region, geometry }) => ({
                        type: 'Feature',
                        geometry,
                        properties: {
                            region_id: region.region_id,
                            name: region.name,
                            color: this.colorFor(region, remainingDepth),
                        },
                    })),
            };
        },

        /** 重建同一個 'regions'/inset source（不是整個重建 map 實例），換層級/鑽層/猜測都共用。 */
        renderCurrentLevel() {
            const data = this.featureCollectionFor(this.mainRegions);
            this.map.getSource('regions')?.setData(data);

            for (const { map, regionName } of this.insetMaps) {
                const region = this.currentRegions.find((r) => r.name === regionName);
                map.getSource('region')?.setData(this.featureCollectionFor(region ? [region] : []));
            }

            if (! this.drillPath.length && this.displayLevelIndex === 0 && ! this.selectedRootId) {
                this.map.jumpTo({ center: [121, 23.7], zoom: 6.0 });
            } else if (data.features.length) {
                this.map.fitBounds(unionBBox(data.features), { padding: 10, animate: false });
            }
        },

        candidateColor(candidacyId) {
            return candidateColorFrom(this.candidates, candidacyId);
        },

        candidateLabel(candidacyId) {
            return candidateLabelFrom(this.candidates, candidacyId);
        },

        /**
         * 點行政區：還沒到填色層級、且這個節點真的有子行政區可以繼續鑽，就往下鑽一層；
         * 到填色層級（或資料只到這裡，見 effectiveFillNodes() 註解）就直接循環切換這個
         * 節點的猜測——這兩種語意不會疊在同一次點擊上，填色層級本身就決定了點擊當下是在
         * 鑽層還是在猜測，不需要額外的模式開關。候選人清單改看這個節點自己的 results
         * （而不是全域 this.candidates）——縣市長這類選舉每個縣市的候選人不同組，用全域
         * 清單循環會跑出根本沒在這裡參選的人。
         */
        onRegionClick(e) {
            this.selectRegionById(smallestFeature(e.features).properties.region_id);
        },

        /**
         * 未選畫筆時點行政區只顯示明細，無論點幾次都不改預測；選好 activePartyName 後才
         * 交給 paintRegionWithActiveParty() 填色。同一支畫筆重複點擊則切換領先深淺。
         */
        selectRegionById(regionId) {
            const region = this.currentRegions.find((r) => r.region_id === regionId);

            if (! region) return;

            const remainingDepth = this.fillLevelIndex - this.currentDepth;

            if (remainingDepth > 0 && region.children && region.children.length) {
                this.drillPath.push(region);
                this.selectedRegion = null;
                this.insetMaps = teardownInsetMaps(this.insetMaps);
                this.renderCurrentLevel();
                return;
            }

            if (this.activePartyName) {
                this.paintRegionWithActiveParty(region);
                return;
            }

            this.selectedRegion = region;
        },

        /**
         * 見 selectRegionById() 註解：政黨/候選人已經填好了，再點一次改成在 colorShades()
         * 算出來的幾階深淺裡循環（跟「選一個政黨」清單旁邊那排深淺色塊是同一組函式）。額外
         * 存一個 leadIndex（見 LEAD_SHADE_LABELS），不是靠 indexOf(color) 反查目前在哪一階
         * ——hex 色碼經過 hexToRgb→rgbToHsl→hslToHex 來回轉換可能有浮點數捨入誤差，反查
         * 容易找不到剛好相等的字串；剛從側欄指定、還沒被循環過的情況本來就沒有 leadIndex，
         * 一樣當作「從最淺的那一階開始」处理，不會噴錯。
         */
        cyclePartyLeadShade(region) {
            const shades = colorShades(region.assigned_party.color);
            const currentIndex = region.assigned_party.leadIndex ?? -1;
            const nextIndex = (currentIndex + 1) % shades.length;

            region.assigned_party = { ...region.assigned_party, color: shades[nextIndex], leadIndex: nextIndex };
            this.renderCurrentLevel();
        },

        /**
         * 見 selectRegionById() 「拿畫筆直接塗」註解：activePartyName 有值時，點地圖不用
         * 先選取查看明細，直接當畫筆塗——這個行政區還沒被指定成目前這支畫筆的政黨就塗上去
         * （蓋掉原本不管是真實候選人還是別的政黨指定，「最後做的動作為準」跟其他指定路徑
         * 一致）；已經是同一支畫筆塗過的，視為使用者想調整領先幅度，改成循環深淺
         * （cyclePartyLeadShade()），不會塗一次就換回最淺那階。
         */
        paintRegionWithActiveParty(region) {
            const brush = this.assignableParties.find((p) => p.party_name === this.activePartyName);

            if (! brush) return;

            this.selectedRegion = region;

            if (region.assigned_party?.party_name === brush.party_name) {
                this.cyclePartyLeadShade(region);
                return;
            }

            this.lastEdit = null;
            region.assigned_party = { party_name: brush.party_name, color: brush.color };
            this.renderCurrentLevel();
        },

        /** 見 index.html 明細面板：這個行政區目前指定的政黨在哪一階深淺，沒指定過就回傳 null。 */
        partyLeadShadeLabel(region) {
            return LEAD_SHADE_LABELS[region?.assigned_party?.leadIndex] ?? null;
        },

        /** UX-01 單步復原：只還原 lastEdit 記的那一次候選人循環，不是完整編輯歷史。 */
        undoLastEdit() {
            if (! this.lastEdit) return;

            const { region, assigned_candidacy_id, assigned_party } = this.lastEdit;

            region.assigned_candidacy_id = assigned_candidacy_id;
            region.assigned_party = assigned_party;
            this.lastEdit = null;
            this.renderCurrentLevel();
        },

        /** 麵包屑：index=-1 回到顯示層級的頂層（全國攤平），其餘是 drillPath 的 index。 */
        goToBreadcrumb(index) {
            this.drillPath = index < 0 ? [] : this.drillPath.slice(0, index + 1);
            this.selectedRegion = null;
            this.insetMaps = teardownInsetMaps(this.insetMaps);
            this.renderCurrentLevel();
            this.initInsetMaps();
        },

        leadingResult(region) {
            return region?.results?.[0] ?? null;
        },

        votePct(result, region) {
            return region?.results ? votePctOf(result, region.results) : '0.0';
        },

        pieChartSvg(region) {
            return region ? pieChartSvgFor(region.results, this.candidates) : '';
        },

        /** 明細面板的「關閉」按鈕（見 style.css .panel-close，窄螢幕才顯示）。 */
        closeDetail() {
            this.selectedRegion = null;
            scrollToMapPane('map');
        },

        /** 「重設為實際結果」：地圖猜測、政黨改名/改色、席次格子塗色，全部退回剛載入時的狀態。 */
        resetToActual() {
            this.initGuesses(this.regionTree);
            this.lastEdit = null;
            this.currentLyParties = this._defaultLyParties.map((p) => ({ ...p }));
            this.activePartyName = null;
            this.clearOtherLegislatorSeats();
            this.renderCurrentLevel();
        },

        clearOtherLegislatorSeats() {
            for (const category of this.otherLegislatorCategories) {
                category.squares = category.squares.map(() => null);
            }
        },

        /**
         * 主圖 canvas.toDataURL() 只截得到主地圖——金門/馬祖 inset(含巢狀框)是各自獨立的
         * MapLibre 實例/canvas，不會自動出現在主圖的截圖裡。改成把每個 inset 的畫面、外框、
         * 標籤依它們在畫面上相對 #map 的實際位置，合成進同一張 offscreen canvas 再輸出，
         * 匯出的圖片才會跟畫面上看到的一致。
         *
         * 回傳 null 代表這次呼叫該放棄（未就緒或分享途中選舉被切換，見下方註解），
         * 呼叫端看到 null 直接 return。
         */
        async composeExportCanvas() {
            if (this.status !== 'ready' || ! this.map) return null;

            // 下載中使用者若切換了屆別，loadElection() 會遞增 _loadSeq、換掉 this.map——
            // 這次下載已經對不上畫面正在顯示的選舉，不能繼續產出圖片（會產出另一場選舉
            // 的畫面，卻用舊的檔名/標籤），await 之後要重新檢查一次。
            const seq = this._loadSeq;
            const allMaps = [this.map, ...this.insetMaps.map((entry) => entry.map)];

            await Promise.all(allMaps.map((map) => new Promise((resolve) => {
                map.once('render', resolve);
                map.triggerRepaint();
            })));

            if (seq !== this._loadSeq || ! this.map) return null;

            const mapRect = document.getElementById('map').getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const mainCanvas = this.map.getCanvas();

            // UX-02：圖片本身要能獨立說明「這是哪場選舉、顏色是實際得票率還是使用者猜測、
            // 顏色對應哪個候選人/政黨」，不能只靠使用者事後自己記得下載當下畫面的脈絡。
            // 頭尾各加一條文字/圖例色帶，主圖跟 inset 的合成邏輯不變，只是整體往下移
            // headerHeight 的量。
            const { legend, hasEdits } = summarizePredictionState(this.regionTree, this.candidates);
            const unitLabel = this.levels[0]?.label ?? '';
            const leadCounts = partyLeadCountsFor(this.regionTree, this.candidates);
            const MAX_TITLE_PARTIES = 3;
            const titleHiddenCount = leadCounts.length - MAX_TITLE_PARTIES;
            const titleText = leadCounts.slice(0, MAX_TITLE_PARTIES)
                .map((p) => `${p.partyName} ${p.count}${unitLabel}`)
                .join('・') + (titleHiddenCount > 0 ? `・其餘 ${titleHiddenCount} 個政黨` : '');
            const headerHeight = 56 * dpr;
            const legendRowHeight = 20 * dpr;
            const legendPadding = 12 * dpr;
            // 圖例理論上可能很長（多個自訂政黨+多個候選人），圖片高度不能無上限跟著長，
            // 超過上限就只列前面幾個+一行「其餘 N 個」，不逐一列出。
            const MAX_LEGEND_ROWS = 10;
            const legendRows = legend.slice(0, MAX_LEGEND_ROWS);
            const hiddenLegendCount = legend.length - legendRows.length;
            const legendHeight = legendPadding * 2 + (legendRows.length + (hiddenLegendCount > 0 ? 1 : 0)) * legendRowHeight;

            const offscreen = document.createElement('canvas');
            offscreen.width = mainCanvas.width;
            offscreen.height = headerHeight + mainCanvas.height + legendHeight;
            const ctx = offscreen.getContext('2d');

            ctx.fillStyle = '#fcfcfb';
            ctx.fillRect(0, 0, offscreen.width, offscreen.height);

            ctx.fillStyle = '#242320';
            ctx.textBaseline = 'top';
            ctx.font = `bold ${16 * dpr}px system-ui, sans-serif`;
            ctx.fillText(titleText || (this.election?.name ?? '（未知選舉）'), 12 * dpr, 8 * dpr);
            ctx.font = `${11 * dpr}px system-ui, sans-serif`;
            ctx.fillStyle = '#52514e';
            ctx.fillText(
                hasEdits
                    ? '⚠ 顏色為使用者自行修改過的預測結果，非官方實際開票結果'
                    : '顏色為歷史實際得票率（尚未修改預測）',
                12 * dpr,
                30 * dpr
            );
            ctx.fillText('台灣選舉地圖', 12 * dpr, 44 * dpr);

            ctx.drawImage(mainCanvas, 0, headerHeight);

            for (const { map, container, label } of this.insetMaps) {
                const rect = container.getBoundingClientRect();
                const x = (rect.left - mapRect.left) * dpr;
                const y = (rect.top - mapRect.top) * dpr + headerHeight;
                const w = rect.width * dpr;
                const h = rect.height * dpr;

                ctx.fillStyle = '#fcfcfb';
                ctx.fillRect(x, y, w, h);
                ctx.drawImage(map.getCanvas(), x, y, w, h);
                ctx.strokeStyle = '#c3c2b7';
                ctx.lineWidth = dpr;
                ctx.strokeRect(x, y, w, h);

                if (label) {
                    ctx.fillStyle = '#52514e';
                    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
                    ctx.textBaseline = 'top';
                    ctx.fillText(label, x + 4 * dpr, y + 2 * dpr);
                }
            }

            let legendY = headerHeight + mainCanvas.height + legendPadding;

            for (const entry of legendRows) {
                ctx.fillStyle = entry.color;
                ctx.fillRect(12 * dpr, legendY + 3 * dpr, 12 * dpr, 12 * dpr);
                ctx.fillStyle = '#242320';
                ctx.font = `${12 * dpr}px system-ui, sans-serif`;
                ctx.textBaseline = 'top';
                ctx.fillText(entry.label, 30 * dpr, legendY + 2 * dpr);
                legendY += legendRowHeight;
            }

            if (hiddenLegendCount > 0) {
                ctx.fillStyle = '#8a8879';
                ctx.font = `${12 * dpr}px system-ui, sans-serif`;
                ctx.fillText(`其餘 ${hiddenLegendCount} 項未列出`, 12 * dpr, legendY + 2 * dpr);
            }

            return offscreen;
        },

        exportFileName() {
            return `${this.election?.name ?? 'prediction-map'}.png`;
        },

        downloadCanvas(canvas, filename) {
            const link = document.createElement('a');
            link.download = filename;
            link.href = canvas.toDataURL('image/png');
            link.click();
        },

        /** 見 shareStatus 宣告處的註解：分享/下載本身都沒有明顯畫面變化。 */
        flashShareStatus(message) {
            this.shareStatus = message;
            clearTimeout(this._shareStatusTimer);
            this._shareStatusTimer = setTimeout(() => { this.shareStatus = ''; }, 4000);
        },

        /**
         * 「分享」跟「下載圖片」用同一張合成好的圖，差在最後怎麼交給使用者：支援檔案分享
         * 的瀏覽器（主要是手機版 Safari/Chrome）叫出系統原生分享選單，可以直接分享到
         * IG/Line/Threads 等 App；不支援的瀏覽器退回「下載圖片」。
         *
         * navigator.canShare({ files }) 才是真的檢查「這個瀏覽器支援分享檔案」——
         * navigator.share 存在不代表支援分享檔案（部分瀏覽器只支援分享文字/連結），
         * 兩者都要拿到實際的 File 之後才能檢查，不能只靠 typeof navigator.share 判斷。
         */
        async shareImage() {
            const canvas = await this.composeExportCanvas();

            if (! canvas) return;

            const filename = this.exportFileName();
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

            if (! blob) {
                this.downloadCanvas(canvas, filename);
                this.flashShareStatus('無法產生圖片，已改為下載');
                return;
            }

            const file = new File([blob], filename, { type: 'image/png' });

            if (! navigator.canShare?.({ files: [file] })) {
                this.downloadCanvas(canvas, filename);
                this.flashShareStatus('此瀏覽器不支援分享，已改為下載圖片');
                return;
            }

            try {
                await navigator.share({ files: [file], title: this.election?.name ?? '台灣選舉地圖' });
            } catch (e) {
                // 使用者自己在系統分享選單按取消是正常操作（AbortError），不是失敗，不用
                // 額外處理（也不提示，使用者自己取消不需要被告知）；其他真的失敗的情況
                // （例如系統分享功能本身出錯）才退回下載，讓使用者至少能拿到圖片。
                if (e.name !== 'AbortError') {
                    this.downloadCanvas(canvas, filename);
                    this.flashShareStatus('分享失敗，已改為下載圖片');
                }
            }
        },
    };
}

const THEME_STORAGE_KEY = 'tw-election-map:theme';

// 比照 loadCustomPartiesFromStorage() 的既有處理方式：無痕視窗/瀏覽器封鎖 localStorage
// 時讀取會丟例外，退回預設的 dark 主題即可，不能讓這個例外中斷 Alpine store 的初始化。
function readStoredTheme() {
    try {
        return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
    } catch (e) {
        return 'dark';
    }
}

// 這段是頁面載入時就要跑的 top-level 註冊（不是某個 Alpine 元件內部的方法），瀏覽器裡
// document 一定存在；guard 只是為了讓 node:test 用 require() 讀這個檔案取純函式時
// （見檔案最後的 module.exports 區塊）不會因為 Node 沒有 document 而直接噴例外中斷載入。
if (typeof document !== 'undefined') {
    document.addEventListener('alpine:init', () => {
        Alpine.store('ui', {
            mode: 'predict',
            theme: readStoredTheme(),

            init() {
                document.documentElement.setAttribute('data-theme', this.theme);
            },

            toggleTheme() {
                this.theme = this.theme === 'light' ? 'dark' : 'light';
                document.documentElement.setAttribute('data-theme', this.theme);
                try {
                    localStorage.setItem(THEME_STORAGE_KEY, this.theme);
                } catch (e) {
                    // 無痕視窗/瀏覽器封鎖 localStorage 時寫入會丟例外，不影響當次切換，
                    // 只是下次載入不會記住（比照 persistCustomParties() 的既有處理方式）。
                }
            },
        });
    });
}

/**
 * 歷屆選舉地圖：單純瀏覽 election:export-drilldown-data 匯出的實際得票結果，點行政區鑽入
 * 子行政區，不做 predictionMap() 那種「猜候選人」互動——C1/D1/D2 這類地方選舉每個行政區
 * 的候選人都不同組，套用「點一下換下一個候選人」的猜測遊戲沒有意義，而且點擊的語意會
 * 跟「點擊=鑽層」衝突（見討論：同一個點擊動作不能同時做兩件事）。
 *
 * 2026-09-09 整合了原本獨立的村里長席次地圖/原住民選區地圖：這兩種選舉的巢狀樹用同一個
 * election:export-drilldown-data 就能匯出（見 DRILLDOWN_AGGREGATE_FROM_DEPTH 註解），
 * 只是縣市/鄉鎮市區層級的 results 是後端把不相干候選人的票數硬加在一起、沒有意義，改用
 * colorFor()/regionResultsFor() 往下彙總政黨多數決顯示，不直接讀那層的 results。議員/
 * 代表選區地圖（districtMap()）維持獨立分頁不整合進來——它的地理單位是「選區」（一個縣市
 * 切成好幾個選區，不是行政區劃），跟這裡「縣市→鄉鎮市區→村里」的巢狀行政區劃不是同一種
 * 地理單位，套不進 path/currentRegions 這套鑽層邏輯。
 */
function drillDownMap() {
    return {
        // 見 predictionMap() 同一個欄位的註解：一定要先宣告，不能只靠 init() 動態賦值。
        _initialized: false,
        _loadSeq: 0,
        status: 'loading',
        errorMessage: '',
        switchError: '',
        map: null,
        elections: [],
        selectedElectionId: null,
        election: null,
        candidates: [],
        rootRegions: [],
        // 見 predictionMap() 同一個欄位的註解。
        geometryStore: null,
        path: [],
        insetMaps: [],
        hoveredRegion: null,
        tooltipPos: { x: 0, y: 0 },
        selectedRegion: null,
        // 窄螢幕下選舉清單改成可收合（見 style.css .election-sidebar.is-collapsed），
        // 預設收合——桌面版這個旗標沒有作用（CSS 只在窄螢幕斷點下才讀 is-collapsed）。
        mobileNavOpen: false,

        /** 目前顯示的行政區清單：還沒鑽層時是頂層，鑽過之後是 path 最後一層的 children。 */
        get currentRegions() {
            return this.path.length ? (this.path[this.path.length - 1].children ?? []) : this.rootRegions;
        },

        /** currentRegions 目前這一批節點的深度（頂層是 0），見 DRILLDOWN_AGGREGATE_FROM_DEPTH 判斷用。 */
        get currentDepth() {
            return this.path.length;
        },

        /**
         * 金門/連江（縣市長/總統/不分區立委頂層本身就是「金門縣/連江縣」這兩筆完整名稱；
         * 鄉鎮市長/原住民區長頂層直接是底下個別鄉鎮；區域立委頂層是選舉區，名稱帶縣市/
         * 鄉鎮名前綴，如「金門縣第01選區」「南竿鄉選舉區」）用「名稱是否以分組裡任一
         * 名稱開頭」判斷，同時涵蓋這幾種頂層粒度，比對 districtMap() 的 insetGroupFor()
         * 同一種做法（見該函式註解）。改成前綴比對前是精確比對（`insetNames.has(r.name)`），
         * 對「縣市/鄉鎮」這兩種頂層本來就是精確比對的特例（名稱本身就等於分組名稱），改成
         * 前綴比對不影響既有行為。
         */
        insetGroupFor(name) {
            return DRILLDOWN_INSET_GROUPS.find((g) => g.names.some((n) => name.startsWith(n)));
        },

        /**
         * 主圖實際要畫的行政區：鑽入某個行政區之後，子集合本來就彼此靠近（不會混到金門/
         * 連江），直接沿用 currentRegions；還在頂層時，把 DRILLDOWN_INSET_GROUPS 涵蓋的
         * 行政區排除掉，避免主圖 fitBounds 為了塞進這兩個離台灣本島很遠的離島而整個縮小
         * ——跟預測地圖 mainRegions 是同一個處理方式，這兩個離島改在 initInsetMaps() 另開
         * 小地圖顯示。
         */
        get mainRegions() {
            if (this.path.length) return this.currentRegions;

            return this.currentRegions.filter((r) => ! this.insetGroupFor(r.name));
        },

        get breadcrumb() {
            return this.path.map((r) => ({ region_id: r.region_id, name: r.name }));
        },

        async init() {
            if (this._initialized) return;
            this._initialized = true;

            watchModeOnce(this, 'drilldown', () => this.start());
        },

        async start() {
            this.status = 'loading';

            try {
                this.elections = await fetchJsonOrThrow(DRILLDOWN_INDEX_URL);
            } catch (e) {
                this.status = 'error';
                this.errorMessage = '選舉清單載入失敗，請檢查網路連線後重試。';
                return;
            }

            if (! this.elections.length) {
                this.status = 'empty';
                return;
            }

            await this.loadElection(this.elections[0].id);
        },

        retryInit() {
            this._initialized = false;
            this.init();
        },

        /**
         * 切換選舉：整個重建地圖，不嘗試就地更新——不同選舉的頂層層級（county/township）
         * 跟行政區集合都不一樣，比照 predictionMap() 的 loadElection() 整個重來最簡單。
         */
        async loadElection(id) {
            id = Number(id);
            const hash = this.elections.find((e) => e.id === id)?.content_hash;

            const data = await loadElectionOrHandleError(this, drillDownDataUrl(id, hash), 'drilldown', SCHEMA_VERSION_DRILLDOWN);

            if (! data) return;

            // 見 predictionMap() loadElection() 同一段註解：fetchGeometriesFor() 失敗要
            // 自己接住，不然畫面會永遠卡在「載入中」。
            let geometryStore;
            try {
                geometryStore = await fetchGeometriesFor(data.regions);
            } catch (e) {
                if (this.election) {
                    this.switchError = `切換失敗，目前仍顯示「${this.election.name}」的結果。`;
                } else {
                    this.status = 'error';
                    this.errorMessage = '地圖幾何資料載入失敗，請檢查網路連線後重試。';
                }
                return;
            }

            this.geometryStore = geometryStore;
            this.selectedElectionId = id;
            this.election = data.election;
            this.candidates = data.candidates;
            this.rootRegions = data.regions;
            this.path = [];
            this.selectedRegion = null;
            this.hoveredRegion = null;
            this.status = 'ready';

            rebuildMap(this, {
                containerId: 'drilldown-map',
                sourceId: 'regions',
                featureCollection: () => this.featureCollectionFor(this.mainRegions),
                onLoaded: () => {
                    this.fitToCurrentRegions();
                    this.initInsetMaps();
                },
            });
        },

        wireInteractions(map, layerId) {
            map.on('click', layerId, (e) => this.onRegionClick(e));
            map.on('mousemove', layerId, (e) => this.onRegionHover(e));
            map.on('mouseleave', layerId, () => { this.hoveredRegion = null; });

            // 見 predictionMap() wireInteractions() 同一段註解：手機沒有 mouseleave，
            // 不清掉的話點過的行政區 tooltip 會卡在畫面上蓋住地圖。
            map.on('touchend', layerId, () => { this.hoveredRegion = null; });
            map.on('touchcancel', layerId, () => { this.hoveredRegion = null; });
        },

        /**
         * 頂層才會混到金門/連江（見 mainRegions），鑽入任何一個行政區之後子集合彼此靠近，
         * 不需要 inset，直接跳出。DRILLDOWN_INSET_GROUPS 每組各自開一個小地圖，跟預測地圖
         * initInsetMaps() 疊在主圖左上角的位置邏輯一致。
         */
        initInsetMaps() {
            if (this.path.length) return;

            const mapEl = document.getElementById('drilldown-map');
            const boxSize = insetBoxSize();
            let offsetX = 12;

            for (const { label, names } of DRILLDOWN_INSET_GROUPS) {
                const regions = this.currentRegions.filter((r) => names.some((n) => r.name.startsWith(n)) && geometryFor(r, this.geometryStore));

                if (! regions.length) continue;

                const box = createInsetBox(mapEl, label, boxSize, offsetX, 12);
                this.mountInsetMap(box, regions, boxSize);
                offsetX += boxSize + insetGap();
            }
        },

        mountInsetMap(container, regions, boxSize = INSET_BOX_SIZE_DESKTOP) {
            const map = new maplibregl.Map({
                container,
                style: { version: 8, sources: {}, layers: [] },
                attributionControl: false,
                preserveDrawingBuffer: true,
                dragPan: false,
                scrollZoom: false,
                doubleClickZoom: false,
                dragRotate: false,
                keyboard: false,
                touchZoomRotate: false,
                boxZoom: false,
            });

            map.on('load', () => {
                const data = this.featureCollectionFor(regions);
                map.addSource('inset-regions', { type: 'geojson', data });

                map.addLayer({
                    id: 'inset-regions-fill',
                    type: 'fill',
                    source: 'inset-regions',
                    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1 },
                });

                map.addLayer({
                    id: 'inset-regions-line',
                    type: 'line',
                    source: 'inset-regions',
                    paint: { 'line-color': '#fcfcfb', 'line-width': 1 },
                });

                // 縣市長選舉頂層每組只有一筆「整個縣」的 MultiPolygon，可能含跟主要島嶼群
                // 隔很遠的離群小塊（如金門縣的烏坵鄉，甚至縣市層級簡化流程本身可能產生的
                // 細碎殘片）——直接對整筆取聯集框，fitBounds 為了塞進這些離群點會把鏡頭拉到
                // 兩邊都搆不著的中間海域，導致 inset 畫面整個空掉。比照預測地圖同一個縣市
                // inset 的作法，用 clusterParts() 只對焦到「主要陸地那一群」。
                //
                // 鄉鎮市長/原住民區長選舉頂層雖然本來就是好幾筆彼此靠近的獨立行政區（不是
                // 單一 MultiPolygon），但「彼此靠近」這個假設在金門縣底下的烏坵鄉本身會
                // 破功——烏坵鄉自己就是那個離群小塊（見上一段），只是縣市長選舉頂層看到的
                // 是「金門縣」整個縣的單一 MultiPolygon（內含烏坵），鄉鎮市長層級看到的是
                // 「烏坵鄉」自己一筆獨立的行政區，一樣跟金門本島群距離很遠。全國村里
                // parent_id 資料修復後才第一次看到完整的鄉鎮市長/原住民區長合併鑽層資料
                // （見 DECISIONS.md），才浮現這個先前一直沒被觸發到的既有缺口：多筆行政區
                // 各自的 MultiPolygon 攤平成同一組多邊形，一樣用 clusterParts() 只對焦到
                // 「總面積最大那一群」，不分「整個縣一筆」還是「好幾個獨立行政區」兩種情況。
                const polygons = regions.flatMap((r) => {
                    const geometry = geometryFor(r, this.geometryStore);

                    return geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
                });
                const bbox = clusterParts({ type: 'MultiPolygon', coordinates: polygons })[0].bbox;

                map.jumpTo(cameraForBounds(bbox, boxSize, 16));
                this.wireInteractions(map, 'inset-regions-fill');
            });

            this.insetMaps.push({ map, container });
        },

        featureCollectionFor(regions) {
            return {
                type: 'FeatureCollection',
                // 少數行政區沒有幾何資料（regions.boundary 上游資料缺口，見
                // CLAUDE.md「地圖上看到白色色塊」已知限制），過濾掉不畫，不是 bug。
                features: regions.map((region) => ({ region, geometry: geometryFor(region, this.geometryStore) }))
                    .filter(({ geometry }) => geometry)
                    .map(({ region, geometry }) => ({
                        type: 'Feature',
                        geometry,
                        properties: {
                            region_id: region.region_id,
                            name: region.name,
                            color: this.colorFor(region),
                        },
                    })),
            };
        },

        /**
         * 見 DRILLDOWN_AGGREGATE_FROM_DEPTH 註解：還沒到「同一場真的共用候選人名單的
         * 選舉」那一層，用底下政黨多數決上色；到了就直接用這個行政區自己的實際結果——
         * 跟 predictionMap() colorFor() 同一套 shareToFillColor() 深淺公式，只是這裡永遠
         * 顯示「實際」而非「猜測」。
         */
        colorFor(region) {
            const remaining = this.regionAggregateRemaining();

            if (remaining > 0) {
                const results = this.aggregatePartyResults(region, remaining);
                const winnerId = results[0]?.candidacy_id ?? null;

                return shareToFillColor(candidateColorFrom(results, winnerId), voteShareOf(results, winnerId));
            }

            return shareToFillColor(
                candidateColorFrom(this.candidates, region.actual_winner_candidacy_id),
                voteShareOf(region.results, region.actual_winner_candidacy_id),
            );
        },

        /** 這場選舉、在目前深度，是否還沒到共用候選人名單那一層——> 0 代表要往下彙總。 */
        regionAggregateRemaining() {
            const threshold = DRILLDOWN_AGGREGATE_FROM_DEPTH[this.election?.type] ?? 0;

            return threshold - this.currentDepth;
        },

        /**
         * 還沒到共用候選人名單那一層時，往下彙總「底下有多少單位是哪個政黨贏的」多數決，
         * 格式借用跟村里長席次/議員代表選區地圖的 party_seats 一樣的
         * {candidacy_id, label, party_name, color, votes} 形狀（candidacy_id 用負數避免
         * 跟真的候選人 id 衝突），讓 notableResultsOf()/pieChartSvgFor()/votePctOf() 這些
         * 共用純函式可以直接重用，不用另外寫一份聚合版的圖表邏輯。
         */
        aggregatePartyResults(region, remaining) {
            const fillNodes = effectiveFillNodes(region, remaining);
            const counts = new Map();

            for (const node of fillNodes) {
                const partyName = partyNameFrom(this.candidates, node.actual_winner_candidacy_id) ?? '無資料';

                if (! counts.has(partyName)) {
                    counts.set(partyName, {
                        party_name: partyName,
                        color: candidateColorFrom(this.candidates, node.actual_winner_candidacy_id),
                        votes: 0,
                    });
                }

                counts.get(partyName).votes += 1;
            }

            return [...counts.values()]
                .sort((a, b) => b.votes - a.votes)
                .map((p, i) => ({ candidacy_id: -(i + 1), label: p.party_name, party_name: p.party_name, color: p.color, votes: p.votes }));
        },

        /** 這個行政區「該顯示的得票結果」：見 regionAggregateRemaining() 判斷直接用實際
         * 結果、還是往下彙總的政黨多數決。 */
        regionResultsFor(region) {
            const remaining = this.regionAggregateRemaining();

            return remaining > 0 ? this.aggregatePartyResults(region, remaining) : (region?.results ?? []);
        },

        /** 搭配 regionResultsFor()：彙總結果的 candidacy_id 是借用的負數，查色碼/標籤/
         * 黨名要從彙總結果自己（每筆已經帶齊 label/color/party_name）查，不是查
         * this.candidates（那裡面沒有負數 id）。 */
        regionCandidatesFor(region) {
            return this.regionAggregateRemaining() > 0 ? this.regionResultsFor(region) : this.candidates;
        },

        fitToCurrentRegions() {
            // 頂層看的範圍跟互動預測地圖一樣（全國扣掉另開 inset 的金門/連江），直接沿用
            // 預測地圖手動校準過的固定 zoom/center（見 loadElection() 建 map 時的初始值），
            // 比動態 fitBounds 更穩定貼合容器、主島看起來也比較大。鑽進某個行政區之後範圍
            // 縮小很多，改回動態 fitBounds 依實際子集合對焦。
            if (! this.path.length) {
                this.map.jumpTo({ center: [121, 23.7], zoom: 6.8 });
                return;
            }

            const features = this.featureCollectionFor(this.mainRegions).features;

            if (! features.length) return;

            this.map.fitBounds(unionBBox(features), { padding: 10, animate: false });
        },

        /**
         * 重建同一個 MapLibre source（不是整個重建 map 實例）：鑽層/返回上一層只是換
         * 「目前顯示哪一層的行政區清單」，地圖跟圖層設定不用重來，比照計畫檔說的
         * 「用鑽層資料重建同一個 MapLibre source」。inset 是否要顯示則取決於新的層級是否
         * 回到頂層，先整組拆掉再視情況重建，不嘗試判斷「這次跟上次比多了/少了哪個」。
         */
        renderCurrentLevel() {
            this.insetMaps = teardownInsetMaps(this.insetMaps);
            this.map.getSource('regions')?.setData(this.featureCollectionFor(this.mainRegions));
            this.fitToCurrentRegions();
            this.initInsetMaps();
        },

        onRegionClick(e) {
            this.selectRegionById(smallestFeature(e.features).properties.region_id);
        },

        /**
         * 手機沒有 hover，原本「點一下就鑽進去」會讓人根本來不及看到這個行政區的得票就
         * 跳到下一層。改成跟 predictionMap() selectRegionById() 同一套 UX-01 節奏：第一次
         * 點只選取、側欄顯示明細，不鑽層；已經選取的行政區（側欄顯示的就是它）再點一次，
         * 才視為使用者確認要鑽進去看底下的行政區——不用真的做滑鼠/觸控 dblclick 計時
         * （難跟系統手勢、時間閾值打架），點兩下的節奏在觸控/鍵盤上都一樣好用。
         */
        selectRegionById(regionId) {
            const region = this.currentRegions.find((r) => r.region_id === regionId);

            if (! region) return;

            if (this.selectedRegion?.region_id !== regionId) {
                this.selectedRegion = region;
                return;
            }

            if (region.children && region.children.length) {
                this.path.push(region);
                this.selectedRegion = null;
                // 鑽層後地圖換成下一層的行政區，遊標位置對應的行政區跟著換了，但滑鼠沒動
                // 不會再觸發 mousemove——不清掉的話 tooltip 會卡在鑽層前那個行政區的舊資料。
                this.hoveredRegion = null;
                this.renderCurrentLevel();
            }
        },

        onRegionHover(e) {
            this.hoveredRegion = this.currentRegions.find((r) => r.region_id === smallestFeature(e.features).properties.region_id) ?? null;

            updateTooltipPosition(this, document.getElementById('drilldown-map'), e.originalEvent.clientX, e.originalEvent.clientY);
        },

        /** 鍵盤清單用的 hover 等效操作（focus 觸發）。 */
        hoverRegionById(regionId) {
            this.hoveredRegion = this.currentRegions.find((r) => r.region_id === regionId) ?? null;
        },

        /** 麵包屑：index=-1 回到頂層，其餘是 path 的 index（含點擊的那一層）。 */
        goToBreadcrumb(index) {
            this.path = index < 0 ? [] : this.path.slice(0, index + 1);
            this.selectedRegion = null;
            this.hoveredRegion = null;
            this.renderCurrentLevel();
        },

        /**
         * candidacyId 可能是 aggregatePartyResults() 借用的負數 id（見該函式註解），這種
         * id 查不到 this.candidates，呼叫端要傳對應的 regionCandidatesFor(region) 進來；
         * 沒傳（predictionMap() 那種永遠查真候選人的情境）就退回 this.candidates。
         */
        candidateColor(candidacyId, candidates = this.candidates) {
            return candidateColorFrom(candidates, candidacyId);
        },

        candidateLabel(candidacyId, candidates = this.candidates) {
            return candidateLabelFrom(candidates, candidacyId);
        },

        /** hover tooltip 改列「得票率 >5% 或主要政黨候選人」，見 notableResultsOf() 註解。 */
        notableResults(region) {
            return region ? notableResultsOf(this.regionResultsFor(region), this.regionCandidatesFor(region)) : [];
        },

        votePct(result, region) {
            return region ? votePctOf(result, this.regionResultsFor(region)) : '0.0';
        },

        pieChartSvg(region) {
            return region ? pieChartSvgFor(this.regionResultsFor(region), this.regionCandidatesFor(region)) : '';
        },

        /** 明細面板的「關閉」按鈕（見 style.css .panel-close，窄螢幕才顯示）。 */
        closeDetail() {
            this.selectedRegion = null;
            scrollToMapPane('drilldown-map');
        },
    };
}

/**
 * 議員/代表選區地圖：election:export-district-map-data 匯出的選區級候選人得票+政黨席次
 * 分佈（T1/T2/T3/R1/R2/R3 共用同一份匯出格式，見 ElectionResultsMapBuilder::
 * districtMapExportDataFor() 註解），單純瀏覽，跟 drillDownMap() 同一種「不做猜測
 * 互動」的瀏覽模式；地理單位是「選區」不是行政區劃，見 drillDownMap() 註解說明為什麼
 * 沒有整合進那一頁。
 *
 * 每個選區的 `candidates` 陣列已經是 {candidacy_id, label, party_name, color, votes,
 * is_elected} 這個形狀，跟 predictionMap()/drillDownMap() 的 candidates+results 兩份
 * 資料合併成一份——直接把同一個陣列當 pieChartSvgFor()/candidateColorFrom() 需要的
 * candidates 清單重複使用，不用像 drillDownMap() 的 aggregatePartyResults() 那樣另外
 * 映射一份形狀。
 */
function districtMap() {
    return {
        // 見 predictionMap() 同一個欄位的註解：一定要先宣告，不能只靠 init() 動態賦值。
        _initialized: false,
        _loadSeq: 0,
        status: 'loading',
        errorMessage: '',
        switchError: '',
        map: null,
        insetMaps: [],
        election: null,
        districts: [],
        // 見 predictionMap() 同一個欄位的註解。
        geometryStore: null,
        hoveredDistrict: null,
        tooltipPos: { x: 0, y: 0 },
        selectedDistrict: null,
        elections: [],
        selectedElectionId: null,
        // 見 drillDownMap() 同一個欄位的註解。
        mobileNavOpen: false,

        /** 金門/連江（T1 是整個縣、R1 是縣底下的個別鄉鎮）比照鑽層地圖用名稱前綴分組。 */
        insetGroupFor(name) {
            return DRILLDOWN_INSET_GROUPS.find((g) => g.names.some((n) => name.startsWith(n)));
        },

        get mainDistricts() {
            return this.districts.filter((d) => ! this.insetGroupFor(d.name));
        },

        get partyTotals() {
            const totals = {};

            for (const district of this.districts) {
                for (const p of district.party_seats) {
                    const key = p.party_name ?? '其他';

                    if (! totals[key]) {
                        totals[key] = { party_name: key, seats: 0, color: p.color };
                    }

                    totals[key].seats += p.seats;
                }
            }

            return Object.values(totals).sort((a, b) => b.seats - a.seats);
        },

        async init() {
            if (this._initialized) return;
            this._initialized = true;

            watchModeOnce(this, 'district', () => this.start());
        },

        async start() {
            this.status = 'loading';

            try {
                this.elections = await fetchJsonOrThrow(DISTRICT_MAP_INDEX_URL);
            } catch (e) {
                this.status = 'error';
                this.errorMessage = '選舉清單載入失敗，請檢查網路連線後重試。';
                return;
            }

            if (! this.elections.length) {
                this.status = 'empty';
                return;
            }

            await this.loadElection(this.elections[0].id);
        },

        retryInit() {
            this._initialized = false;
            this.init();
        },

        async loadElection(id) {
            id = Number(id);
            const hash = this.elections.find((e) => e.id === id)?.content_hash;

            const data = await loadElectionOrHandleError(this, districtMapDataUrl(id, hash), 'district-map', SCHEMA_VERSION_DISTRICT_MAP);

            if (! data) return;

            // 見 predictionMap() loadElection() 同一段註解：fetchGeometriesFor() 失敗要
            // 自己接住，不然畫面會永遠卡在「載入中」。
            let geometryStore;
            try {
                geometryStore = await fetchGeometriesFor(data.districts);
            } catch (e) {
                if (this.election) {
                    this.switchError = `切換失敗，目前仍顯示「${this.election.name}」的結果。`;
                } else {
                    this.status = 'error';
                    this.errorMessage = '地圖幾何資料載入失敗，請檢查網路連線後重試。';
                }
                return;
            }

            this.geometryStore = geometryStore;
            this.selectedElectionId = id;
            this.selectedDistrict = null;
            this.hoveredDistrict = null;

            this.election = data.election;
            this.districts = data.districts;
            this.status = 'ready';

            rebuildMap(this, {
                containerId: 'district-map',
                sourceId: 'districts',
                featureCollection: () => this.featureCollectionFor(this.mainDistricts),
                onLoaded: () => this.initInsetMaps(),
            });
        },

        initInsetMaps() {
            const mapEl = document.getElementById('district-map');
            const boxSize = insetBoxSize();
            let offsetX = 12;

            for (const { label, names } of DRILLDOWN_INSET_GROUPS) {
                const districts = this.districts.filter((d) => names.some((n) => d.name.startsWith(n)));

                if (! districts.length) continue;

                const box = createInsetBox(mapEl, label, boxSize, offsetX, 12);
                this.mountInsetMap(box, districts, boxSize);
                offsetX += boxSize + insetGap();
            }
        },

        mountInsetMap(container, districts, boxSize = INSET_BOX_SIZE_DESKTOP) {
            const map = new maplibregl.Map({
                container,
                style: { version: 8, sources: {}, layers: [] },
                attributionControl: false,
                dragPan: false,
                scrollZoom: false,
                doubleClickZoom: false,
                dragRotate: false,
                keyboard: false,
                touchZoomRotate: false,
                boxZoom: false,
            });

            map.on('load', () => {
                const data = this.featureCollectionFor(districts);
                map.addSource('inset-districts', { type: 'geojson', data });

                map.addLayer({
                    id: 'inset-districts-fill',
                    type: 'fill',
                    source: 'inset-districts',
                    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1 },
                });

                map.addLayer({
                    id: 'inset-districts-line',
                    type: 'line',
                    source: 'inset-districts',
                    paint: { 'line-color': '#fcfcfb', 'line-width': 1 },
                });

                // 金門/連江在這個模式下一律是好幾個各自獨立的選區 feature（T1 是縣底下
                // 2~4 個選區、R1 是好幾個鄉鎮各自的選區），不會是單一 MultiPolygon，直接
                // 對整組取聯集框即可，跟 drillDownMap() 的鄉鎮市長頂層同一種情況。
                map.jumpTo(cameraForBounds(unionBBox(data.features), boxSize, 16));
                this.wireInteractions(map, 'inset-districts-fill');
            });

            this.insetMaps.push({ map, container });
        },

        wireInteractions(map, layerId) {
            map.on('click', layerId, (e) => this.onDistrictClick(e));
            map.on('mousemove', layerId, (e) => this.onDistrictHover(e));
            map.on('mouseleave', layerId, () => { this.hoveredDistrict = null; });

            // 見 predictionMap() wireInteractions() 同一段註解：手機沒有 mouseleave，
            // 不清掉的話點過的選區 tooltip 會卡在畫面上蓋住地圖。
            map.on('touchend', layerId, () => { this.hoveredDistrict = null; });
            map.on('touchcancel', layerId, () => { this.hoveredDistrict = null; });
        },

        featureCollectionFor(districts) {
            return {
                type: 'FeatureCollection',
                features: districts.map((district) => ({ district, geometry: geometryFor(district, this.geometryStore) }))
                    .filter(({ geometry }) => geometry)
                    .map(({ district, geometry }) => ({
                        type: 'Feature',
                        geometry,
                        properties: {
                            district_id: district.district_id,
                            name: district.name,
                            color: shareToFillColor(district.color, (district.party_seats[0]?.seats ?? 0) / district.total_seats),
                        },
                    })),
            };
        },

        onDistrictClick(e) {
            this.selectDistrictById(smallestFeature(e.features).properties.district_id);
        },

        /** 讓鍵盤選區清單重用同一套選取邏輯（A11Y-01）。 */
        selectDistrictById(districtId) {
            this.selectedDistrict = this.districts.find((d) => d.district_id === districtId) ?? null;
        },

        onDistrictHover(e) {
            this.hoveredDistrict = this.districts.find((d) => d.district_id === smallestFeature(e.features).properties.district_id) ?? null;

            updateTooltipPosition(this, document.getElementById('district-map'), e.originalEvent.clientX, e.originalEvent.clientY);
        },

        /** 鍵盤清單用的 hover 等效操作（focus 觸發）。 */
        hoverDistrictById(districtId) {
            this.hoveredDistrict = this.districts.find((d) => d.district_id === districtId) ?? null;
        },

        votePct(candidate, district) {
            return votePctOf(candidate, district.candidates);
        },

        seatPct(partySeat, district) {
            return district?.total_seats ? ((partySeat.seats / district.total_seats) * 100).toFixed(1) : '0.0';
        },

        pieChartSvg(district) {
            return district ? pieChartSvgFor(district.candidates, district.candidates) : '';
        },

        /** 明細面板的「關閉」按鈕（見 style.css .panel-close，窄螢幕才顯示）。 */
        closeDetail() {
            this.selectedDistrict = null;
            scrollToMapPane('district-map');
        },
    };
}

// 這個檔案在瀏覽器裡是用 <script> 標籤載入的一般 script（不是 ES module，見
// frontend/README.md「沒有 build 工具」），所以上面這些頂層 function/let 在瀏覽器裡本來
// 就是同一個 top-level scope 的一部分，彼此互相看得到，不需要 export。但同一份原始碼在
// Node 的 `node:test` 底下是被當成 CommonJS module 載入（`require()`），頂層宣告預設不會
// 外露——這裡補一個只有 Node 環境才會執行的 module.exports（瀏覽器沒有全域的 `module`，
// 這個 if 區塊整段會被跳過，不影響瀏覽器行為），只導出不摸 DOM/MapLibre 的純函式，讓
// frontend/test/ 底下的測試可以直接 require 到它們。會建立 DOM 元素或操作 MapLibre 實例
// 的函式（createInsetBox/teardownInsetMaps 等）刻意不導出——那些需要真的瀏覽器環境，
// 不是 node:test 這種輕量單元測試該涵蓋的範圍。
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        withVersion,
        checkSchemaVersion,
        bboxOfRing,
        ringArea,
        smallestFeature,
        clusterParts,
        isValidHexColor,
        candidateColorFrom,
        candidateLabelFrom,
        partyNameFrom,
        voteShareOf,
        shareToFillColor,
        hexToRgb,
        rgbToHsl,
        hslToHex,
        flattenAtLevel,
        effectiveFillNodes,
        cloneRegionTree,
        votePctOf,
        notableResultsOf,
        pieChartSvgFor,
        summarizePredictionState,
        tooltipPositionFor,
        mercatorX,
        mercatorY,
        cameraForBounds,
        unionBBox,
        loadCurrentLyParties,
        fetchElectionData,
        loadElectionOrHandleError,
        geometryFor,
        fetchGeometriesFor,
        fetchGeometryChunk,
        chunkKeysFor,
        deepFreeze,
        electionDataCache,
        ELECTION_DATA_CACHE_LIMIT,
        readStoredTheme,
        SCHEMA_VERSION_DRILLDOWN,
        SCHEMA_VERSION_DISTRICT_MAP,
        SCHEMA_VERSION_GEOMETRIES,
    };
}
