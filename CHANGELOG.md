# 更新日誌 (CHANGELOG)

本專案的所有重要變更皆會記錄於本文件中。

## [Unreleased]

### 🚀 新增 (Added)
- 新增 `--background-tab[=<BOOL>]` CLI flag，將「Chrome 可不可見」（`--headless`）與「自動化分頁是否走前景／背景」拆成兩條契約；未指定時沿用歷史預設（`background_tab = headless`），舊呼叫端行為不變。
- macOS 背景冷啟動新增 `--no-startup-window`：Chrome 不建立初始瀏覽器視窗，避免建立視窗時自我 activate（`open -g -j` 無法抑制）；自動化分頁改由 CDP `background: true` 建立。
- 新增 `background_launch_isolation_v1` 能力宣告（`launch_activation=suppressed`、`launch_visibility=hidden`、`mechanism=macos-launchservices-open-gj`、`scope=cold-start-only`）；`background_isolated_tab_v1` payload 新增 `new_page_background_flag=--background-tab`，整合工具可據此明確要求背景分頁。
- 新增 Rust 單元測試：CDP `background` 由 `background_tab` 決定、`--background-tab` 與 `--headless` 解耦、隱藏啟動計畫使用 `open -g -j -n`、非 `.app` 執行檔被拒絕，以及 capability payload 契約。
- 新增 `verified_model_selection_v3`–`v6` capability 的 `control_bundle.marker_candidates`（`data-model-reasoning-effort-slider`、`data-reasoning-slider`）與 `control_bundle.role_evidence_scope`（`state_and_focus_owners`）：宣告推理強度 slider 的 marker 候選拼法與 role 證據判定範圍；既有 `marker` 欄位保留不變。
- 版本推進至 `0.2.10-preserve.2`（`Cargo.toml`／`Cargo.lock` 同步；`package.json`、`install.sh`、`install.ps1`、`scripts/ask.sh` 維持 `0.2.10`）。
- 登入流程新增 `background_login_launch_v1` 能力宣告（`launch_activation=suppressed`、`launch_visibility=visible`、`tab_creation=background`、`bring_to_front=false`、`reuse_reveal=unhide-without-activation`、`mechanism=macos-launchservices-open-g-no-startup-window`、`scope=login-only`）：登入視窗可見但絕不搶佔前景焦點，整合工具可據此把登入納入背景契約。
- 版本推進至 `0.2.10-preserve.3`（`Cargo.toml`／`Cargo.lock` 同步；其餘版本檔沿用 `0.2.10-preserve.2` 的既有慣例，維持 `0.2.10`）。

### 🔧 修復 (Fixed)
- 修正 macOS 冷啟動 managed Chrome 的搶前景問題：不再以 `Command::spawn` 直接啟動 Chrome 執行檔（此舉會觸發 macOS app activation，使 Chrome 成為 frontmost app），改以 LaunchServices `open -g -j -n -a` 搭配 `--no-startup-window` 隱藏啟動；`open` 失敗時直接回報錯誤，**不會**退回會搶前景的直 spawn。
- 修正「先啟動、後以 AppleScript 隱藏」的延遲補救鏈：AppleScript 隱藏迴圈降級為有界的 best-effort fallback（依賴 `System Events` Automation 權限），並改由 debug port 反查真正的 Chrome PID（`open` 不回報 child PID）。
- 修正分頁層級的 activate 風險：`select_page` 的 `bringToFront` 與 `new_page` 的 `background` 改由 `--background-tab` 驅動，而非隱式綁定 `--headless`。
- 修正 ChatGPT 登入偵測在「已登入」頁面誤判為 `Unknown` 的問題：`login_signals_js()` 的帳號選單探測原本取「第一個符合元素」，會被頁面上 0×0 的隱藏複製品（例如 `button[aria-label*="個人檔案"]`）鎖住，導致 `account=false`；`ask-bridge login --provider chatgpt` 因此每輪都判 `Unknown`，一路空等到 `--timeout`（CLI 預設 300 秒、GUI 900 秒）後失敗，`session-probe --json` 也回報 `authenticated=false, state=unknown`。現改為在既有 selector 清單中取「第一個可見」的符合元素（`firstVisible`），並保留原本的 selector 優先順序；同一個 probe 內的 composer 診斷訊號一併改用同一策略。
- 補齊對應測試：Rust 端新增 `chatgpt_login_signals_prefer_the_visible_account_control`；Node DOM contract fixture 新增 `ChatGPT login signals read the visible account control, not hidden duplicates`，以 headless Chrome 驗證「隱藏複製品在前、可見元件在後 → `account=true`」、「只有隱藏複製品 → `account=false`」與「可見登入鈕＋隱藏複製品 → `auth_control=true`」。
- 修正 ChatGPT 推理強度 slider marker 漂移導致的 `CHATGPT_MODEL_SELECTION_FAILED`（GUI 對話框「ChatGPT 模型／推理強度選擇未驗證，Prompt 未送出」）：ChatGPT 現行 DOM 已移除 `data-model-reasoning-effort-slider`，改將 slider 掛在 `role=menuitem` 鍵盤控制容器上的 `data-reasoning-slider`；resolver 現在同時接受兩種拼法（同一時刻仍要求唯一 bundle，新舊巢狀共存時維持 ambiguous fail-closed）。
- 修正 role 證據誤判：`role_evidence` 的 conflict 只判定擁有讀值狀態／鍵盤焦點的 owner，marker 容器本身的 `role=menuitem` 不再讓合法 slider 被誤判為 `conflict`。
- 補齊對應測試：Node DOM contract 新增「現行 `data-reasoning-slider` menuitem bundle 可解析」、「state owner 為非 slider 互動元件仍 fail-closed」、「legacy marker 相容」、「巢狀新舊 marker 共存時 ambiguous fail-closed」與「roleless focusable owner」；Rust capability 斷言擴及 v3–v6。
- 修正「第 2 個（含）以後的附件永遠上傳失敗」（GUI 對話框「ask-bridge 尚未確認附件完成，Prompt 未送出」，session receipt 收斂為 `ATTACHMENT_VERIFICATION_FAILED`）：舊路徑每個檔案都先點「新增檔案和更多內容」開選單再 `DOM.setFileInputFiles`；ChatGPT 收下第 1 個檔案後會把該按鈕留在 `aria-expanded="true"`、popover 已卸載的 phantom-open 狀態，下一個檔案的單次點擊因此變成「關閉」，永遠等不到選單（`Attachment menu did not open`，約 26 秒後 exit 1）。文件與圖片現在都直接對 composer 常駐的 hidden `input[type=file]`（`附加檔案`／`附加相片或影片`）設定檔案、完全不碰選單；選單只在 input 尚未掛載時作為 fallback，並改為冪等的有界重試（`ensureMenuOpen`，最多 4 次點擊）以跨越 phantom-open；ownership token 與「chip 出現才回報成功」的驗證契約不變。
- 補齊對應測試：新增 `tests/chatgpt_upload_contract.test.cjs`（5 個測試：直接路徑不得點選單、document／image selector 契約、fallback 會重新查詢 input、phantom-open 下仍有界重試、input 缺失時回報 `File input unavailable`）。
- 修正「登入 ChatGPT」會把 Chrome 拉到前景的問題（第一性原理：macOS 的「視窗可見」與「App 成為前景」是正交的，登入流程錯把它們耦合）。登入不再走 `Commands::Login => headful ⇒ 直接 spawn + background_tab=false` 的舊路徑，改為：LaunchServices `open -g -n -a`＋`--no-startup-window`（可見、非激活、失敗 fail-closed）、分頁一律以 CDP `background: true` 建立／`bringToFront=false`（可由顯式 `--background-tab=false` 覆寫），reuse 到先前被 headless 隱藏的實例時以 `System Events` 非激活式 unhide。自動化路徑的啟動契約與 `--headless` 直接 spawn 的除錯指令行為維持不變。
- 修正非激活式 unhide 的靜默失效：原本 AppleScript 先把 process 存進變數再 `set visible of theVariable to true`，在現行 macOS 會無效果但 osascript 仍 exit 0（實機驗證：App 維持 `isHidden=true`，CLI 卻回報 reveal 成功）。改為 inline process 參照的 guard（`if not (visible of (first application process whose unix id is PID)) then set visible of (first application process whose unix id is PID) to true`），並在設定後以 ≤1 秒 bounded 輪詢確認 `visible=true`；仍失敗時大聲警告（改由 Dock／⌘-Tab 手動顯示），不再把靜默 no-op 當成功。
- 補齊對應測試：`login_launch_plan_is_visible_but_never_activating`、`chrome_start_mode_and_background_tab_defaults_cover_login`、`reveal_script_unhides_without_activating`（含「不得使用 AppleScript 變數形式」回歸斷言）與 capability payload 斷言。

### ⚠️ 驗證狀態 (2026-09-29)
- 離線測試通過：`cargo fmt --all -- --check`、`cargo test`（131 passed）、`cargo build --release`、capabilities payload 檢查。
- **實機冷啟動焦點驗證通過（attempt-2）**：兩次乾淨冷啟動中 managed Chrome 從未成為 frontmost（run-2 frontmost 基準完全不變；run-3 Chrome ASN 從未出現在 frontmost 取樣）、`isHidden=true`／`isActive=false`、`onscreen_chrome_windows=0`；reuse 路徑 60 個取樣亦未出現 Chrome。attempt-1 的失敗（`open -g -j` 後 Chrome 於 +0.46 秒成為 frontmost）已由 `--no-startup-window` 修正。
- AppleScript 備援語法錯誤已修正（`whose unix id is <PID>`；先前的 `whose unix id <PID>` 會讓 osascript 回報 -2740），語法檢查 exit 0。
- 證據：`yt_down_txt/.agent/tasks/T20260929-1601-01-chrome-background-focus/e2e/attempt-2/`（run-2／run-3 冷啟動 + reuse；attempt-1 失敗證據保留於同層 attempt-1/）。

### ⚠️ 登入偵測修復驗證 (2026-09-29)
- 修復後離線測試：`cargo fmt --all -- --check`、`cargo test`（132 passed）、`npm test`（20 passed）、`cargo build --release` 全數通過；`cargo clippy --all-targets` 僅有 8 個既有 warning（與修復前相同，未新增）。
- **實機登入按鈕流程 E2E 通過**：managed Chrome（CDP 9223）已登入 ChatGPT，`ask-bridge login --provider chatgpt` 於 2 秒內印出 `Success: Logged in successfully!`（修復前會空等至 300 秒逾時），`--verbose` 訊號為 `account=true, auth_control=false, auth_path=false, composer=true`；後續 `ask-bridge session-probe --provider chatgpt --json` 回 `{"authenticated":true,"provider":"chatgpt","state":"logged_in"}`（exit 0）。
- 應用層按鈕路徑（`media_toolbox.chatgpt.ask_bridge_adapter.AskBridgeAdapter.start_login`）E2E 通過：`status=success`、`message=ChatGPT 登入完成，唯讀 session probe 已確認`、`retry_safety=safe`，耗時 3.45 秒。
- 焦點契約未回歸：驗證期間 managed Chrome 的 `System Events visible=false`，從未成為 frontmost app。
- 反向證據（離線 fixture）：只有隱藏 profile 複製品時 `account=false`、`stable=true`；頁面存在可見「登入」按鈕時 `auth_control=true` 且 `account=false`。

### ⚠️ 附件上傳修復驗證 (2026-09-29)
- 離線測試通過：`cargo fmt --all -- --check`、`cargo test --release`（132 passed）、`node --test tests/*.test.cjs`（30 passed，含新增 5 個上傳契約測試）。
- **同一失敗命令的修復前後對照（實機，managed Chrome／CDP 9223）**：修復前 `ask-bridge … --verify-attachments-only` 於 26 秒後以 `ChatGPT upload diagnostic: Attachment menu did not open`、exit 1 結束；修復後同一命令連續 3 次 `Attachments verified (documents only)`、exit 0（3 個新分頁各 2 個 chip）；混合附件（1 文件 + 1 圖片）回報 `Attachments verified: 1 document(s), 1 image(s).`、exit 0。
- **產品層真 UI 點擊 E2E**：yt_down_txt 工具箱以 Qt `QTest.mouseClick` 觸發「開始一鍵工作流」（offscreen，未搶佔前景），receipt 為 `attachment_verification=verified`（`attachment_count=2`）→ `prompt_submission=intent_recorded`、`model_selection=verified`、`failure_code=null`，`verdict=PASS_GATE`。
- 證據：`yt_down_txt/.agent/tasks/T20260929-1900-02-attachment-verification-failed/`（修復前日誌、修復後 ×3、混合附件、chip 快照、CDP 診斷腳本與 receipt）。

---


## [0.2.10] - 2026-09-22

### 🚀 新增 (Added)
- 新增 `verified_model_selection_v6` 能力宣告、推理強度契約 `reasoning_labeled_ordered_control_v4` 與證據 `labeled_effort_position_map_v1`；`capabilities --json` 與 `print_capabilities` 同時宣告 v5 與 v6，`verified_model_selection_v1` 至 `verified_model_selection_v5` 全部保留，未被移除。
- schema-v2 session receipt 新增 nullable 欄位 `model_selection_position_count`（v6 verified 為 `2..8`）；`model_selection_direct_semantic_count` 於 v6 verified 為 `1..position_count`、於 v5 verified 為 `0..3`，其他契約與 failed 路徑皆省略這兩個欄位。

### 🔧 修復 (Fixed)
- 修正 ChatGPT 推理強度 slider 被硬編成「恰好 3 個位置」的問題：舊版要求 `min=0`、`max=2` 且 ordinal total 固定為 3，遇到真實頁面的 4 位置（0=即時、1=中、2=高、3=升級鎖定）時，會以 `Model switch failed: reasoning slider state profile is invalid` 停止，session receipt 留下 `CHATGPT_MODEL_SELECTION_FAILED`、`failure_stage=model_selection`、`prompt_submission=not_started` 的 failed 狀態。
- 推理強度 domain 改為接受 2 至 8 個位置，並改以頁面自己公告的語意標籤驅動走訪與選取：每個走訪到的位置都必須有公告；無法辨識標籤的位置可略過但不可被選取；目標位置必須由公告直接對應目標等級。可辨識標籤與 ordinal 矛盾、同一位置標籤改變、重複標籤、semantic conflict 與 lock map 矛盾仍 fail-closed。
- `data-locked`（例如需要升級的 Pro 位置）不得選取；走訪遇到鎖定邊界即停止，鎖定位置不會出現在選取結果中。
- 模型選擇失敗時，session 模式會先寫入 failed receipt，再以「最佳努力」關閉 reasoning 選單；清理或關閉失敗只輸出警告，不會改寫已寫入的 receipt、失敗碼或退出結果。
- 補齊對應測試：Rust 端涵蓋 labeled position ledger、標籤驅動走訪、v6 receipt 欄位與 span／鎖定／漂移拒絕；Node DOM contract fixture 涵蓋 4 位置標籤、lock map、tick count 不一致、unknown label 與 upgrade-gated 目前位置。

### 🔧 變更 (Changed)
- 版本推進至 `0.2.10`（`Cargo.toml` 為 `0.2.10-preserve.1`），同步更新 `Cargo.toml`、`package.json`、`install.sh`、`install.ps1` 與 `scripts/ask.sh`。
- 向後相容性保留：v5 verified receipt（`reasoning_ordered_control_v3`／`ordered_bounded_effort_v1`／count `0..3`）仍可讀取與寫入，v1 至 v5 的能力宣告不變。
- 同步更新 `README.md` 與 `skills/ask-bridge/SKILL.md`：移除文件中的固定三段 profile 敘述，改為 v6 標籤化位置契約、鎖定位置規則與新 receipt 欄位說明。

---

## [0.2.5] - 2026-07-10

### 🚀 新增 (Added)
- 新增 `ask-bridge` 問答命令的等待逾時參數（`--timeout`），可自訂回應等待秒數。
- 調整預設回應等待逾時為 `300` 秒（`--timeout` 預設值），降低長時間等待中斷機率。
- `ask-bridge login` 新增登入頁面背景輪詢完成檢測，減少手動切換視窗等待時間。
- Windows 安裝腳本新增本地建構安裝模式（`install.ps1 -Local`），可直接安裝 `target\\release\\ask-bridge.exe`，並保留 `ask.exe` alias 安裝。

### 🔧 修復 (Fixed)
- 修正 npm publish 版本對齊流程，避免在重複發佈時版本比對失敗。
- 修正 CI 平台條件，避免在 Windows 專用 parser 測試執行於非 Windows 平台。
- 修正 `bump-and-release` 首版 SOP 與版本搜尋流程，提升版本升級一致性。

---

## [0.2.3] - 2026-07-10

### 🔧 修復 (Fixed)
- 在 Windows 安裝流程加入 Node.js 版本預檢，限制 `node --version` 至 `^20.19.0`、`^22.12.0` 或 `>=23.0.0`，避免安裝後才遇到 MCP 相容性錯誤。
- 在 CLI 啟動前加入 Node.js Runtime 檢查，若版本不符合 chrome-devtools-mcp 要求，提前中止並輸出可行動的錯誤訊息（含重開終端與安裝建議）。
- 補齊 Node 版本判斷的單元測試：覆蓋支援邊界值與錯誤格式，降低版本不相容回歸風險。

---

## [0.2.2] - 2026-07-10

### 🚀 新增 (Added)
- **Claude（claude.ai）provider 支援**：新增 `--provider claude`，透過 Chrome 自動化 claude.ai 網頁送出 prompt 並取回回覆，與 ChatGPT / Gemini 採相同架構。支援登入偵測（三態 `LoggedIn` / `LoggedOut` / `Unknown`）、分頁重用、`--new` 開新對話、Thread Link 輸出與 `-o` Markdown 檔案輸出。
- Claude 支援 `--image` / `--file` 附件上傳（走既有 DataTransfer 路徑）與 `--model` 模型切換（如 `Sonnet`、`Opus`、`Haiku`，不分大小寫與標點，支援子選單走訪）。
- Selector 依 claude.ai 實站校準：composer 以 `data-testid="chat-input"` 優先；回覆容器採 `.font-claude-response`（`data-is-streaming` 屬性僅掛在最後一則回覆容器，不適合用於訊息計數）。

### 🔧 修復 (Fixed)
- 修正非 Windows 系統（如 macOS、Linux）編譯時，僅在 Windows 平台使用的輔助函數 `parse_windows_netstat_listener_pids` 與 `parse_wmic_column_value` 會產生未使用的編譯警告。

---

## [0.2.1] - 2026-07-10

### 🔧 修復 (Fixed)
- 修正 Windows 執行 `ask-bridge login` 後 Chrome 可能隨命令結束而退出的問題；Chrome 現在會以獨立程序群組與脫離式程序啟動，讓登入工作階段可供後續查詢沿用。
- 強化 `9223` 連接埠的 Chrome 擁有權辨識，加入 ask-bridge 專用標記、PID 紀錄與父程序鏈檢查，避免 Windows Chrome 多程序架構造成誤判。
- 將 ChatGPT 與 Gemini 登入判斷改為 `LoggedIn`、`LoggedOut`、`Unknown` 三態；僅有輸入框時不再誤報登入成功，無法確認時則保留查詢嘗試並顯示警告。
- 多個服務提供者分頁同時存在時優先選取已登入分頁，避免誤選登入頁或未登入分頁。
- Windows `ask-bridge close` 改用 `taskkill /F /PID`，並在程序結束後清理 PID 紀錄。

---

## [0.2.0] - 2026-07-09

### 🚀 新增 (Added)
- 支援 ChatGPT `@Agent` 提示詞輸入；符合 `@名稱 正文` 格式且 Agent 名稱為 1 至 10 個非空白字元時，會先輸入 Agent mention、等待選單出現、按下 Tab 建立 Agent pill，再輸入正文並送出。
- 新增 Agent 提示詞解析與互動流程驗證，涵蓋中文 Agent 名稱、10 字上限、額外空白及不符合格式的輸入。
- 一般 ChatGPT 提示詞與 Gemini 提示詞維持原有送出流程，不套用 Agent 特殊處理。

---

## [0.1.5] - 2026-07-09

### 🔧 修復 (Fixed)
- 修正 ChatGPT 登入判斷過度依賴單一登入按鈕 selector 的問題，改以可見登入控制項、輸入框、帳號選單與登入 URL 綜合判斷。
- 查詢時直接重用已監聽 `9223` 的 ask-bridge Chrome，避免從可見登入模式切換至背景模式時重新啟動 Chrome 並遺失登入狀態。
- 正規化 `--user-data-dir` 命令列比對，支援 Windows 反斜線、引號及參數值以空白分隔的形式。
- 調整 Windows `ask-bridge close` 流程，先嘗試正常終止 Chrome，逾時後再強制關閉。

---

## [0.1.4] - 2026-07-09

### 🔧 修復 (Fixed)
- 修正 Linux/WSL 執行 `ask-bridge --verbose login` 時誤尋找 macOS Chrome 路徑的問題，現在會偵測 `PATH` 中的 `google-chrome` / `google-chrome-stable`，並支援 `/usr/bin/google-chrome` 等常見安裝路徑。
- 修正 `make install` 在 Linux/WSL 環境下的 Chrome 檢查邏輯，避免套用 macOS-only 的 `/Applications/Google Chrome.app` 偵測。

---

## [0.1.3] - 2026-07-08

### 🔧 變更 (Changed)
- 將 `mcp-cli` 依賴從本機路徑更換為指向官方 GitHub 倉庫，使其可以持續同步並拉取最新釋出的 `mcp-cli` 版本（已拉取最新 `v0.2.0` 版本）。

---

## [0.1.2] - 2026-07-08

### 🚀 新增 (Added)
- 建立專利維護指南 [AGENTS.md](file:///G:/Projects/ask-bridge/AGENTS.md)，提供後續 AI 協作者完整的開發架構與相容性修復準則。
- 建立 AI 專用技能定義文件 [.agents/skills/bump-and-release/SKILL.md](file:///G:/Projects/ask-bridge/.agents/skills/bump-and-release/SKILL.md)，詳細說明版本號提升 SOP 與 Git 提交標記步驟。

### 🔧 修復 (Fixed)
- **跨平台 Windows 完整支援**：
  - **Google Chrome 路徑自動偵測**：修正原先硬編碼為 macOS 路徑的問題。現在可在 Windows 環境下自動搜尋系統 `Program Files`、`Program Files (x86)` 與 `%LOCALAPPDATA%` 中的預設安裝位置。
  - **行程與連接埠管理**：
    - Windows 環境中改用 `netstat -ano` 代替 `lsof` 搜尋佔用 `9223` 連接埠的處理程序。
    - 優先使用 `wmic` 取得 Chrome 啟動參數確認其擁有權，若失敗則 Fallback 呼叫 `PowerShell` 命令。
    - 在 Windows 下改用 `taskkill /F` 取代 Unix 的 `kill -TERM` 終止處理程序。
  - **系統限制過濾**：使用 `#[cfg(target_os = "macos")]` 條件編譯，確保 Windows 平台不會觸發 macOS 獨有的 `osascript`（AppleScript）命令。
- **編譯警告優化**：消除 Windows 編譯時因條件編譯產生的未使變數（`unused variables`）警告。
- **程式碼排版美化**：使用 `cargo fmt` 重新校正並排版全專案，確保代碼完全符合 Rustfmt 官方規範。

---

## [0.1.1] - 2024-04-10

- 初始公開釋出版。
- 支援透過 macOS Chrome 的遠端除錯協定（連接埠 `9223`）進行 ChatGPT 與 Gemini 自動化。
- 提供 MCP 連接、背景視窗隱藏與快速問答功能。
