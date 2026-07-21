// 主文字與同列的次要資訊用文字基線對齊；描述整張卡片／雙行內容的狀態徽章仍維持置中。
// 這組規則跨一般頁與地圖頁共用，由 appearance shell 在首次繪製前注入。
export const interfaceAlignmentStyles = `
.route-stop > div,
.board-title-line,
.nearby-place-button,
.trip-nearby-candidate,
.direct-route-select > span,
.transfer-title,
.timetable-period {
  align-items: baseline;
}

.route-stop.selected em {
  transform: translateY(1px);
}

.place-route-main > strong,
.place-route-main > .place-route-eta {
  align-self: baseline;
}
`
