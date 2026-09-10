// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// 只測 CI 環境有把握維護的單一瀏覽器引擎（chromium）；這是輕量 smoke test，不是完整跨
// 瀏覽器相容性套件，多瀏覽器矩陣不是這個階段要解決的問題。
module.exports = defineConfig({
    testDir: './specs',
    fullyParallel: false,
    forbidOnly: !! process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? [['line']] : [['list']],
    use: {
        baseURL: 'http://127.0.0.1:4173',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        // build-serve-root.js 先組出隔離的測試用靜態根目錄（見該檔案註解），再用專案
        // README 既有的 http-server 開起來，跟本機/CI 真正的 frontend/data 完全不共用。
        command: 'node build-serve-root.js && npx http-server .serve-root -p 4173 -s -c-1',
        cwd: __dirname,
        port: 4173,
        reuseExistingServer: ! process.env.CI,
        timeout: 30_000,
    },
});
