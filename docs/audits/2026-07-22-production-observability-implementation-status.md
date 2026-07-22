# Mochi Bus 生產可觀測性與故障復原實作狀態 — 2026-07-22

> 本文件是目前 repository implementation tracker，不是即時 production health dashboard，也不取代 2026-07-19 的審計判斷。狀態於 2026-07-23 重新核對 `main` commit `f3abd0ac0827f674fa34e93307416b2508d1b667`；PR #157 的 A8 delta 另列，不能在合併與首個 Deploy workflow 成功前解讀為 production acceptance。

原始審計的故障模型、telemetry contract、decision matrix 與三階段方案，保留在 [2026-07-19 immutable audit snapshot](https://github.com/a20030824/mochi-bus/blob/c76d75a454d1c552b90e31fa6cedb90df5805dbb/docs/audits/2026-07-19-production-observability-recovery-audit.md)。

## 1. 如何閱讀狀態

- **已合併**：實作已在 `main`，但不等同於此刻 production 一定健康。
- **已驗證**：對應 PR 的 repository checks 通過；production acceptance 只在有 durable evidence 或明確 workflow 結果時另行標示。
- **PR 實作**：能力存在於指定 PR；合併與 production acceptance 仍是不同關卡。
- **部分完成**：已有相鄰保護，但原審計定義的完整能力仍未建立。
- **待設定**：屬於 GitHub／Cloudflare repository setting，不應偽裝成程式碼 PR 已完成。

## 2. Phase A 實作狀態

| 批次 | 目前狀態 | 主要證據與邊界 |
| --- | --- | --- |
| A1 telemetry schema/privacy boundary | 已合併（`b13057c`） | Allowlist envelope、禁止欄位、fail-open emitter 與測試已建立；原始 batch 不含產品 callsite。 |
| A2 release identity | 已合併（`baea152`） | Version Metadata、完整 release SHA 與唯讀 release identity 已建立；`deploymentId` 沒有被 Worker version 冒充。 |
| A3 API completion denominator | 已合併（`22933f0`） | 四個 Map operation 使用 complete-once、固定 cohort sampling 與 success／degraded／empty／error 分母。 |
| A4 TDX resolution completion | 已合併（`0673335`） | memory／edge／upstream／circuit／stale 與受控 retry 被收斂為一筆 logical resolution completion。 |
| A5a snapshot window outcome | 已合併（`aad570b`） | Durable attempt/canonical window、deterministic window ID、source/publish time 分離與安全 summary 已建立。 |
| A5b unchanged active probe | 已合併（`c2c45e3`） | `unchanged` 前驗證 D1 authority、manifest、network、public catalogue 與 deterministic route/place sample；後續另有 bounded manifest/network metadata hardening。 |
| A6a missed-window watchdog | 已合併（`feb9aa6`） | 共用 Asia/Taipei schedule/window identity、07:30 close、07:45 watchdog、durable run/city result 與 probe evidence expiry 已建立。A6 evidence 後續由 PR #56、#58、#59、#60 修復、重跑並清除一次性 trigger。 |
| A6b daily public probe | 已合併（`614ad00`） | 每日 22 城公網 probe、hard health／realtime diagnostics、bounded reads、rotation 與 durable completion 已建立；probe 曾實際抓出 snapshot catalogue/pattern 問題，後續由 PR #50、#53 修正。 |
| A7 rollback authority | 已合併（`f3abd0ac`，PR #156） | D1 active 是唯一 current authority；完整 target gate、expected-current transition、smoke restore、R2 reconcile、state-write/cleanup failure separation 與 bounded diagnostics 已建立。沒有執行 production rollback 或 reconcile。 |
| A8 post-deploy release-specific smoke | PR #157 實作 | Deploy 後等待 exact release SHA／Worker version，再做 pages、recursive hashed assets、Taipei/Chiayi API、degraded-capable arrivals、fresh Chromium、10 分鐘 observation 與 final postflight。沒有自動 rollback；首個 merge-triggered Deploy workflow 才能形成 production acceptance evidence。 |
| A9 fresh-browser + organic frontend evidence | 部分完成 | PR #145 隔離 stateful E2E；PR #146 加入 Linux visual regression；PR #157 只增加 deploy-time synthetic fresh-browser smoke。這些都不等同於 production organic frontend boot/runtime collector。 |

## 3. 2026-07-22～2026-07-23 remediation log

| PR | Merge commit／狀態 | 已完成 | 明確未包含 |
| --- | --- | --- | --- |
| #142 `fix(ci): verify production release before deploy` | `9c77506cf353a5cc60452532d32c626bf1bf05af` | Deploy workflow 在 `npm ci` 後執行完整 `npm run check`，阻止未通過 exact-release 驗證的 commit 發布。 | GitHub ruleset 的 strict up-to-date checks；真正 post-deploy smoke。 |
| #143 `fix(map): keep failed timetable stop navigation consistent` | `6d2c318e40f6071b25924539687d12e7eae7d059` | 明確選取的 timetable stop 在 request 前寫入 session/URL；失敗、retry、reload 不再退回舊站牌。 | Timetable API/schema 或 rendering 重寫。 |
| #144 `fix(observability): bound production error logs` | `3cef46289b76f1b25924539687d12e7eae7d059` | 三個高風險 Worker callsite 改用 bounded structured record，只允許 event、operation、city、failureClass、errorType。 | API response、fallback denominator、snapshot CLI diagnostics 或第三方 logging。 |
| #145 `fix(e2e): isolate shared Worker state` | `c193779e0ac9a8bc101a59ab2d1976b1c029ffba` | 普通 UI 與 Worker-stateful suite 分開執行；stateful case 使用 fresh Wrangler、單 worker、逐案 reset，普通 UI API request 被 firewall。 | Production reset endpoint；test route 沒有明確 test binding 時回 404。 |
| #146 `ci(visual): run screenshot regression on Linux` | `c76d75a454d1c552b90e31fa6cedb90df5805dbb` | 六張 reviewed Linux baseline 接入獨立 read-only visual job；差異失敗時保留 expected／actual／diff/report。 | 尚未加入 required-check ruleset；CI 不會自動更新或 push snapshot。 |
| #155 `ci(snapshot): make manual city input a choice` | `fbb4a96b78b44f8e3e497cd89f11a73f6c2317e1` | Manual snapshot dispatch 使用與 `supportedCities` 精確一致的 22-city choice。 | Scheduled sharding、repair guards、snapshot algorithm。 |
| #156 `fix(snapshot): enforce rollback authority` | `f3abd0ac0827f674fa34e93307416b2508d1b667` | A7 authority、reconcile、optimistic guard、完整 target evidence、failure semantics 與 runbook。 | Production rollback/reconcile、A8、A9。 |
| #157 `feat(deploy): verify the deployed release` | PR 實作；production evidence 待 Deploy | A8 exact-release post-deploy HTTP/assets/API/browser/observation contract與 bounded report。 | 自動 rollback、Visual required check、organic frontend collector。 |

## 4. 目前仍需處理

### Repository settings

1. `main` ruleset 的 **Require branches to be up to date before merging** 已由 repository owner 透過 GitHub UI 設定；這項狀態不在 git 內，tracker 不把程式碼 PR 當成設定證據。
2. 觀察 `Visual regression` 經過一般 UI 變更的穩定度，再決定是否加入 required status checks。

### Product／operations capability

1. **A8 production acceptance**：PR #157 合併後，檢查由該 merge commit 觸發的 Deploy workflow、`release-smoke-report.json` 與 exact release identity；PR checks 本身不能代替。
2. **A9 organic frontend evidence**：只有 production error volume、release correlation 與 triage 需求證明必要時，才加入 bounded collector；不得記 URL/query、精確位置、board/journey identity、raw error 或 stack。

## 5. 驗證與維護規則

- 每次更新本 tracker，必須寫明核對日期與 `main` SHA。
- 不得把 PR checks 通過寫成「production 現在健康」。
- 不得把 pre-deploy verification 寫成 post-deploy smoke。
- 不得把 Playwright／visual／deploy-time synthetic evidence 寫成 organic frontend telemetry。
- 原始審計結論應以 immutable commit 保存，不回頭改寫當時未知的事實。
