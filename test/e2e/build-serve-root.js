// Playwright smoke test 用的靜態伺服根目錄：正式的 frontend/data/ 是可重新產生的匯出資料
// （462MB，故意不進版控，見根目錄 .gitignore），CI 全新 checkout 不會有這些檔案，本機
// 開發環境也可能有大量真實資料——兩種情況都不適合直接拿 frontend/ 當測試伺服根目錄。
// 這裡另外組一份只含 index.html/css/js + fixtures/data 小型合成資料的暫存目錄，跟正式
// frontend/data/ 完全隔離，不會誤讀/誤改本機既有資料。
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND_ROOT = path.join(__dirname, '..', '..');
const FIXTURES_DATA = path.join(__dirname, '..', 'fixtures', 'data');
const SERVE_ROOT = path.join(__dirname, '.serve-root');

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });

    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(from, to);
        } else {
            fs.copyFileSync(from, to);
        }
    }
}

fs.rmSync(SERVE_ROOT, { recursive: true, force: true });
fs.mkdirSync(SERVE_ROOT, { recursive: true });

fs.copyFileSync(path.join(FRONTEND_ROOT, 'index.html'), path.join(SERVE_ROOT, 'index.html'));
copyDir(path.join(FRONTEND_ROOT, 'css'), path.join(SERVE_ROOT, 'css'));
copyDir(path.join(FRONTEND_ROOT, 'js'), path.join(SERVE_ROOT, 'js'));
copyDir(FIXTURES_DATA, path.join(SERVE_ROOT, 'data'));

console.log(`built ${SERVE_ROOT} from ${FRONTEND_ROOT} + fixtures`);
