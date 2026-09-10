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

    test('every region node has geometry, results and actual_winner_candidacy_id consistent with results[0]', () => {
        const walk = (regions) => {
            for (const r of regions) {
                assert.ok(r.geometry, `${r.name} missing geometry`);
                assert.ok(Array.isArray(r.results) && r.results.length > 0, `${r.name} missing results`);
                assert.equal(r.actual_winner_candidacy_id, r.results[0].candidacy_id, `${r.name} actual_winner mismatch`);

                if (r.children) walk(r.children);
            }
        };

        walk(data.regions);
    });
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
