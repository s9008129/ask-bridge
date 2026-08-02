# Lessons Learned

## 2026-07-10 Windows quiet MCP 與 JSON fence 碰撞

- Mistake class: incorrect assumption about repository/runtime behavior、missing verification。
- Failure mode: 為隱藏 MCP stderr 而把 Windows stdio server 包進 `cmd.exe /c ... 2>nul`，同時失去可靠的 transport 與失敗診斷；另以第一個三反引號尋找 evaluate_script JSON fence 結尾，遇到回答內的 Markdown code fence 便截斷合法 JSON 字串。
- Detection signal: 同一環境下 quiet 在 `initialize` 回報 server EOF 且沒有 stderr，verbose 直接 `npx.cmd` 則成功；回覆在第一個 ` ```rust ` 前報 `EOF while parsing a string`，瀏覽器已有完整回答但終端只剩 Thread Link。
- Prevention rule: verbosity 不得改變 MCP transport，只能控制 flags/env/呈現；quiet 應在 forwarding 呈現層抑制 stderr，不能在 child transport 前丟棄診斷。結構化資料必須交給 JSON parser 判定值邊界，再獨立驗證 wrapper fence，不得用第一個 Markdown delimiter 截斷內嵌 JSON。
- Tripwires:
  - 單元測試固定斷言 Windows／Unix quiet 與 verbose 使用相同 direct executable transport、不含 shell redirection，且僅 quiet 保留降噪 flags/env。
  - 單元測試固定涵蓋 evaluate_script JSON 字串內含多行 Markdown、程式語言 code fence、雙引號、缺少 closing fence、尾端污染與 malformed response shape。
  - Parser／MCP shape 錯誤不得包含原始 payload；Windows release 前以非 verbose 與 verbose 各執行一次含程式碼區塊的 query，並確認 quiet 不漏 banner、失敗仍有 child stderr 診斷。

## 2026-07-10 Windows Chrome ownership 與登入判斷回歸

- Mistake class: incorrect assumption about repository/runtime behavior、missing verification。
- Failure mode: 把 `Command::spawn()` 回傳的 Chrome launcher PID 當成最終 9223 listener，並假設 WMI/CIM parent-chain 永遠可查；同時以單次 ChatGPT DOM snapshot 決定登入狀態。
- Detection signal: verbose log 同時出現不同的 `recorded PID`／`listener PID`、空的 `ask-bridge owner PIDs`，登入完成後為 `Unknown`，下一次 query 又立即成為 `LoggedOut`。
- Prevention rule: Windows Chrome 啟動完成後必須驗證 listener 來源、記錄實際 listener 與 CDP browser identity；reuse／close 共用同一 ownership snapshot，強殺前重新驗證。登入 UI 必須經 bounded stabilization，未穩定只能回 `Unknown`，不得硬判登出。
- Tripwires:
  - 單元測試固定涵蓋 launcher PID 與 listener PID 不同、WMI 空白列、9223／92230 精確解析、stale identity、mixed listeners 與強殺 identity 改變。
  - 單元測試固定涵蓋 ChatGPT auth path precedence、composer-only provider 差異、未穩定訊號不得成為 `LoggedIn`／`LoggedOut`。
  - Windows release 前執行 login → 保持 Chrome 開啟 → query → graceful close → restart query 的真機流程；若無法執行，必須明確記錄限制，不得只以跨平台單元測試宣稱 session 問題已解決。

## 2026-07-29 專案 provider denylist 必須先於 skill 與既有相容性

- Mistake class: misunderstanding requirements、security/privacy oversight。
- Failure mode: ask-bridge skill 與既有程式碼雖宣稱 Claude 相容，若未先套用本專案明確 denylist，Agent 可能把 Claude 當成可用的 live 驗證 provider。
- Detection signal: 任務限制已寫明 ask-bridge MUST NOT use Claude，但執行計畫仍包含 Claude CLI、session、login、query、upload、mutation 或 live probe。
- Prevention rule: 每次執行任何 provider 命令前先建立本輪 allowlist／denylist；專案級 denylist 優先於 skill、help 與既有功能宣告。可保留未被要求刪除的跨 provider相容程式碼，但只能以純函式、mock 或 fixture 離線驗證。
- Tripwires:
  - 執行任何 `ask-bridge` provider 命令前搜尋本輪 todo/lessons 的 `MUST NOT use Claude`，命中即停止 Claude 路徑。
  - 驗證紀錄若出現 Claude，只能是 source-level pure test/mock/fixture，不得包含 CLI、session、login、query、upload、mutation 或 live probe。

## 2026-07-29 外層 deadline 必須涵蓋所有 nested timeout

- Mistake class: incorrect assumption about repo behavior、missing verification。
- Failure mode: 附件 probe 雖把剩餘 60 秒傳給 tool timeout，但 session slot 為空或 config 改變時，內層 connect 先使用獨立 120 秒 timeout；reset、connect、owned-page select 與 probe tool 因此可能串接超過外層 deadline。
- Detection signal: 從 `verify_attachment_completion()` 沿呼叫鏈檢查時，發現 `remaining` 只約束最內層 tool，`mcp_session_connect()` 與 reset 仍讀固定常數。
- Prevention rule: 任何宣告 end-to-end timeout 的安全閘門都必須建立單一 absolute deadline，所有 nested reset/connect/select/tool phase只能取得 `min(phase cap, remaining)`；deadline耗盡即 fail-closed，且不得 replay remote call。
- Tripwires:
  - 逐層搜尋 timeout/deadline 呼叫鏈，確認沒有在內層重新建立較長 timer或忽略外層 budget。
  - 使用 synthetic `Instant` 的 deterministic test，固定驗證 connect 消耗 budget 後 tool只得到剩餘時間，耗盡時立即回錯；不得用真實 60 秒 sleep。
  - 附件 gate regression固定斷言 uploading、missing、error、timeout 的 submit closure呼叫次數皆為 0。

## 2026-08-02 Provider 完成必須由預期產物證明

- Mistake class: incorrect assumption about repo behavior、missing verification。
- Failure mode: 把「新增 assistant 節點且 Stop control 短暫消失」當成圖片生成完成；provider 圖片實際稍後才載入，bridge 先退出後又把零圖片下載視為成功，形成遠端已有產物、本機卻是空輸出。
- Detection signal: receipt 顯示 prompt 已 submitted，但本機沒有圖片；既有輪詢只觀察 assistant count／Stop，不觀察最新回應中的 loaded large image，也沒有把 download count 納入 exit contract。
- Prevention rule: 完成條件必須由呼叫者宣告的預期輸出種類決定。圖片工作只有在唯一新增 assistant、無生成控制項、至少一張已載入大尺寸圖片、DOM 簽章連續穩定且 response identity 未改變後才可下載；零產物與下載錯誤必須 fail loudly。
- Tripwires:
  - pure state-machine regression 固定重播「assistant 先出現、Stop 消失超過舊穩定窗、圖片稍後出現」，圖片出現前不得 completed。
  - `--image-output` 的 zero/download error/timeout/ownership or URL interference 固定映射 non-zero 與低敏感度 receipt failure code。
- capability gate 固定要求 `verified_image_response_completion_v1`；receipt privacy canary不得出現在 prompt、回覆、URL、DOM、檔名或路徑欄位。

## 2026-08-02 SPA 語意 identity 與 provider 拒絕終態

- Mistake class: incorrect assumption about provider DOM／timing、missing verification。
- Failure mode: ChatGPT 以外層 `.agent-turn` 加內層 assistant role 造成同一 turn 雙計；新對話又會先經 home／`conversation:WEB:*` 再切正式 UUID；Stop 可在同一圖片回應中 remount。另一種終態是 assistant 已明確回報政策／暫時限制拒絕但沒有圖片，若只等待 artifact 會拖到完整 timeout。
- Detection signal: readonly CDP 顯示 canonical assistant=1、舊 selector=2；同一頁的 semantic conversation／turn／artifact anchor 未變但 Stop 先消失後出現；provider refusal turn 為 Stop=0、large image=0、穩定 DOM，receipt 卻長時間 pending。
- Prevention rule: selector 必須以 containment 去重；response identity 只鎖 canonical conversation、latest turn、artifact ID set 與 ownership token，允許一次 home→conversation／WEB→UUID transition，禁止之後 A→B。Stop 是 readiness，不是 identity。圖片 provider refusal 只能在本次 owned latest turn、無 Stop／大圖、明確 marker 且同一 DOM signature 連續三次穩定後以 `provider_rejected` fail closed；不保存錯誤文字，也不自動重送已 submitted Prompt。
- Tripwires:
  - Chrome fixture 固定驗證 nested／agent-only／role-only／sibling selector counts；state machine 固定覆蓋 home→conversation、WEB→UUID、Stop remount 與真正 turn／artifact change。
  - refusal fixture 固定要求單次／兩次 marker probe 維持 Pending，第三次穩定才 Unknown；普通串流文字、marker 消失或大圖出現不得誤判拒絕。
  - 每次真實 provider E2E 先保存 low-sensitivity manifest／receipt／hash；看到 `prompt_submission=submitted` 後不重送，並把 provider failure 與 bridge timeout 分開記錄。
