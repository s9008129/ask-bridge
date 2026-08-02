# 2026-07-10 bump-and-release 0.2.6

## Goal + Acceptance Criteria
- [ ] 將版本從 `0.2.5` 升級至 `0.2.6`（patch）。
- [ ] 同步更新 6 個版本來源：`Cargo.toml`、`package.json`、`src/main.rs`、`install.ps1`、`install.sh`、`scripts/ask.sh`。
- [ ] 透過 `cargo check` 更新 `Cargo.lock` 並確認通過。
- [ ] 完成 git 提交（單一 commit）並推送 `main`。
- [ ] CI 在該 commit 上以 `ci.yml` + `push` 成功。
- [ ] 建立 `v0.2.6` tag 並推送，接著補齊 GitHub Release 繁中發行說明。

## Risk & Rollback
- Risk level: low
- 影響範圍: 專案版本宣告、安裝腳本下載版本、CLI 版本輸出。
- Rollback strategy: 只要 revert 版本 bump commit 並刪除 `v0.2.6` tag 即可回滾版本宣告。

## Dependencies & Environment
- Rust/Cargo（`cargo check`）
- Git 與 GitHub CLI（提交、CI 監控、tag 與 release）
- 當前分支需位於 `main`

## Checklist
- [ ] 檢查現況版本與變更範圍
- [ ] 修改 6 個版本檔
- [ ] `cargo fmt --all -- --check`
- [ ] `cargo check`
- [ ] 建立提交並記錄 release commit
- [ ] 等待 `.github/workflows/ci.yml` 對該 commit 驗證成功
- [ ] 建立並推送 `v0.2.6` tag
- [ ] 更新 GitHub Release 繁體中文發行說明

## Working Notes
- 已將目標版本定為 `0.2.6`（從 `0.2.5` patch 升級）。

---

# 2026-07-10 修正 Windows quiet MCP 與程式碼區塊回覆解析

## Goal + Acceptance Criteria
- [x] Node.js v24.18 環境下，非 `--verbose` 查詢不再因 Windows quiet wrapper 於 MCP `initialize` 階段退出。
- [x] Windows 與 Unix 的 quiet／verbose 模式共用直接 `npx.cmd`／`npx` stdio transport，不再使用 shell redirection。
- [x] quiet 僅以 flags/env 降低上游噪音，並由作用域 guard 抑制 `mcp-cli` stderr forwarding；初始化失敗仍保留 child stderr 診斷。
- [x] 回覆包含 Markdown 程式碼區塊時，終端仍能取得完整內容，不再誤判內層三反引號為 JSON fence 結尾。
- [x] JSON parser 驗證 outer closing fence，且 malformed fence／response shape 的錯誤不洩漏原始 payload。
- [x] 回歸測試涵蓋跨平台 direct config、quiet／verbose transport、內嵌 `rust` code fence 與 malformed payload。
- [x] 通過格式、目標測試、完整測試與 `cargo check` 驗證。

## Risk & Rollback
- Risk level: low
- Affected components: 跨平台非 verbose MCP 啟動與 stderr 呈現、所有 provider 的 evaluate_script JSON 結果解析。
- Rollback strategy: revert `Cargo.toml`／`Cargo.lock` 的 `gag` dependency，以及 `src/main.rs` 的 direct MCP config、stderr guard 與 JSON parser 變更；不涉及資料、設定格式或 migration。
- Monitoring signals: quiet query 不得出現 MCP initialize EOF 或重複 banner；含 code fence 的回答必須完整輸出；解析錯誤不得包含原始回答內容。

## Dependencies & Environment
- 使用者環境：Windows、Node.js v24.18.0、npx 11.16.0、Google Chrome remote debugging port 9223。
- `mcp-cli` 以 config command 直接建立 stdio child；stderr 由 library pipe 與保留診斷，不能先由 shell 丟棄。
- 新增 `gag 1.0.0`，僅在 MCP call 作用域內抑制 quiet 模式的 process stderr forwarding；guard 建立失敗會安全中止並回報可行動錯誤。
- Cargo target 輸出使用 `%TEMP%\ask-bridge-target`，避免 workspace 磁碟空間限制。

## Working Notes
- verbose 成功而 quiet 在 `initialize` EOF，差異集中於 Windows quiet 的 `cmd.exe /c ... 2>nul`；Node 24.18 已通過 runtime engines 檢查。
- `No stderr output available` 是 `2>nul` 造成的診斷盲點；schema suggestion 是 `mcp-cli` 的通用 fallback。
- `parse_script_result` 原先取 ` ```json ` 後第一個 ` ``` `，會在回答的 ` ```rust ` 處截斷 JSON 字串，與 column 206 EOF 完全吻合。
- 改由 `serde_json::StreamDeserializer` 解析第一個完整 JSON value，再驗證獨立 closing fence；內層 code fence 不再碰撞，尾端污染仍安全失敗。
- 保留既有 generated-image fallback；「文字擷取失敗且沒有圖片時應否回傳非零」未在本次擴張，列為後續錯誤語意改善。

## Checklist
- [x] Review `tasks/lessons.md`
- [x] Locate quiet/verbose MCP startup and response parsing paths
- [x] Design minimal direct-transport and parser fix
- [x] Implement smallest safe slice
- [x] Add regression tests
- [x] Run format, targeted tests, full tests, and `cargo check`
- [x] Review correctness, security/privacy, cross-platform behavior, and test coverage
- [x] Summarize changes + verification story

## Results
- `src/main.rs`：quiet／verbose 皆使用 direct MCP executable 與結構化 args；quiet call 以作用域 guard 隱藏上游 banner，同時保留 `mcp-cli` 收集的 child stderr。
- `src/main.rs`：evaluate_script 結果改以 JSON value 邊界解析並驗證 closing fence；錯誤不再輸出完整 MCP payload。
- `Cargo.toml`／`Cargo.lock`：新增跨平台 stderr guard dependency `gag 1.0.0`。
- 驗證通過：`cargo fmt --all -- --check`、4 個目標回歸測試、`cargo test`（58 passed）、`cargo check`。
- 未操作現有登入中的 Chrome 執行外部 ChatGPT 真機 query；受影響環境仍應確認 quiet／verbose 含程式碼區塊查詢各一次。

---

# 2026-07-10 修正 Windows MCP Node 版本錯誤診斷

## Goal + Acceptance Criteria
- [x] Node.js `v20.17.0` 不再一路進入 MCP `initialize` 後只顯示誤導性的 schema 錯誤。
- [x] Windows 安裝器在下載 binary 前驗證 `chrome-devtools-mcp@latest` 的 Node engines 契約。
- [x] 既有安裝、直接下載與 npm 安裝都由 Rust runtime preflight 兜底。
- [x] `config` 與 `close` 等不需 MCP 的命令不受 Node 版本檢查影響。
- [x] 回歸測試涵蓋 `20.19`、`22.12` 邊界、較舊版本與無效版本輸出。
- [ ] 通過格式、目標測試、完整測試與 `cargo check` 驗證。

## Risk & Rollback
- Risk level: low
- Affected components: Windows 安裝前置檢查、所有需要 MCP 的 runtime 命令。
- Rollback strategy: revert `src/main.rs` 與 `install.ps1` 的 Node preflight；不涉及資料、設定格式或 migration。
- Monitoring signals: 不相容 Node 應在 Chrome 啟動前顯示實際版本與支援範圍，不應再進入 MCP `initialize`。

## Dependencies & Environment
- 上游 `chrome-devtools-mcp@latest` engines：`^20.19.0 || ^22.12.0 || >=23`。
- 使用者截圖：Node.js `v20.17.0`、npm/npx `11.12.1`、ask-bridge `0.2.2`。
- Cargo target 輸出沿用 `%TEMP%\ask-bridge-target`，避免 `G:` 空間不足。

## Working Notes
- Windows quiet MCP 設定使用 `cmd.exe /c ... 2>nul`，因此 mcp-cli 只能回報 `No stderr output available`。
- `Check tool arguments match the expected schema` 是 mcp-cli 的通用 fallback，不是本案 schema 錯誤的證據。
- Runtime preflight 位於 `config`/`close` early return 之後、`write_mcp_config` 與 Chrome 啟動之前。

## Checklist
- [x] Review `tasks/lessons.md`
- [x] Confirm upstream Node engines and reproduce the version mismatch
- [x] Locate MCP startup and installer validation paths
- [x] Implement runtime and Windows installer fail-fast checks
- [x] Add Node version boundary regression tests
- [ ] Run targeted and full verification
- [ ] Summarize changes + verification story

---

# 2026-07-10 修正 Windows ChatGPT 登入延續回歸

## Goal + Acceptance Criteria
- [x] Windows 上 Chrome launcher PID 與 9223 listener PID 不同時，仍能辨識為 ask-bridge 所啟動的 Chrome。
- [x] `login` 結束後直接執行 query，不再誤報 `Port 9223 is already used by a non-ask Chrome process`。
- [x] ChatGPT 頁面登入 UI 尚在 hydration 時，不會因單次暫態訊號立即誤報未登入。
- [x] 明確位於 auth path 或穩定呈現未登入控制項時，仍安全地阻止 query 並提示登入。
- [x] `close` 與啟動重用採相同 ownership 規則，且 Windows 優先正常關閉、逾時才強制終止。
- [x] 回歸測試涵蓋實際 listener PID 記錄、PID fallback、WMIC 空白輸出與登入訊號穩定化。
- [x] 通過格式、Rust tests/check 與 diff whitespace 驗證（未執行 clippy / npm 測試）。

## Results
- `src/main.rs`：
  - 移除已淘汰的 `write_chrome_pid`/舊版 listener 回溯測試。
  - 重構 `start_chrome_if_needed` 與 `close_ask_chrome_on_debug_port` 以以 `CDP browser_id + debug listener` 為主、且由 parent-chain 尋找 `ask-bridge` 擁有者。
  - 將啟動與關閉重用判斷的 `Chrome` ownership 與 `build_chrome_process_record` 對齊。
  - ChatGPT 登入訊號加入 `stable` 欄位與穩定化等待，降低一次性 DOM 暫態誤判。
- 驗證：
  - `cargo fmt --all -- --check`
  - `cargo check`
  - `cargo test`

## Risk & Rollback
- Risk level: medium
- Affected components: Windows Chrome process ownership、9223 listener 重用／關閉、ChatGPT 登入前置判斷。
- Rollback strategy: revert `src/main.rs` 的 listener PID 與登入穩定化變更；不涉及資料格式或 migration。
- Rollout plan: 先以純函式測試與本機 Windows listener 驗證，再由受影響使用者重跑 login → query 原始流程。
- Monitoring signals: verbose diagnostics 中 recorded PID 應等於 listener PID，owner PIDs 不得為空；query 不得再出現 non-ask 或暫態未登入誤判。

## Dependencies & Environment
- Rust/Cargo、Node.js/npm 與本機 Google Chrome。
- `chrome-devtools-mcp@latest` 的 `evaluate_script` 支援 async function，可在單一 MCP 呼叫內等待登入 DOM 穩定。
- 本機 9223 已有既存 ask-bridge Chrome，手動驗證不得破壞其 profile 或登入資料。

## Working Notes
- 使用者證據：launcher/recorded PID `15864`、listener PID `20728`、owner PIDs `[]`；現有 `chrome.pid` 只記 launcher 且未參與 ownership 判定。
- `start_chrome_if_needed` 會因 owner 空集合誤判既有 Chrome；`close_ask_chrome_on_debug_port` 又使用另一套更窄的直接 command-line 判斷。
- Windows WMIC command-line parser 只讀 header 後第一行，遇到空白行便失敗；CIM fallback 也可能受環境限制。
- v0.2.1 的 ChatGPT ready check 只等 composer；訪客 shell 與登入 hydration 都可能先出現 composer，隨後的單次登入訊號便可能暫態為 LoggedOut。
- 登入完成當下已得到 Unknown，證明現行 account-menu selector 不是可靠的唯一已登入依據。

## Checklist
- [x] Review `tasks/lessons.md` if present（檔案不存在）
- [x] Locate existing implementation / patterns and preserve baseline evidence
- [x] Design minimal approach + key decisions
- [x] Implement listener PID ownership fallback and consistent close resolution
- [x] Make ChatGPT login decision tolerate hydration without masking stable logged-out state
- [x] Add/adjust regression tests
- [x] Run targeted and full verification
- [ ] Review correctness/security/performance of final diff
- [ ] Summarize changes + verification story
- [ ] Record lessons if any correction/postmortem occurs

---

# 2026-07-09 修正 WSL Chrome 路徑偵測

## Goal + Acceptance Criteria
- [x] 修正 `ask-bridge --verbose login` 在 WSL/Linux 只尋找 macOS Chrome 路徑的問題。
- [x] 在 Linux/WSL 中可偵測 `PATH` 內的 `google-chrome` / `google-chrome-stable`，並支援 `/usr/bin/google-chrome` 等常見路徑。
- [x] macOS 與 Windows 既有 Chrome 偵測行為不被破壞。
- [x] 加入可重現此路徑選擇行為的單元測試。
- [x] 通過 `cargo fmt --all -- --check` 與 Rust 編譯/測試驗證。

## Risk & Rollback
- Risk level: low
- Affected components: Chrome 啟動前的可執行檔路徑解析。
- Rollback strategy: revert `src/main.rs` 中 Chrome path resolver 相關變更。

## Dependencies & Environment
- Rust/Cargo local toolchain。
- Linux/WSL 目標環境需已安裝 Google Chrome，且 `google-chrome` 或 `google-chrome-stable` 可由 `PATH` 或常見絕對路徑找到。

## Working Notes
- 現有 `find_chrome_path` 對 `#[cfg(not(target_os = "windows"))]` 一律檢查 `/Applications/Google Chrome.app/...`，導致 Linux/WSL 誤報 macOS 路徑。
- `install.sh` 已知道 Linux 應檢查 `google-chrome` 或 `google-chrome-stable`，runtime 偵測邏輯需要與此一致。

## Checklist
- [x] Review `tasks/lessons.md` if present
- [x] Locate existing implementation / patterns
- [x] Design minimal approach + key decisions
- [x] Implement smallest safe slice
- [x] Add/adjust tests
- [x] Run verification (format/tests/build)
- [x] Summarize changes + verification story
- [x] Record lessons if any correction/postmortem occurs (none needed)

## Results
- `src/main.rs` now keeps macOS detection on the macOS-only branch and adds Linux detection for `google-chrome` / `google-chrome-stable` via `PATH`, then common absolute paths including `/usr/bin/google-chrome`.
- `Makefile install-browser` now handles Linux separately instead of applying macOS-only Chrome detection to every Unix-like OS.
- Added unit coverage for Linux Chrome path lookup from `PATH`, fallback candidates, and missing Chrome.
- Verification:
  - `cargo fmt --all -- --check` passed.
  - `cargo test` initially failed on `G:` because only about 768 KB was free (`os error 112` / no space on device).
  - Windows-hosted verification passed with `CARGO_TARGET_DIR=%TEMP%\ask-bridge-target cargo test` (`21 passed`).
  - WSL/Linux verification passed with `CARGO_TARGET_DIR=/mnt/c/Users/wakau/AppData/Local/Temp/ask-bridge-target-wsl cargo test` (`21 passed`).
- Manual WSL Chrome launch was not verified in this environment because `Ubuntu-24.04` reports `google-chrome: command not found`; the user's reported `/usr/bin/google-chrome` path is covered by the new Linux fallback list.

---

# 2026-07-09 bump-and-release 0.1.4

## Goal + Acceptance Criteria
- [ ] Release patch version `0.1.4` for the WSL/Linux Chrome path fix.
- [ ] Keep the required 6 version locations synchronized: `Cargo.toml`, `package.json`, `src/main.rs`, `install.ps1`, `install.sh`, `scripts/ask.sh`.
- [ ] Update `Cargo.lock` through Cargo verification.
- [ ] Update `CHANGELOG.md` with the release entry.
- [ ] Commit version bump, create annotated tag `v0.1.4`, push branch and tag.

## Risk & Rollback
- Risk level: low
- Affected components: package metadata, installer download version, CLI version display, changelog.
- Rollback strategy: revert the version bump commit and delete `v0.1.4` locally/remotely if the release must be withdrawn.

## Dependencies & Environment
- Cargo and npm available locally.
- `G:` has insufficient free space for Cargo target output; use `%TEMP%` / `/mnt/c/...` target directories for heavy Cargo commands.
- Git remote is `origin https://github.com/doggy8088/ask-bridge.git`.

## Working Notes
- Patch bump is appropriate because the preceding change is a bug fix without breaking API/CLI behavior.
- Existing WSL Chrome fix was committed separately as `94c1912` before release version changes.

## Checklist
- [x] Analyze bump type
- [x] Update version files
- [x] Run verification
- [x] Commit release bump
- [x] Create and push tag
- [x] Summarize release outcome

## Results
- Synchronized version `0.1.4` in `Cargo.toml`, `package.json`, `src/main.rs`, `install.ps1`, `install.sh`, and `scripts/ask.sh`.
- Updated `Cargo.lock` through `cargo check`.
- Added `CHANGELOG.md` entry for `0.1.4`.
- Verification passed:
  - `CARGO_TARGET_DIR=%TEMP%\ask-bridge-target cargo check`
  - `cargo fmt --all -- --check`
  - `CARGO_TARGET_DIR=%TEMP%\ask-bridge-target cargo test` (`21 passed`)
  - `CARGO_TARGET_DIR=/mnt/c/Users/wakau/AppData/Local/Temp/ask-bridge-target-wsl cargo test` (`21 passed`)
  - `npm test` (`4 passed`)
- Git results:
  - Bug fix commit: `94c1912`
  - Release commit: `58cb9ca`
  - Pushed `main` to `origin/main`
  - Created and pushed annotated tag `v0.1.4`

---

# 2026-07-10 bump-and-release 0.2.3

## Goal + Acceptance Criteria
- [x] 將版本提升為 `0.2.3`，並同步更新 6 個版本錨點（`Cargo.toml`, `package.json`, `src/main.rs`, `install.ps1`, `install.sh`, `scripts/ask.sh`）。
- [x] 通過格式、建置、測試與 npm 測試：`cargo fmt --all -- --check`、`cargo check`、`cargo test`、`npm test`。
- [x] `Cargo.lock` 透過 `cargo check` 同步更新，並補齊 `CHANGELOG.md` 的 0.2.3 條目。
- [x] 產生 `chore(release)` 提交並建立 `v0.2.3` tag；推送 tag 讓 CI `Release` 流程執行。

## Risk & Rollback
- Risk level: low
- Affected components: 版本/安裝版本一致性、發佈版本顯示、發佈資產下載 URL。
- Rollback strategy: revert release commit、刪除 `v0.2.3` tag，必要時重建 release commit。

## Dependencies & Environment
- `cargo`, `npm`, `git`, GitHub Actions。
- 建議將 `CARGO_TARGET_DIR` 指向 `%TEMP%` 以避免本機目錄空間限制。

## Checklist
- [x] Analyze bump type and target version
- [x] Update all required version files
- [x] Add changelog entry
- [x] Run fmt/check/tests
- [x] Commit release bump
- [x] Create annotated tag + push to trigger CI release

## Results
- 已同步更新版本到 `0.2.3`（6 個版本檔 + `Cargo.lock`）。
- 新增 `CHANGELOG.md` 之 `0.2.3` 條目。
- 驗證結果：
  - `cargo fmt --all -- --check`
  - `cargo check`
  - `cargo test`（54 passed）
  - `npm test`（4 passed）
- 已完成：`chore(release): bump version to 0.2.3` commit、`v0.2.3` tag 推送；CI `Release` workflow 已完成並發佈成功，並補上繁中 release note。

# 2026-07-10 bump-and-release 0.2.5

## Goal + Acceptance Criteria
- [ ] 將版本提升為  .2.5，並同步更新 6 個版本錨點（Cargo.toml, package.json, src/main.rs, install.ps1, install.sh, scripts/ask.sh）。
- [ ] 通過格式、建置、測試：cargo fmt --all -- --check、cargo check、cargo test、
pm test。
- [ ] 通過 cargo check 同步 Cargo.lock，並補齊 CHANGELOG.md 的  .2.5 條目。
- [ ] 產生 chore(release) 提交並建立 0.2.5 tag。

## Risk & Rollback
- Risk level: low
- Affected components: 版本號一致性、安裝腳本下載來源、CLI 版本輸出、文件版本紀錄。
- Rollback strategy: revert release commit、刪除 0.2.5 tag，必要時重建 release commit。

## Checklist
- [ ] Update all required version anchors
- [ ] Add changelog entry
- [ ] Run fmt/check/tests
- [ ] Commit release bump
- [ ] Create annotated tag (本地)

---

# 2026-07-10 強化 bump-and-release CI 發布閘門

## Goal + Acceptance Criteria
- [x] 確認 CI、Release 與 Publish npm 的實際觸發鏈。
- [x] 發布 SOP 必須先推送 `main`，等待同一 commit 的 `CI` push run 完成且成功，才允許建立與推送 Tag。
- [x] CI 查詢必須鎖定 workflow、event 與 commit SHA，不能誤用 PR、手動或舊 commit 的結果。
- [x] CI 失敗、逾時、查詢錯誤、main 前進或 Tag 衝突時必須安全停止。
- [ ] 通過 skill 結構驗證與 `cargo fmt --all -- --check`。

## Risk & Rollback
- Risk level: low
- Affected components: AI Agent 的版本發布作業順序；不修改產品程式碼或 GitHub Actions。
- Rollback strategy: revert `.agents/skills/bump-and-release/SKILL.md` 的 CI 閘門段落。
- Monitoring signals: Agent 不得在對應 release commit 的 CI 顯示 `completed/success` 前推送 `vX.Y.Z` Tag。

## Dependencies & Environment
- `gh` 必須已登入並能讀取 `doggy8088/ask-bridge` 的 Actions runs。
- `.github/workflows/ci.yml` 必須維持 `main` push 觸發；正式發布仍由 `v*.*.*` Tag 觸發 `.github/workflows/release.yml`。

## Working Notes
- Release workflow 執行四平台正式建置與封裝，並未重跑 CI 的 `cargo test`／`npm test`，不需要合併 workflow。
- GitHub Actions run 建立具有短暫 eventual consistency，因此 SOP 以限時輪詢等待 run 出現，再用 `gh run watch --exit-status` 等待結果。

## Checklist
- [x] Review `tasks/lessons.md`
- [x] Locate current skill and workflow contracts
- [x] Design fail-closed CI gate
- [x] Update release SOP and exact commands
- [ ] Validate skill structure and Rust formatting
- [ ] Summarize changes + verification story

---

# 2026-07-29 驗證附件上傳契約與 MCP 隱私修復（Checkpoint A）

## 目標與驗收條件

- [x] ChatGPT／Claude 文件先使用 native `upload_file`，只在 native chooser 不可用時使用 DataTransfer fallback。
- [x] 附件送出前驗證預期檔名 multiset 與數量、無 uploading/error 狀態，並在 500ms 間隔下連續兩次穩定；60 秒逾時或錯誤時不得輸入或送出 prompt。
- [x] `capabilities --json` 同時宣告 `isolated_new_tab_v1` 與 `verified_file_upload_v1`。
- [x] schema-v2 session receipt 僅保存非敏感稽核欄位；真正 submit 前原子保存 `prompt_submission=intent_recorded`，成功 submit 後保存 `submitted`。
- [x] config/session 目錄為 0700、檔案為 0600、拒絕 symlink，且 receipt 不含 prompt、內容、base64、完整路徑、檔名或帳號。
- [x] 預設 MCP config 完全移除 `--logFile`，保留既有安全摘要診斷。
- [x] 既有 raw MCP log 經 owner/type/symlink/open-handle 重驗後，chmod 0600 並移至唯一命名的 macOS Trash 路徑；若仍被開啟則不終止任何 process。
- [x] failing-first tests 證明 native/fallback、穩定等待、fail-closed submit、receipt 狀態、capability、permissions 與 privacy canary。
- [x] 通過 fmt、clippy、Rust/npm tests、check 與 release build；不執行真實 provider mutation。

## Risk & Rollback

- Risk level: high
- Affected components: ChatGPT／Claude 附件 browser automation、所有 prompt submit 的 crash/retry 邊界、session receipt、MCP 啟動設定與本機 raw log。
- Rollback strategy: 精準還原本次 ask-bridge source/test/task hunks，從 commit `100c6a4` 重建 release binary；app 端後續 capability gate 應 fail-closed，不得退回未驗證附件上傳。Trash 中的舊 raw log可移回原路徑復原。
- Rollout plan: 先以純函式／mocked MCP tests 驗證，再跑完整離線 suite 與 release build；本 checkpoint 禁止真實 ChatGPT／Claude mutation。
- Monitoring signals: 附件未穩定時 submit 呼叫數必須為 0；receipt 權限/shape 正確；新 MCP config 不含 `--logFile`；privacy canary 不出現在 config/receipt/diagnostics。

## Dependencies & Environment

- Rust/Cargo、Node.js/npm；不新增第三方 dependency。
- Chrome provider UI 由 mocked MCP DOM probe 驗證，最長 production wait 60 秒、穩定間隔 500ms。
- Provider denylist：本專案內 ask-bridge MUST NOT use Claude；禁止 Claude CLI/session/login/query/upload/mutation/live probe，只允許 pure function/mock/fixture 離線測試既有相容 API。
- 現有安裝命令與 release binary canonical path 必須在安裝前比對。
- `yt_down_txt` 既有 dirty worktree 與事故 artifacts 只讀，不修改、不 stage、不 stash、不 reset。

## Working Notes

- ask-bridge baseline HEAD 為 `100c6a4`，工作樹在本 checkpoint 開始時乾淨。
- `yt_down_txt` dirty files：`semantic_extraction.py`、`semantic_extraction_service.py`、`tests/test_semantic_extraction.py`、`workflow_orchestrator.py`；另有未追蹤事故 artifacts，全部保持不變。
- 現有 lessons 要求 Rust 安全邊界變更後依序執行 fmt、clippy、test、release build，且不能以 provider 原始輸出做診斷。
- 使用者新增最高優先級 provider denylist；本 checkpoint 的所有 provider automation 驗證固定為 mocked/offline，不做任何 Claude live 行為。

## Checklist

- [x] 完整閱讀兩 repo 適用指引、lessons、handoff 與 ask-bridge skill。
- [x] 定位附件上傳、prompt submit、capability、receipt 與 MCP config authoritative paths。
- [x] 新增 failing-first tests並保存 pre-fix failure。
- [x] 實作最小附件完成契約與 schema-v2 receipt。
- [x] 移除預設 MCP raw log並安全處理既有 raw log。
- [x] 執行 targeted 與完整驗證、release build、installed path/capability 檢查。
- [x] 補 Results、精準 diff與未證實項目，等待 root checkpoint review。
- [x] 修正 root review 發現的 nested timeout，讓 reset/connect/select/probe 共用單一 absolute deadline。
- [x] 補 deterministic budget、ChatGPT document policy 與四種 fail-closed gate regression。
- [x] 重跑 review-fix 後完整 gate、release install 與精準增量 diff。

## Results

- Failing-first：`cargo test attachment_probe_requires_two_stable_complete_observations -- --exact` 在 production 修復前 exit 101，49 個 compile errors明確指出缺少 verified capability、AttachmentProbe/tracker、schema-v2 receipt與無-log config signature。
- `src/main.rs`：新增 exact filename-multiset structured DOM probe、500ms × 2 stable gate、60s deadline；文件 native chooser → per-file DataTransfer fallback；附件未 verified前不執行 prompt submit closure。
- `src/main.rs`：receipt 升級 schema v2，pending/verified/failed與 not_started/intent_recorded/submitted狀態以 0600 atomic JSON持久化；0700目錄與 symlink拒絕；receipt只含計數、bytes、capability與狀態。
- `src/main.rs`：MCP config不再產生 `--logFile`，on-disk config也已精準移除舊參數並修為0600；state/sessions目錄修為0700。
- 舊 raw log在 uid=501、regular、非 symlink、`lsof`無開啟者的第二次 preflight後，先 chmod 0600再移至 `/Users/hsiaojohnny/.Trash/ask-bridge-chrome-devtools-mcp-20260729-160438.log`；286,272,639 bytes，可復原，原路徑不存在。
- 驗證全綠：`cargo fmt --all -- --check`；`cargo clippy --all-targets -- -D warnings`；`cargo test`（76 passed）；`cargo check`；`npm test`（4 passed）；`cargo build --release`；`git diff --check`。
- `make install`後 `/Users/hsiaojohnny/.local/bin/ask-bridge`與`ask`均指向本 repo release binary；installed `capabilities --json`為 schema 2，宣告 `isolated_new_tab_v1,verified_file_upload_v1`。
- 精準 diff：4 個 tracked files；`src/main.rs` production `+818/-264`、tests `+419/-23`，另有 README `+6/-2`、lessons `+21`、本 task audit notes `+72`；未新增 dependency。
- 未做真實 provider mutation/live probe；依專案 denylist未執行任何 Claude CLI/session/login/query/upload/mutation/live probe。DOM selector仍只由 pure/mock/offline tests驗證，需由使用者在 root最終放行後手動做受控 E2E。

### Root review fix

- Review failing-first：新增 regression 後執行 `cargo test mcp_connect_and_tool_share_one_deterministic_deadline`，production修正前 exit 101，4 個 compile errors指出缺少 absolute deadline與 document policy symbols。
- `McpOperationDeadline`現在以單一 absolute deadline把 session reset、connect、owned-page select與 probe tool限制為各 phase cap和剩餘 budget的較小值；deadline耗盡即 reset/fail-closed，不 replay remote call。
- 新增 pure/offline tests：synthetic `Instant`證明 connect消耗後 tool只取得剩餘 budget；ChatGPT document policy固定為 native-first＋DataTransfer fallback；uploading/missing/error/timeout均保持 submit closure呼叫 0 次。
- Review-fix增量為 production `+85/-8`、tests `+124/-0`、lessons `+11`、todo `+11`，合計 `+231/-8`；完整 diff為 `+1336/-289`。
- Review-fix 後完整驗證全綠：Rust 79 passed、Node 4 passed，fmt、clippy `-D warnings`、check、release build與diff-check皆成功；`make install`後 installed capability仍為 schema 2與兩項安全能力。

---

# 2026-08-02 以圖片產物契約判定 provider 回應完成

## 目標與驗收條件

- [x] 圖片工作在本次唯一新增 assistant、無生成控制項、最新回應至少一張已載入大尺寸圖片且 DOM 簽章連續穩定前，絕不判定完成。
- [x] assistant 數量異常、owned page／provider URL／頁內 ownership token 改變時 fail closed 為 `unknown`，不得下載其他回應圖片。
- [x] `--image-output` 的 timeout、零圖片與任何下載錯誤皆回傳非零；prompt 已送出後 receipt 保持可判定為 ambiguous。
- [x] schema-v2 receipt additive 保存預期輸出種類、response completion enum、下載圖片數與固定 failure code；不保存 prompt、回覆、URL、檔名或 DOM。
- [x] `capabilities --json` 宣告 `verified_image_response_completion_v1`，並提供 machine-readable 契約欄位。
- [x] failing-first 與完整離線測試、fmt、clippy、check、release build 全部通過；不執行任何真實 provider mutation，且依 denylist 不使用 Claude live path。

## Risk & Rollback

- Risk level: medium-high
- Affected components: provider response polling、generated-image extraction、same-run receipt audit、App/bridge capability compatibility。
- Rollback strategy: revert `src/main.rs`、README 與 task/lesson 增量，並從既有已驗證 commit 重建 binary；App 端缺少新 capability 時必須 fail closed。
- Monitoring signals: 圖片未落地時 completion 不得變成 completed；任一圖片輸出失敗 CLI 必須 non-zero；receipt 不得出現 privacy canary。

## Dependencies & Environment

- Rust/Cargo 與既有 `chrome-devtools-mcp`；不新增 dependency。
- 所有 provider DOM 行為只以 pure state-machine／fixture 測試，不呼叫 ChatGPT/Gemini/Claude live query 或 upload。
- Provider denylist: MUST NOT use Claude CLI/session/login/query/upload/mutation/live probe。

## Working Notes

- 現行 completion 只以「assistant count 增加、Stop control 連續約 1.5 秒不可見」判定；圖片可能稍後才載入。
- 現行 image scan 將零圖片視為成功，main 也吞掉 download error，會形成遠端已生成但本機空輸出。
- exact owned page 已由 process-local binding 在每次 page-bound MCP call 前重選；本次再加入頁內隨機 token、provider URL 與 response identity 驗證。

## Checklist

- [x] Review `AGENTS.md`、`tasks/lessons.md` 與既有 checkpoint notes。
- [x] Locate response polling、download、receipt、capability authoritative paths。
- [x] 新增 failing-first state-machine／download contract／receipt privacy tests並保存失敗證據。
- [x] 實作最小 response completion state machine 與 browser probe。
- [x] 將 strict image download與 receipt terminal audit 接入 runtime。
- [x] 執行 targeted、full verification 與 release build。
- [x] correctness/security/privacy review並補 Results／lesson tripwire。

## Results

- Failing-first：`cargo test image_completion_waits_for_loaded_artifact_after_assistant_and_stop_disappear -- --exact` 在 production symbols 加入前 exit 101，53 個 compile errors明確指出缺少 output type、completion tracker、download contract與 receipt fields。
- `src/main.rs`：新增 pure `ResponseCompletionTracker`，文字與圖片使用不同 artifact gate；圖片需唯一 assistant delta、無可見生成控制項、至少一張 `256×256` 已載入候選圖與 500ms 間隔連續 3 次相同 DOM hash。
- `src/main.rs`：送出前建立隨機 page-local ownership token並確認當下沒有生成控制項；輪詢與下載前後驗證 exact user/assistant delta、provider origin、conversation URL、token 與 DOM signature，任何人工導航／額外訊息／response identity 改變都停止為 `unknown`。
- `src/main.rs`：`--image-output` 對 zero image、browser extraction／base64／filesystem error、timeout 一律 non-zero；下載函式回傳實際成功張數，不再由 main 吞掉 error。
- `src/main.rs`：receipt schema 維持 v2並 additive 加入 `expected_output_type`、`response_completion`、`downloaded_image_count`、`response_failure_code`；legacy v2缺欄位可讀，既有 `attachment_probe` 在後續狀態轉移中保持不丟失。
- `src/main.rs`／`README.md`：capability list與 human output加入 `verified_image_response_completion_v1`，文件說明 strict image artifact契約；`tasks/lessons.md`加入產物完成判斷 tripwire。
- 驗證全綠：`cargo fmt --all -- --check`；`cargo clippy --all-targets -- -D warnings`；`cargo test`（92 passed）；`cargo check`；`npm test`（4 passed）；`cargo build --release`；`git diff --check`。
- installed `/Users/hsiaojohnny/.local/bin/ask-bridge`與`ask`仍指向本 repo release binary；installed `capabilities --json`已回報四項能力與 strict image contract。
- 未執行任何真實 provider query/upload/mutation/live probe；依 denylist 未使用 Claude CLI/session/login/query/upload/mutation/live probe。DOM selector與時序仍只由 pure/offline regression證實，受控真機 E2E留給使用者明確操作。
