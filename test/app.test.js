// 只測 app.js 裡不摸 DOM/MapLibre 的純函式（見 app.js 檔案末尾 module.exports 區塊的
// 說明）。Alpine 綁定跟地圖生命週期需要真的瀏覽器，不是這裡的範圍——用 Playwright 手動/
// 既有流程驗證（見 DECISIONS.md）。
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const app = require(path.join(__dirname, '..', 'js', 'app.js'));

describe('withVersion', () => {
    test('appends ?v={hash} when a hash is given', () => {
        assert.equal(app.withVersion('data/election-1.json', 'abc123'), 'data/election-1.json?v=abc123');
    });

    test('returns the url unchanged when there is no hash', () => {
        assert.equal(app.withVersion('data/election-1.json', undefined), 'data/election-1.json');
        assert.equal(app.withVersion('data/election-1.json', ''), 'data/election-1.json');
    });
});

describe('checkSchemaVersion', () => {
    test('warns when schema_version does not match what the frontend expects', () => {
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);

        try {
            app.checkSchemaVersion('prediction', { schema_version: 2 }, 1);
        } finally {
            console.warn = originalWarn;
        }

        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /schema_version=2/);
        assert.match(warnings[0], /預期 1/);
    });

    test('does not warn when versions match', () => {
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);

        try {
            app.checkSchemaVersion('prediction', { schema_version: 1 }, 1);
        } finally {
            console.warn = originalWarn;
        }

        assert.equal(warnings.length, 0);
    });

    test('does not warn when the data file has no schema_version at all (older export)', () => {
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);

        try {
            app.checkSchemaVersion('prediction', {}, 1);
        } finally {
            console.warn = originalWarn;
        }

        assert.equal(warnings.length, 0);
    });
});

describe('bboxOfRing', () => {
    test('computes the bounding box of a set of points', () => {
        const bbox = app.bboxOfRing([[120, 22], [121, 25], [119.5, 23]]);

        assert.deepEqual(bbox, { minLon: 119.5, minLat: 22, maxLon: 121, maxLat: 25 });
    });
});

describe('ringArea', () => {
    test('computes the area of a simple square polygon', () => {
        const square = { type: 'Polygon', coordinates: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]] };

        assert.equal(app.ringArea(square), 100);
    });

    test('sums the area of a MultiPolygon across all its parts', () => {
        const multi = {
            type: 'MultiPolygon',
            coordinates: [
                [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]],
                [[[0, 0], [0, 5], [5, 5], [5, 0], [0, 0]]],
            ],
        };

        assert.equal(app.ringArea(multi), 125);
    });
});

describe('smallestFeature', () => {
    // 對應 2026-09-08 的真實回報：hover 臺北市顯示成新北市——縣市級 choropleth 為了蓋掉
    // 內環洞口對不準的已知坑，把新北市的填色範圍強制填實蓋住臺北市，兩者在臺北市範圍內
    // 同時被 MapLibre 命中，且命中順序不保證等於畫面疊圖順序，所以不能相信 e.features[0]。
    const bigRegion = { properties: { region_id: 'new-taipei' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 100], [100, 100], [100, 0], [0, 0]]] } };
    const smallRegion = { properties: { region_id: 'taipei' }, geometry: { type: 'Polygon', coordinates: [[[40, 40], [40, 60], [60, 60], [60, 40], [40, 40]]] } };

    test('picks the smaller-area feature when the big one is listed first (the actual bug scenario)', () => {
        const picked = app.smallestFeature([bigRegion, smallRegion]);

        assert.equal(picked.properties.region_id, 'taipei');
    });

    test('picks the smaller-area feature regardless of hit-test order', () => {
        const picked = app.smallestFeature([smallRegion, bigRegion]);

        assert.equal(picked.properties.region_id, 'taipei');
    });

    test('returns the only feature without computing area when there is no overlap', () => {
        assert.equal(app.smallestFeature([bigRegion]), bigRegion);
    });
});

describe('candidateColorFrom / candidateLabelFrom', () => {
    const candidates = [{ candidacy_id: 1, color: '#2a78d6', label: '中國國民黨 侯友宜' }];

    test('returns the matching candidate color/label', () => {
        assert.equal(app.candidateColorFrom(candidates, 1), '#2a78d6');
        assert.equal(app.candidateLabelFrom(candidates, 1), '中國國民黨 侯友宜');
    });

    test('falls back to a neutral color / placeholder label when the candidacy is not found', () => {
        assert.equal(app.candidateColorFrom(candidates, 999), '#898781');
        assert.equal(app.candidateLabelFrom(candidates, 999), '無資料');
    });

    test('falls back to a neutral color when the stored color is not a valid hex code (SEC-02/SEC-03)', () => {
        const tampered = [{ candidacy_id: 1, color: '#fff" onload="alert(1)' }];

        assert.equal(app.candidateColorFrom(tampered, 1), '#898781');
    });
});

describe('summarizePredictionState (UX-02: exported image needs a legend + actual-vs-predicted label)', () => {
    const candidates = [
        { candidacy_id: 1, color: '#2a78d6', label: '甲', party_name: '甲黨' },
        { candidacy_id: 2, color: '#d62a2a', label: '乙', party_name: '乙黨' },
    ];

    test('reports hasEdits: false and a legend built from candidates when nothing was changed from the actual result', () => {
        const regions = [
            { assigned_candidacy_id: 1, actual_winner_candidacy_id: 1, assigned_party: null, children: [] },
            { assigned_candidacy_id: 2, actual_winner_candidacy_id: 2, assigned_party: null, children: [] },
        ];

        const { legend, hasEdits } = app.summarizePredictionState(regions, candidates);

        assert.equal(hasEdits, false);
        assert.deepEqual(legend, [
            { label: '甲', color: '#2a78d6' },
            { label: '乙', color: '#d62a2a' },
        ]);
    });

    test('reports hasEdits: true when a candidate guess was cycled away from the actual winner', () => {
        const regions = [{ assigned_candidacy_id: 2, actual_winner_candidacy_id: 1, assigned_party: null, children: [] }];

        assert.equal(app.summarizePredictionState(regions, candidates).hasEdits, true);
    });

    test('reports hasEdits: true and includes the custom party color when a party was assigned', () => {
        const regions = [{
            assigned_candidacy_id: 1,
            actual_winner_candidacy_id: 1,
            assigned_party: { party_name: '自訂黨', color: '#00ff00' },
            children: [],
        }];

        const { legend, hasEdits } = app.summarizePredictionState(regions, candidates);

        assert.equal(hasEdits, true);
        assert.deepEqual(legend, [{ label: '自訂黨', color: '#00ff00' }]);
    });

    test('walks children and de-duplicates repeated candidates/parties into one legend entry', () => {
        const regions = [
            {
                assigned_candidacy_id: 1,
                actual_winner_candidacy_id: 1,
                assigned_party: null,
                children: [
                    { assigned_candidacy_id: 1, actual_winner_candidacy_id: 1, assigned_party: null, children: [] },
                    { assigned_candidacy_id: 2, actual_winner_candidacy_id: 2, assigned_party: null, children: [] },
                ],
            },
        ];

        const { legend } = app.summarizePredictionState(regions, candidates);

        assert.equal(legend.length, 2);
    });
});

describe('tooltipPositionFor (UI-01: tooltip must stay inside the map container)', () => {
    const containerSize = { width: 400, height: 300 };
    const tooltipSize = { width: 120, height: 60 };

    test('offsets to the bottom-right of the cursor when there is room', () => {
        const pos = app.tooltipPositionFor({ x: 50, y: 50 }, tooltipSize, containerSize);

        assert.deepEqual(pos, { x: 64, y: 64 });
    });

    test('flips to the left of the cursor when the right edge would overflow', () => {
        const pos = app.tooltipPositionFor({ x: 350, y: 50 }, tooltipSize, containerSize);

        assert.equal(pos.x, 350 - 14 - tooltipSize.width);
        assert.ok(pos.x + tooltipSize.width <= containerSize.width);
    });

    test('flips above the cursor when the bottom edge would overflow', () => {
        const pos = app.tooltipPositionFor({ x: 50, y: 270 }, tooltipSize, containerSize);

        assert.equal(pos.y, 270 - 14 - tooltipSize.height);
        assert.ok(pos.y + tooltipSize.height <= containerSize.height);
    });

    test('clamps into the container even when both edges would overflow (bottom-right corner)', () => {
        const pos = app.tooltipPositionFor({ x: 395, y: 295 }, tooltipSize, containerSize);

        assert.ok(pos.x >= 0 && pos.x + tooltipSize.width <= containerSize.width);
        assert.ok(pos.y >= 0 && pos.y + tooltipSize.height <= containerSize.height);
    });

    test('clamps to 0 rather than going negative when the tooltip is larger than the container', () => {
        const pos = app.tooltipPositionFor({ x: 5, y: 5 }, { width: 500, height: 400 }, containerSize);

        assert.equal(pos.x, 0);
        assert.equal(pos.y, 0);
    });
});

describe('isValidHexColor', () => {
    test('accepts 3-digit and 6-digit hex colors', () => {
        assert.equal(app.isValidHexColor('#fff'), true);
        assert.equal(app.isValidHexColor('#2a78d6'), true);
    });

    test('rejects anything that is not a bare hex color, including attribute-breakout attempts', () => {
        assert.equal(app.isValidHexColor('#fff" onload="alert(1)'), false);
        assert.equal(app.isValidHexColor('red'), false);
        assert.equal(app.isValidHexColor(''), false);
        assert.equal(app.isValidHexColor(null), false);
        assert.equal(app.isValidHexColor(undefined), false);
    });
});

describe('partyNameFrom', () => {
    const candidates = [{ candidacy_id: 1, party_name: '中國國民黨' }, { candidacy_id: 2, party_name: null }];

    test('returns the matching candidacy party name', () => {
        assert.equal(app.partyNameFrom(candidates, 1), '中國國民黨');
    });

    test('returns null for an independent candidacy or one not found', () => {
        assert.equal(app.partyNameFrom(candidates, 2), null);
        assert.equal(app.partyNameFrom(candidates, 999), null);
    });
});

describe('voteShareOf', () => {
    test('computes the vote share of one candidacy among the results', () => {
        const results = [{ candidacy_id: 1, votes: 30 }, { candidacy_id: 2, votes: 70 }];

        assert.equal(app.voteShareOf(results, 1), 0.3);
        assert.equal(app.voteShareOf(results, 2), 0.7);
    });

    test('returns 0 when total votes is 0 (avoids division by zero)', () => {
        assert.equal(app.voteShareOf([{ candidacy_id: 1, votes: 0 }], 1), 0);
    });

    test('returns 0 for a candidacy_id not present in results', () => {
        assert.equal(app.voteShareOf([{ candidacy_id: 1, votes: 10 }], 999), 0);
    });
});

describe('rgbToHsl / hslToHex', () => {
    test('round-trips a color through hex -> hsl -> hex unchanged', () => {
        for (const hex of ['#000099', '#28c8c8', '#1b9431', '#898781']) {
            const { h, s, l } = app.rgbToHsl(app.hexToRgb(hex));
            assert.equal(app.hslToHex(h, s, l), hex);
        }
    });

    test('a fully desaturated color (gray) has s = 0', () => {
        assert.equal(app.rgbToHsl(app.hexToRgb('#898989')).s, 0);
    });
});

describe('shareToFillColor', () => {
    test('clamps to the exact candidate color at/above the 55% threshold', () => {
        assert.equal(app.shareToFillColor('#28c8c8', 0.55), '#28c8c8');
        assert.equal(app.shareToFillColor('#28c8c8', 1), '#28c8c8');
    });

    test('below the 35% threshold, keeps the same hue/saturation and only lightens', () => {
        const base = app.rgbToHsl(app.hexToRgb('#000099'));
        const weak = app.rgbToHsl(app.hexToRgb(app.shareToFillColor('#000099', 0)));

        // 色相/飽和度不變（浮點誤差給一點容許值），只有明度變淺——這是這次改版的重點：
        // 不再像舊版 RGB 混白那樣把飽和度一起拖到 0，領先幅度小的行政區還是看得出色相。
        assert.ok(Math.abs(weak.h - base.h) < 0.01);
        assert.ok(Math.abs(weak.s - base.s) < 0.01);
        assert.ok(weak.l > base.l);
    });

    test('lightness increases monotonically as vote share drops', () => {
        const lightnessOf = (share) => app.rgbToHsl(app.hexToRgb(app.shareToFillColor('#28c8c8', share))).l;

        assert.ok(lightnessOf(0) > lightnessOf(0.4) && lightnessOf(0.4) > lightnessOf(0.55));
    });

    test('a fully desaturated candidate color stays gray at any share', () => {
        assert.equal(app.rgbToHsl(app.hexToRgb(app.shareToFillColor('#898989', 0))).s, 0);
    });
});

describe('flattenAtLevel', () => {
    const tree = [
        {
            name: 'County A',
            children: [
                { name: 'Township A1', children: [{ name: 'Village A1a' }, { name: 'Village A1b' }] },
                { name: 'Township A2', children: [{ name: 'Village A2a' }] },
            ],
        },
        {
            name: 'County B',
            // 資料只到鄉鎮市這層就沒有村里了（已知資料缺口），children 是空陣列。
            children: [{ name: 'Township B1', children: [] }],
        },
    ];

    test('depth 0 returns the roots unchanged', () => {
        assert.deepEqual(app.flattenAtLevel(tree, 0), tree);
    });

    test('depth 1 flattens every county into its townships nationwide', () => {
        const names = app.flattenAtLevel(tree, 1).map((r) => r.name);
        assert.deepEqual(names, ['Township A1', 'Township A2', 'Township B1']);
    });

    test('depth 2 flattens into villages, stopping early on branches without that depth', () => {
        const names = app.flattenAtLevel(tree, 2).map((r) => r.name);
        // Township B1 沒有 children，提早停在自己這一筆，不是 bug。
        assert.deepEqual(names, ['Village A1a', 'Village A1b', 'Village A2a', 'Township B1']);
    });
});

describe('effectiveFillNodes', () => {
    const region = {
        name: 'County A',
        children: [
            { name: 'Township A1', children: [{ name: 'Village A1a' }, { name: 'Village A1b' }] },
            { name: 'Township A2', children: [] },
        ],
    };

    test('remainingDepth <= 0 returns the node itself', () => {
        assert.deepEqual(app.effectiveFillNodes(region, 0), [region]);
        assert.deepEqual(app.effectiveFillNodes(region, -1), [region]);
    });

    test('remainingDepth 1 collects the direct children', () => {
        const names = app.effectiveFillNodes(region, 1).map((r) => r.name);
        assert.deepEqual(names, ['Township A1', 'Township A2']);
    });

    test('remainingDepth 2 recurses further, stopping early on childless branches', () => {
        const names = app.effectiveFillNodes(region, 2).map((r) => r.name);
        // Township A2 沒有 children，提早停在自己這一筆，不是 bug。
        assert.deepEqual(names, ['Village A1a', 'Village A1b', 'Township A2']);
    });
});

describe('votePctOf', () => {
    test('formats the vote percentage to one decimal place', () => {
        const results = [{ votes: 30 }, { votes: 70 }];

        assert.equal(app.votePctOf({ votes: 30 }, results), '30.0');
    });

    test('returns "0.0" when total votes is 0', () => {
        assert.equal(app.votePctOf({ votes: 0 }, [{ votes: 0 }]), '0.0');
    });
});

describe('notableResultsOf', () => {
    const candidates = [
        { candidacy_id: 1, party_name: '中國國民黨' },
        { candidacy_id: 2, party_name: '民主進步黨' },
        { candidacy_id: 3, party_name: '無黨籍' },
    ];

    test('keeps candidacies with more than 5% vote share', () => {
        const results = [
            { candidacy_id: 1, votes: 60 },
            { candidacy_id: 2, votes: 38 },
            { candidacy_id: 3, votes: 2 },
        ];

        const notable = app.notableResultsOf(results, candidates, new Set());

        assert.deepEqual(notable.map((r) => r.candidacy_id), [1, 2]);
    });

    test('also keeps a low-share candidacy whose party currently holds legislative seats', () => {
        const results = [
            { candidacy_id: 1, votes: 97 },
            { candidacy_id: 3, votes: 3 }, // 3% share, below the 5% cutoff on its own
        ];

        const withoutNotableParty = app.notableResultsOf(results, candidates, new Set());
        assert.deepEqual(withoutNotableParty.map((r) => r.candidacy_id), [1]);

        const withNotableParty = app.notableResultsOf(results, candidates, new Set(['無黨籍']));
        assert.deepEqual(withNotableParty.map((r) => r.candidacy_id), [1, 3]);
    });

    test('returns an empty array when total votes is 0', () => {
        assert.deepEqual(app.notableResultsOf([{ candidacy_id: 1, votes: 0 }], candidates, new Set()), []);
    });
});

describe('pieChartSvgFor', () => {
    const candidates = [
        { candidacy_id: 1, color: '#2a78d6' },
        { candidacy_id: 2, color: '#1baf7a' },
    ];

    test('returns one <path> per candidacy for a normal split', () => {
        const svg = app.pieChartSvgFor([{ candidacy_id: 1, votes: 30 }, { candidacy_id: 2, votes: 70 }], candidates);

        assert.equal((svg.match(/<path/g) || []).length, 2);
        assert.match(svg, /fill="#2a78d6"/);
        assert.match(svg, /fill="#1baf7a"/);
    });

    test('uses the full-circle path for a candidacy with ~100% of the vote (avoids a degenerate zero-length arc)', () => {
        const svg = app.pieChartSvgFor([{ candidacy_id: 1, votes: 100 }], candidates);

        assert.equal((svg.match(/<path/g) || []).length, 1);
        assert.match(svg, /A 50 50 0 1 1/);
    });

    test('returns an empty string when total votes is 0', () => {
        assert.equal(app.pieChartSvgFor([{ candidacy_id: 1, votes: 0 }], candidates), '');
    });
});

describe('mercatorX / mercatorY', () => {
    test('maps longitude 0 to the horizontal center of the tile', () => {
        assert.equal(app.mercatorX(0), 0.5);
    });

    test('maps longitude ±180 to the tile edges', () => {
        assert.equal(app.mercatorX(180), 1);
        assert.equal(app.mercatorX(-180), 0);
    });

    test('maps latitude 0 to the vertical center of the tile', () => {
        assert.ok(Math.abs(app.mercatorY(0) - 0.5) < 1e-9);
    });
});

describe('unionBBox', () => {
    test('unions the bounding boxes of multiple GeoJSON features', () => {
        const features = [
            { geometry: { type: 'Polygon', coordinates: [[[120, 22], [120.5, 22.5]]] } },
            { geometry: { type: 'Polygon', coordinates: [[[121, 24], [121.5, 24.5]]] } },
        ];

        assert.deepEqual(app.unionBBox(features), [[120, 22], [121.5, 24.5]]);
    });

    test('skips features with no geometry', () => {
        const features = [
            { geometry: null },
            { geometry: { type: 'Polygon', coordinates: [[[120, 22], [120.5, 22.5]]] } },
        ];

        assert.deepEqual(app.unionBBox(features), [[120, 22], [120.5, 22.5]]);
    });
});

describe('cameraForBounds', () => {
    test('returns a finite zoom and a center within the given bounds', () => {
        const bbox = [[120, 22], [122, 25]];
        const { center, zoom } = app.cameraForBounds(bbox, 720, 20);

        assert.ok(Number.isFinite(zoom));
        assert.deepEqual(center, [121, 23.5]);
    });
});

describe('clusterParts', () => {
    test('groups a compact polygon into a single cluster', () => {
        const geometry = {
            type: 'Polygon',
            coordinates: [[[120, 22], [120, 22.5], [120.5, 22.5], [120.5, 22], [120, 22]]],
        };

        const clusters = app.clusterParts(geometry);

        assert.equal(clusters.length, 1);
    });

    test('splits a far-away small island into its own cluster (Kinmen/Wuqiu-style layout)', () => {
        // 本島（大面積）+ 一個遠在 >0.3 度外、面積佔比夠大（>0.5%）的小島，兩塊應該分成
        // 兩群，不能被主圖 cluster 吞掉——這正是 app.js 註解描述的金門/烏坵情境。
        const mainIsland = [[120, 22], [120, 23], [121, 23], [121, 22], [120, 22]];
        const distantIsland = [[125, 22], [125, 22.1], [125.1, 22.1], [125.1, 22], [125, 22]];

        const geometry = { type: 'MultiPolygon', coordinates: [[mainIsland], [distantIsland]] };

        const clusters = app.clusterParts(geometry);

        assert.equal(clusters.length, 2);
    });

    test('drops a tiny, insignificant speck far from the main island', () => {
        const mainIsland = [[120, 22], [120, 23], [121, 23], [121, 22], [120, 22]];
        // 面積遠小於主島的 0.5% 門檻（見 MIN_CLUSTER_AREA_RATIO 註解），應該被濾掉。
        const speck = [[125, 22], [125, 22.001], [125.001, 22.001], [125.001, 22], [125, 22]];

        const geometry = { type: 'MultiPolygon', coordinates: [[mainIsland], [speck]] };

        const clusters = app.clusterParts(geometry);

        assert.equal(clusters.length, 1);
    });
});

// LOAD-07: localStorage 讀取丟例外（無痕視窗/被封鎖）不能中斷主題初始化，要退回預設值。
describe('readStoredTheme', () => {
    test('falls back to dark when localStorage is unavailable (throws on access)', () => {
        // Node 環境本來就沒有全域 localStorage，讀取會丟 ReferenceError——這正好模擬
        // 瀏覽器端 localStorage 被封鎖/丟例外時的狀況，不需要額外 stub。
        assert.equal(typeof globalThis.localStorage, 'undefined');
        assert.equal(app.readStoredTheme(), 'dark');
    });
});

// LOAD-10: predictionMap 的猜測狀態不能寫回 electionDataCache 共用的原始資料物件。
describe('cloneRegionTree', () => {
    test('mutating a cloned node does not affect the original object', () => {
        const original = [
            {
                region_id: 1,
                name: '甲縣',
                assigned_candidacy_id: 10,
                children: [{ region_id: 2, name: '甲鄉', assigned_candidacy_id: 20, children: null }],
            },
        ];

        const cloned = app.cloneRegionTree(original);
        cloned[0].assigned_candidacy_id = 999;
        cloned[0].children[0].assigned_candidacy_id = 888;

        assert.equal(original[0].assigned_candidacy_id, 10);
        assert.equal(original[0].children[0].assigned_candidacy_id, 20);
        assert.equal(cloned[0].assigned_candidacy_id, 999);
        assert.equal(cloned[0].children[0].assigned_candidacy_id, 888);
    });

    test('large fields like results keep the same reference (not deep-cloned)', () => {
        const results = [{ candidacy_id: 1, votes: 100 }];
        const original = [{ region_id: 1, name: '甲縣', results, children: null }];

        const cloned = app.cloneRegionTree(original);

        assert.equal(cloned[0].results, results);
    });

    test('geometry_hash (幾何去重參照，見 geometryFor()) is copied through untouched', () => {
        const original = [{ region_id: 1, name: '甲縣', geometry_hash: 'abc123', children: null }];

        const cloned = app.cloneRegionTree(original);

        assert.equal(cloned[0].geometry_hash, 'abc123');
    });

    test('still produces a mutable clone when the source tree is deep-frozen (Stage 4 item 3: read-only cache contract)', () => {
        const original = [{
            region_id: 1,
            name: '甲縣',
            assigned_candidacy_id: 10,
            results: [{ candidacy_id: 10, votes: 100 }],
            children: [{ region_id: 2, name: '甲鄉', assigned_candidacy_id: 20, results: [], children: null }],
        }];

        app.deepFreeze(original);

        const cloned = app.cloneRegionTree(original);
        cloned[0].assigned_candidacy_id = 999;
        cloned[0].children[0].assigned_candidacy_id = 888;

        assert.equal(cloned[0].assigned_candidacy_id, 999);
        assert.equal(cloned[0].children[0].assigned_candidacy_id, 888);
        assert.equal(original[0].assigned_candidacy_id, 10);
    });
});

describe('deepFreeze (第四階段第 3 項：electionDataCache 的原始資料唯讀契約)', () => {
    test('freezes nested objects and arrays, not just the top level', () => {
        const data = { regions: [{ region_id: 1, results: [{ candidacy_id: 1, votes: 1 }] }] };

        app.deepFreeze(data);

        assert.equal(Object.isFrozen(data), true);
        assert.equal(Object.isFrozen(data.regions), true);
        assert.equal(Object.isFrozen(data.regions[0]), true);
        assert.equal(Object.isFrozen(data.regions[0].results), true);
        assert.equal(Object.isFrozen(data.regions[0].results[0]), true);
    });

    test('a write attempt on a frozen nested field does not take effect (non-strict script context)', () => {
        const data = { regions: [{ region_id: 1, assigned_candidacy_id: 1 }] };

        app.deepFreeze(data);
        data.regions[0].assigned_candidacy_id = 999;

        assert.equal(data.regions[0].assigned_candidacy_id, 1);
    });

    test('handles null/primitive fields and circular-free trees without throwing', () => {
        const data = { election: { name: 'X' }, note: null, count: 3, tags: ['a', 'b'] };

        assert.doesNotThrow(() => app.deepFreeze(data));
        assert.equal(Object.isFrozen(data.tags), true);
    });
});

// LOAD-11: 政黨資料首次載入失敗後，不能把失敗結果永久當成「查無政黨」快取住，下次呼叫
// 要能重新 fetch 並恢復清單。
describe('geometryFor (幾何去重：resolve geometry_hash 回實際 GeoJSON geometry)', () => {
    const store = new Map([
        ['hash-a', { type: 'Polygon', coordinates: [[[0, 0]]] }],
        ['hash-b', { type: 'MultiPolygon', coordinates: [] }],
    ]);

    test('returns the geometry the hash resolves to', () => {
        assert.deepEqual(app.geometryFor({ geometry_hash: 'hash-a' }, store), { type: 'Polygon', coordinates: [[[0, 0]]] });
    });

    test('returns null when geometry_hash is null (known data gap, see CLAUDE.md)', () => {
        assert.equal(app.geometryFor({ geometry_hash: null }, store), null);
    });

    test('returns null when the hash is not found in the store instead of throwing', () => {
        assert.equal(app.geometryFor({ geometry_hash: 'missing' }, store), null);
    });
});

describe('chunkKeysFor (幾何分片：從頂層節點找出要抓哪幾份分片檔)', () => {
    test('dedupes chunk keys and drops nodes without one', () => {
        const keys = app.chunkKeysFor([
            { name: 'a', geometry_chunk: '甲縣' },
            { name: 'b', geometry_chunk: '金門縣' },
            { name: 'c', geometry_chunk: '甲縣' },
            { name: 'd', geometry_chunk: null },
            { name: 'e' },
        ]);

        assert.deepEqual(keys, ['甲縣', '金門縣']);
    });
});

describe('fetchGeometryChunk/fetchGeometriesFor (幾何去重表按縣市分片，只抓用得到的分片)', () => {
    let realFetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    test('fetches one chunk and only fetches it once across repeated calls', async () => {
        let fetchCallCount = 0;

        globalThis.fetch = () => {
            fetchCallCount += 1;

            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ schema_version: 1, chunk: '測試縣A', geometries: { h1: { type: 'Polygon', coordinates: [] } } }),
            });
        };

        const [store1, store2] = await Promise.all([app.fetchGeometryChunk('測試縣A'), app.fetchGeometryChunk('測試縣A')]);

        assert.equal(fetchCallCount, 1);
        assert.equal(store1, store2);
        assert.ok(store1 instanceof Map);
        assert.deepEqual(store1.get('h1'), { type: 'Polygon', coordinates: [] });
    });

    test('a failed chunk fetch is not cached forever; a later call retries', async () => {
        let fetchCallCount = 0;

        globalThis.fetch = () => {
            fetchCallCount += 1;

            return fetchCallCount === 1
                ? Promise.resolve({ ok: false, status: 500 })
                : Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ schema_version: 1, chunk: '測試縣B', geometries: { h2: { type: 'Polygon', coordinates: [] } } }),
                });
        };

        await assert.rejects(() => app.fetchGeometryChunk('測試縣B'));

        const store = await app.fetchGeometryChunk('測試縣B');
        assert.equal(fetchCallCount, 2);
        assert.ok(store.has('h2'));
    });

    test('fetchGeometriesFor() fetches only the chunks referenced by the given top-level items, merged into one Map', async () => {
        const requestedUrls = [];

        globalThis.fetch = (url) => {
            requestedUrls.push(url);

            const chunk = decodeURIComponent(url.match(/geometries\/(.+)\.json$/)[1]);

            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    schema_version: 1,
                    chunk,
                    geometries: { [`hash-${chunk}`]: { type: 'Polygon', coordinates: [chunk] } },
                }),
            });
        };

        const merged = await app.fetchGeometriesFor([
            { name: 'x', geometry_chunk: '測試縣C' },
            { name: 'y', geometry_chunk: '測試縣D' },
        ]);

        assert.equal(requestedUrls.length, 2);
        assert.ok(merged instanceof Map);
        assert.deepEqual(merged.get('hash-測試縣C'), { type: 'Polygon', coordinates: ['測試縣C'] });
        assert.deepEqual(merged.get('hash-測試縣D'), { type: 'Polygon', coordinates: ['測試縣D'] });
    });
});

describe('fetchElectionData (Stage 4: shared in-flight requests + bounded LRU cache)', () => {
    let realFetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
        app.electionDataCache.clear();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        app.electionDataCache.clear();
    });

    test('two concurrent calls for the same URL share one in-flight fetch instead of downloading twice', async () => {
        let fetchCallCount = 0;

        globalThis.fetch = () => {
            fetchCallCount += 1;

            return Promise.resolve({ ok: true, json: () => Promise.resolve({ marker: 'race-test' }) });
        };

        const [first, second] = await Promise.all([
            app.fetchElectionData('data/election-race.json', 'drilldown', 1),
            app.fetchElectionData('data/election-race.json', 'drilldown', 1),
        ]);

        assert.equal(fetchCallCount, 1);
        assert.equal(first, second);
        assert.equal(first.marker, 'race-test');
    });

    test('successfully fetched data is deep-frozen before being cached (Stage 4 item 3: read-only cache contract)', async () => {
        globalThis.fetch = () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ regions: [{ region_id: 1, assigned_candidacy_id: 1 }] }),
        });

        const data = await app.fetchElectionData('data/election-frozen.json', 'drilldown', 1);

        assert.equal(Object.isFrozen(data), true);
        assert.equal(Object.isFrozen(data.regions[0]), true);
    });

    test('a failed request is not cached forever; a later call retries and can succeed', async () => {
        globalThis.fetch = () => Promise.reject(new Error('network down'));

        await assert.rejects(app.fetchElectionData('data/election-retry.json', 'drilldown', 1));

        globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ marker: 'recovered' }) });

        const recovered = await app.fetchElectionData('data/election-retry.json', 'drilldown', 1);

        assert.equal(recovered.marker, 'recovered');
    });

    test('the cache evicts the least-recently-used entry once it grows past ELECTION_DATA_CACHE_LIMIT', async () => {
        globalThis.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve({ url }) });

        const urls = Array.from({ length: app.ELECTION_DATA_CACHE_LIMIT }, (_, i) => `data/election-${i}.json`);

        for (const url of urls) {
            await app.fetchElectionData(url, 'drilldown', 1);
        }

        assert.equal(app.electionDataCache.size, app.ELECTION_DATA_CACHE_LIMIT);

        // 再命中一次最舊那筆，把它搬到最近使用的一端，接著塞一筆新的應該改砍
        // 「次舊」那筆，不是剛被 touch 過的這筆。
        await app.fetchElectionData(urls[0], 'drilldown', 1);
        await app.fetchElectionData('data/election-overflow.json', 'drilldown', 1);

        assert.equal(app.electionDataCache.size, app.ELECTION_DATA_CACHE_LIMIT);
        assert.equal(app.electionDataCache.has(urls[0]), true);
        assert.equal(app.electionDataCache.has(urls[1]), false);
        assert.equal(app.electionDataCache.has('data/election-overflow.json'), true);
    });
});

describe('loadElectionOrHandleError (第四階段第 4 項：三個模式共用的載入+錯誤處理邏輯)', () => {
    let realFetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
        app.electionDataCache.clear();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        app.electionDataCache.clear();
    });

    function makeComponent(overrides = {}) {
        return { _loadSeq: 0, election: null, switchError: '', status: 'loading', errorMessage: '', ...overrides };
    }

    test('returns the fetched data and leaves error state untouched on success', async () => {
        globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ election: { name: 'X' } }) });

        const component = makeComponent();
        const data = await app.loadElectionOrHandleError(component, 'data/election-ok.json', 'drilldown', 1);

        assert.deepEqual(data, { election: { name: 'X' } });
        assert.equal(component.switchError, '');
        assert.equal(component.status, 'loading');
    });

    test('first load failure (no prior election) sets status=error with a message, and returns null', async () => {
        globalThis.fetch = () => Promise.reject(new Error('network down'));

        const component = makeComponent();
        const data = await app.loadElectionOrHandleError(component, 'data/election-fail-1.json', 'drilldown', 1);

        assert.equal(data, null);
        assert.equal(component.status, 'error');
        assert.ok(component.errorMessage.length > 0);
        assert.equal(component.switchError, '');
    });

    test('switch failure (an election is already showing) sets switchError instead of status=error, and keeps the old election name in the message', async () => {
        globalThis.fetch = () => Promise.reject(new Error('network down'));

        const component = makeComponent({ election: { name: '舊選舉' }, status: 'ready' });
        const data = await app.loadElectionOrHandleError(component, 'data/election-fail-2.json', 'drilldown', 1);

        assert.equal(data, null);
        assert.equal(component.status, 'ready');
        assert.ok(component.switchError.includes('舊選舉'));
    });

    test('a stale request (superseded by a newer _loadSeq while in flight) returns null and does not touch component state', async () => {
        const component = makeComponent({ election: { name: '舊選舉' }, status: 'ready' });

        globalThis.fetch = () => {
            // 模擬「fetch 還沒回來，使用者已經又觸發一次更新的請求」：外部直接把 _loadSeq
            // 搶先加一，回傳資料時應該被判定過期而丟棄，不覆寫任何狀態。
            component._loadSeq += 1;

            return Promise.resolve({ ok: true, json: () => Promise.resolve({ election: { name: 'Y' } }) });
        };

        const data = await app.loadElectionOrHandleError(component, 'data/election-stale.json', 'drilldown', 1);

        assert.equal(data, null);
        assert.equal(component.switchError, '');
        assert.equal(component.status, 'ready');
        assert.equal(component.election.name, '舊選舉');
    });
});

describe('loadCurrentLyParties', () => {
    test('failure is not cached forever and a later successful call recovers the list', async () => {
        const realFetch = globalThis.fetch;
        try {
            globalThis.fetch = () => Promise.reject(new Error('network down'));

            const first = await app.loadCurrentLyParties();
            assert.equal(first.failed, true);
            assert.deepEqual(first.parties, []);

            globalThis.fetch = () =>
                Promise.resolve({
                    json: () => Promise.resolve({ parties: [{ party_name: '測試黨', color: '#123456' }] }),
                });

            const second = await app.loadCurrentLyParties();
            assert.equal(second.failed, false);
            assert.equal(second.parties.length, 1);
            assert.equal(second.parties[0].party_name, '測試黨');
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});
