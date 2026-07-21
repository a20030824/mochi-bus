# Mochi Bus 生產可觀測性與故障復原審計 — 2026-07-19

> 這份審計已凍結為歷史快照。它記錄 2026-07-19 當時可見的 failure model、telemetry contract、decision matrix 與實作規劃，不再同時維護即時 implementation status。

- [閱讀 immutable 2026-07-19 原始審計](https://github.com/a20030824/mochi-bus/blob/c76d75a454d1c552b90e31fa6cedb90df5805dbb/docs/audits/2026-07-19-production-observability-recovery-audit.md)
- [閱讀 2026-07-22 目前實作狀態](./2026-07-22-production-observability-implementation-status.md)

## 為什麼分開

原文件末端曾把 A5b、A6a、A6b 標為「只在本機完成」，之後這些實作已進入 `main`，且又經過 production evidence repair、deploy gate、bounded logging、E2E state isolation 與 Linux visual regression 等後續修復。

若直接回頭改寫 2026-07-19 的全文，會讓讀者無法分辨：

1. 當時實際觀察到的盲區；
2. 後來已合併的 remediation；
3. 到現在仍未完成的 A7–A9 能力。

因此原始內容固定在合併 PR #146 後的 `c76d75a454d1c552b90e31fa6cedb90df5805dbb`，目前狀態則由獨立 tracker 維護。每次 tracker 更新都必須附核對日期與 `main` SHA，且不得把 repository checks、pre-deploy verification 或 synthetic browser evidence 誤寫成即時 production health。
