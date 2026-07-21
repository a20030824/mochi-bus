# Mochi Bus 生產可觀測性與故障復原實作狀態 — 2026-07-22

> 本文件是目前 repository implementation tracker，不是即時 production health dashboard，也不取代 2026-07-19 的審計判斷。實作狀態最後核對於 `main` commit `c76d75a454d1c552b90e31fa6cedb90df5805dbb`；本次純文件更新不包含在該基準內。

原始審計的故障模型、telemetry contract、decision matrix 與三階段方案，保留在 [2026-07-19 immutable audit snapshot](https://github.com/a20030824/mochi-bus/blob/c76d75a454d1c552b90e31fa6cedb90df5805dbb/docs/audits/2026-07-19-production-observability-recovery-audit.md)。

## 1. 如何閱讀狀態

- **已合併**：實作已在 `main`，但不等同於此刻 production 一定健康。
- **已驗證**：對應 PR 的 repository checks 通過；production acceptance 只在有 durable evidence 或明確 workflow 結果時另行標示。
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
| A7 rollback authority | 尚未由本輪重新證明完成 | 仍需以 D1 active pointer 為唯一服務權威，並對 rollback 後 R2 state divergence／reconcile 建立完整、可重放契約。 |
| A8 post-deploy release-specific smoke | 部分完成 | PR #142 會在部署前對即將發布的 exact `main` commit 重跑完整 `npm run check`；但「部署後命中新 release 的 HTTP/assets/browser smoke 與觀察窗」仍未完成。 |
| A9 fresh-browser + organic frontend evidence | 部分完成 | PR #145 隔離 stateful E2E；PR #146 加入 Linux visual regression。這些是 CI synthetic evidence，不等同於 production organic frontend boot/runtime collector。 |

## 3. 2026-07-22 remediation log

| PR | Merge commit | 已完成 | 明確未包含 |
| --- | --- | --- | --- |
| #142 `fix(ci): verify production release before deploy` | `9c77506cf353a5cc60452532d32c626bf1bf05af` | Deploy workflow 在 `npm ci` 後執行完整 `npm run check`，阻止未通過 exact-release 驗證的 commit 發布。 | GitHub ruleset 的 strict up-to-date checks；真正 post-deploy smoke。 |
| #143 `fix(map): keep failed timetable stop navigation consistent` | `6d2c318e40f6071b25924539687d12e7eae7d059` | 明確選取的 timetable stop 在 request 前寫入 session/URL；失敗、retry、reload 不再退回舊站牌。 | Timetable API/schema 或 rendering 重寫。 |
| #144 `fix(observability): bound production error logs` | `3cef46289b76d8c15ad9e1430dcd49ea264e216e` | 三個高風險 Worker callsite 改用 bounded structured record，只允許 event、operation、city、failureClass、errorType。 | API response、fallback denominator、snapshot CLI diagnostics 或第三方 logging。 |
| #145 `fix(e2e): isolate shared Worker state` | `c193779e0ac9a8bc101a59ab2d1976b1c029ffba` | 普通 UI 與 Worker-stateful suite 分開執行；stateful case 使用 fresh Wrangler、單 worker、逐案 reset，普通 UI API request 被 firewall。 | Production reset endpoint；test route 沒有明確 test binding 時回 404。 |
| #146 `ci(visual): run screenshot regression on Linux` | `c76d75a454d1c552b90e31fa6cedb90df5805dbb` | 六張 reviewed Linux baseline 接入獨立 read-only visual job；差異失敗時保留 expected／actual／diff/report。 | 尚未加入 required-check ruleset；CI 不會自動更新或 push snapshot。 |

## 4. 目前仍需處理

### Repository settings

1. 在 `main` ruleset 開啟 **Require branches to be up to date before merging**，避免 PR 只在舊 base 上通過。
2. 觀察 `Visual regression` 經過一般 UI 變更的穩定度，再決定是否加入 required status checks。

這兩項是 repository governance，不應用修改 workflow 檔案來假裝完成。

### Product／operations capability

1. **A7 rollback authority**：鎖定 D1/R2 divergence、reconcile 與 fail-closed rollback contract。
2. **A8 true post-deploy smoke**：確認 probe 命中剛部署 release，再驗證 pages、hashed assets、代表城市 API、degraded contract 與 fresh browser boot。
3. **A9 organic frontend evidence**：只有 production error volume、release correlation 與 triage 需求證明必要時，才加入 bounded collector；不得記 URL/query、精確位置、board/journey identity、raw error 或 stack。

## 5. 驗證與維護規則

- 每次更新本 tracker，必須寫明核對日期與 `main` SHA。
- 不得把 PR checks 通過寫成「production 現在健康」。
- 不得把 pre-deploy verification 寫成 post-deploy smoke。
- 不得把 Playwright／visual synthetic evidence 寫成 organic frontend telemetry。
- 原始審計結論應以 immutable commit 保存，不回頭改寫當時未知的事實。
