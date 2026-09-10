// 合成 fixture 資料（frontend/test/fixtures/data/）的契約測試：不驗證正式匯出資料本身
// （那是發布前檢查 scripts/test-publish-frontend.sh 的範圍，見 IMPROVEMENT_PLAN.md 第二
// 階段），只確保這份小型測試資料本身格式正確、content_hash 跟資料檔內容一致——Playwright
// smoke test（frontend/test/e2e/）直接讀這份 fixture 當測試伺服根目錄的 data/，格式不對會
// 讓瀏覽器測試的失敗訊息變成「fixture 壞了」而不是「程式邏輯有問題」，這裡先擋掉這種雜訊。
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const app = require(path.join(__dirname, '..', 'js', 'app.js'));

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'data');

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

// 比照 laravel_app/app/Console/Commands/Concerns/ComputesStaticDataContentHash.php 的算法：
// sha256(file bytes) 前 12 碼。
function contentHashOf(name) {
    const bytes = fs.readFileSync(path.join(FIXTURES_DIR, name));
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

const INDEXES = [
    { file: 'drilldown-index.json', dataFile: (id) => `election-${id}-drilldown.json`, extraFields: ['top_level'], schemaVersion: app.SCHEMA_VERSION_DRILLDOWN },
    { file: 'district-map-index.json', dataFile: (id) => `election-${id}-districts.json`, extraFields: [], schemaVersion: app.SCHEMA_VERSION_DISTRICT_MAP },
];

describe('fixture index files', () => {
    for (const { file, dataFile, extraFields, schemaVersion } of INDEXES) {
        describe(file, () => {
            const entries = readJson(file);

            test('is a non-empty array with required fields', () => {
                assert.ok(Array.isArray(entries));
                assert.ok(entries.length > 0);

                for (const entry of entries) {
                    for (const field of ['id', 'name', 'type', 'date', 'content_hash', ...extraFields]) {
                        assert.ok(field in entry, `${file} entry missing "${field}"`);
                    }
                }
            });

            test('content_hash matches the referenced data file', () => {
                for (const entry of entries) {
                    const referenced = dataFile(entry.id);
                    assert.equal(
                        entry.content_hash,
                        contentHashOf(referenced),
                        `${file}'s content_hash for id=${entry.id} does not match sha256(${referenced})`,
                    );
                }
            });

            test('referenced data file exists, parses, and matches the expected schema_version', () => {
                for (const entry of entries) {
                    const referenced = dataFile(entry.id);
                    assert.ok(fs.existsSync(path.join(FIXTURES_DIR, referenced)), `${referenced} missing`);

                    const data = readJson(referenced);
                    assert.equal(data.schema_version, schemaVersion);
                    assert.ok(data.election, `${referenced} missing "election"`);
                }
            });
        });
    }
});

describe('drilldown fixture region tree', () => {
    const data = readJson('election-1-drilldown.json');

    test('has at least one drill-down-able branch and one leaf', () => {
        const [mainland] = data.regions;
        assert.ok(mainland.children && mainland.children.length > 0, 'expected at least one level of children');

        let node = mainland;
        while (node.children) node = node.children[0];
        assert.equal(node.children, undefined, 'leaf node should not carry a children key at all');
    });

    test('includes an offshore-island-style region for inset testing (Kinmen)', () => {
        const names = data.regions.map((r) => r.name);
        assert.ok(names.includes('金門縣'), 'fixture should include 金門縣 for DRILLDOWN_INSET_GROUPS coverage');
    });

    test('every region node resolves its geometry_hash in its top-level ancestor\'s geometry_chunk file, plus results and actual_winner_candidacy_id consistent with results[0]', () => {
        // 幾何去重表按縣市分片（見 DedupsGeometry trait）：只有頂層節點自己帶
        // geometry_chunk，子孫節點沿用同一個頂層祖先的分片，這裡模擬前端
        // fetchGeometriesFor() 的邏輯，把整棵子樹底下的 geometry_hash 都拿去查同一個
        // chunk 檔案。
        const walk = (regions, geometries, label) => {
            for (const r of regions) {
                assert.ok(r.geometry_hash, `${r.name} missing geometry_hash`);
                assert.ok(geometries[r.geometry_hash], `${r.name}'s geometry_hash does not resolve in ${label}`);
                assert.ok(Array.isArray(r.results) && r.results.length > 0, `${r.name} missing results`);
                assert.equal(r.actual_winner_candidacy_id, r.results[0].candidacy_id, `${r.name} actual_winner mismatch`);

                if (r.children) walk(r.children, geometries, label);
            }
        };

        for (const top of data.regions) {
            assert.ok(top.geometry_chunk, `${top.name} (top-level) missing geometry_chunk`);

            // 磁碟上的分片檔名是原始縣市名稱本身，不是 percent-encode 過的字串——見
            // DedupsGeometry::geometryChunkFileName() 註解，encodeURIComponent() 只
            // 在前端組 fetch URL 時才用，檔名本身不能先編碼一次。
            const chunkFile = `geometries/${top.geometry_chunk}.json`;
            const { geometries } = readJson(chunkFile);

            walk([top], geometries, chunkFile);
        }
    });
});

describe('geometries fixture (幾何去重共用表，按縣市分片)', () => {
    const GEOMETRIES_DIR = path.join(FIXTURES_DIR, 'geometries');
    const chunkFiles = fs.readdirSync(GEOMETRIES_DIR).filter((f) => f.endsWith('.json'));

    test('at least one chunk file exists', () => {
        assert.ok(chunkFiles.length > 0, 'expected at least one file under fixtures/data/geometries/');
    });

    for (const file of chunkFiles) {
        test(`${file} is a non-empty hash-keyed map of GeoJSON geometries`, () => {
            const { schema_version: schemaVersion, chunk, geometries } = readJson(`geometries/${file}`);

            assert.equal(schemaVersion, app.SCHEMA_VERSION_GEOMETRIES ?? 1);
            assert.equal(file.replace(/\.json$/, ''), chunk, `${file}'s filename doesn't match its own "chunk" field`);
            assert.ok(geometries && typeof geometries === 'object');
            assert.ok(Object.keys(geometries).length > 0);

            for (const [hash, geometry] of Object.entries(geometries)) {
                assert.match(hash, /^[0-9a-f]{32}$/, `key "${hash}" doesn't look like an md5 hash`);
                assert.ok(['Polygon', 'MultiPolygon'].includes(geometry.type), `geometry for ${hash} has unexpected type`);
            }
        });
    }
});

describe('current-ly-parties fixture', () => {
    test('matches the shape loadCurrentLyParties() expects', () => {
        const data = readJson('current-ly-parties.json');
        assert.ok(Array.isArray(data.parties));

        for (const p of data.parties) {
            assert.equal(typeof p.party_name, 'string');
            assert.match(p.color, /^#[0-9a-f]{6}$/i);
        }
    });
});
