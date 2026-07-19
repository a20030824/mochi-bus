export const appearanceStyles = `
html[data-appearance-page="general"][data-general-theme="dark"] {
  color-scheme: dark;
  --text-muted: #aaa197;
  --text-faint: #8d867a;
  --accent: #df7357;
  --accent-deep: #f09b80;
  --green: #81a08f;
  --green-deep: #a9c0b2;
}
html[data-appearance-page="general"][data-general-theme="dark"] body { background: #211f1b; color: #f8f0e3; }
html[data-appearance-page="general"][data-general-theme="dark"] .panel { border-color: #464139; background: #2a2722; }
html[data-appearance-page="general"][data-general-theme="dark"] :is(.board-item, .result-card, .choice, input, select, .route-choice, .check-row) { border-color: #4d473e; background: #302c26; color: #f8f0e3; }
html[data-appearance-page="general"][data-general-theme="dark"] :is(.icon-link, .chip) { border-color: #4d473e; }
html[data-appearance-page="general"][data-general-theme="dark"] :is(.chip.active, .route-badge, .flow-steps span.active) { background: #f8f0e3; color: #211f1b; }
html[data-appearance-page="general"][data-general-theme="dark"] :is(.bus-row, .step, .footer-action) { border-color: #4d473e; }
html[data-appearance-page="general"][data-general-theme="dark"] :is(.eyebrow, .eta-footer, .board-item .favorite-route-number, .result-card p, .choice span, .route-head p, .route-stop > span:last-child) { color: var(--text-muted); }
html[data-appearance-page="general"][data-general-theme="dark"] .notice { color: #f09b80; }
html[data-appearance-page="general"][data-general-theme="dark"] .route-stop::before { background: #4d473e; }
html[data-appearance-page="general"][data-general-theme="dark"] .route-stop .dot { border-color: #211f1b; }
html[data-appearance-page="general"][data-general-theme="dark"] .route-grid::after { background: linear-gradient(to bottom, rgba(42, 39, 34, 0), rgba(42, 39, 34, .96)); }

html[data-appearance-page="general"][data-general-theme="light"] {
  color-scheme: light;
  --text-muted: #6b6359;
  --text-faint: #8d867a;
  --accent: #b85f49;
  --accent-deep: #9b4735;
  --green: #4f685b;
  --green-deep: #3f594c;
}
html[data-appearance-page="general"][data-general-theme="light"] body { background: #f7f2e8; color: #29251f; }
html[data-appearance-page="general"][data-general-theme="light"] .panel { border-color: #ded6c9; background: rgba(255, 250, 240, .62); }
html[data-appearance-page="general"][data-general-theme="light"] :is(.board-item, .result-card, .choice, input, select, .route-choice, .check-row) { border-color: #ded6c9; background: #fffaf0; color: #29251f; }
html[data-appearance-page="general"][data-general-theme="light"] :is(.icon-link, .chip) { border-color: #d8d0c2; }
html[data-appearance-page="general"][data-general-theme="light"] :is(.chip.active, .route-badge, .flow-steps span.active) { background: #29251f; color: #fffaf0; }
html[data-appearance-page="general"][data-general-theme="light"] .bus-row { border-color: #ddd3c4; }
html[data-appearance-page="general"][data-general-theme="light"] :is(.step, .footer-action) { border-color: #d8d0c2; }
html[data-appearance-page="general"][data-general-theme="light"] :is(.eyebrow, .eta-footer, .board-item .favorite-route-number, .result-card p, .choice span, .route-head p, .route-stop > span:last-child) { color: var(--text-muted); }
html[data-appearance-page="general"][data-general-theme="light"] .notice { color: var(--accent-deep); }
html[data-appearance-page="general"][data-general-theme="light"] .route-stop::before { background: #d8d0c2; }
html[data-appearance-page="general"][data-general-theme="light"] .route-stop .dot { border-color: #f7f2e8; }
html[data-appearance-page="general"][data-general-theme="light"] .route-grid::after { background: linear-gradient(to bottom, rgba(252, 247, 237, 0), rgba(252, 247, 237, .96)); }

html[data-appearance-page="map"][data-map-ui-theme="light"] {
  color-scheme: light;
  --ink: #29251f;
  --paper: #f4efe4;
  --paper-strong: #fffaf0;
  --canvas: #e8e2d6;
  --surface: #ebe5d9;
  --line: #cfc7b8;
  --line-faint: #ded6c9;
  --line-strong: #a89f8d;
  --skeleton-base: #e8e1d5;
  --skeleton-highlight: #f3ede3;
  --text-muted: #6b6359;
  --text-faint: #8d867a;
  --accent: #b85f49;
  --accent-deep: #9b4735;
  --ink-live: #29251f;
  --ink-estimated: #6b6359;
  --ink-urgent: #9b4735;
  --green: #4f685b;
  --green-deep: #3f594c;
  --shadow-marker: 0 3px 10px rgba(41, 42, 37, .18);
  --shadow-overlay: 0 8px 24px rgba(48, 45, 38, .14);
}
html[data-appearance-page="map"][data-map-ui-theme="light"] .leaflet-control-attribution { background: rgba(244, 239, 228, .82) !important; }
html[data-appearance-page="map"][data-map-ui-theme="light"] .leaflet-control-attribution a { color: var(--green); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .leaflet-control-zoom a { color: var(--ink) !important; background: rgba(244, 239, 228, .96) !important; border-color: var(--line-strong) !important; }
html[data-appearance-page="map"][data-map-ui-theme="light"] :is(.map-brand, .quiet-button) { background: rgba(244, 239, 228, .97); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .drawer-back { background: transparent; }
html[data-appearance-page="map"][data-map-ui-theme="light"] .map-drawer { background: rgba(244, 239, 228, .97); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .drawer-scroll-fade { background: linear-gradient(to bottom, rgba(244, 239, 228, 0), rgba(244, 239, 228, .97)); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .map-status { background: rgba(41, 42, 37, .84); color: var(--paper); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .map-search { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b6359' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-4-4'/%3E%3C/svg%3E"); }
html[data-appearance-page="map"][data-map-ui-theme="light"] :is(.map-search:focus-visible, .timetable-stop-field select:focus-visible) { box-shadow: 0 0 0 3px rgba(79, 104, 91, .15); }
html[data-appearance-page="map"][data-map-ui-theme="light"] :is(.region-marker, .city-marker) { border-color: rgba(41, 42, 37, .35); background: rgba(244, 239, 228, .92); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .city-marker { border-color: var(--green); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .route-service-summary { background: rgba(235, 229, 217, .72); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .trip-nearby-candidate.selected { background: rgba(79, 104, 91, .12); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .favorite-direction-button.selected { background: rgba(184, 95, 73, .12); }
html[data-appearance-page="map"][data-map-ui-theme="light"] .timetable-minute.next { box-shadow: 0 0 0 2px rgba(184, 95, 73, .14); }
html[data-appearance-page="map"][data-map-ui-theme="light"] :is(.direct-route-card.selected, .transfer-plan.selected) { box-shadow: var(--shadow-overlay); }

html[data-appearance-page="map"][data-map-ui-theme="dark"] {
  color-scheme: dark;
  --ink: #f3ebde;
  --paper: #28251f;
  --paper-strong: #322e27;
  --canvas: #1d1c19;
  --surface: #302c26;
  --line: #504a41;
  --line-faint: #403b34;
  --line-strong: #71695c;
  --skeleton-base: #2e2a24;
  --skeleton-highlight: #38332b;
  --text-muted: #aaa197;
  --text-faint: #817a70;
  --accent: #df7357;
  --accent-deep: #f09b80;
  --ink-live: #f3ebde;
  --ink-estimated: #aaa197;
  --ink-urgent: #f09b80;
  --green: #81a08f;
  --green-deep: #a9c0b2;
  --shadow-marker: 0 3px 10px rgba(0, 0, 0, .45);
  --shadow-overlay: 0 8px 24px rgba(0, 0, 0, .5);
}
html[data-appearance-page="map"][data-map-ui-theme="dark"] .leaflet-control-attribution { background: rgba(40, 37, 31, .85) !important; }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .leaflet-control-attribution a { color: var(--green-deep); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .leaflet-control-zoom a { color: var(--ink) !important; background: rgba(40, 37, 31, .96) !important; border-color: var(--line-strong) !important; }
html[data-appearance-page="map"][data-map-ui-theme="dark"] :is(.map-brand, .quiet-button, .drawer-back) { background: rgba(40, 37, 31, .97); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .map-drawer { background: rgba(40, 37, 31, .97); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .drawer-scroll-fade { background: linear-gradient(to bottom, rgba(40, 37, 31, 0), rgba(40, 37, 31, .97)); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .map-status { background: rgba(58, 53, 45, .94); color: var(--ink); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .map-search { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23aaa197' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-4-4'/%3E%3C/svg%3E"); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] :is(.map-search:focus-visible, .timetable-stop-field select:focus-visible) { box-shadow: 0 0 0 3px rgba(125, 156, 139, .28); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] :is(.region-marker, .city-marker) { border-color: rgba(243, 235, 222, .3); background: rgba(40, 37, 31, .92); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .route-service-summary { background: rgba(48, 44, 38, .72); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .trip-nearby-candidate.selected { background: rgba(125, 156, 139, .16); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .favorite-direction-button.selected { background: rgba(223, 115, 87, .16); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] .timetable-minute.next { box-shadow: 0 0 0 2px rgba(223, 115, 87, .2); }
html[data-appearance-page="map"][data-map-ui-theme="dark"] :is(.direct-route-card.selected, .transfer-plan.selected) { box-shadow: 0 4px 14px rgba(0, 0, 0, .4); }

html[data-appearance-page="map"][data-map-tiles-theme="light"] #map { background: #d8d4ca; }
html[data-appearance-page="map"][data-map-tiles-theme="light"] .leaflet-tile-pane { filter: grayscale(.72) sepia(.12) saturate(.65) brightness(1.06) contrast(.9); }
html[data-appearance-page="map"][data-map-tiles-theme="light"] .nearby-map-marker { box-shadow: 0 0 0 5px rgba(244, 239, 228, .78), var(--shadow-marker); }
html[data-appearance-page="map"][data-map-tiles-theme="light"] .vehicle-marker { border-color: #29251f; background: #f4efe4; box-shadow: var(--shadow-marker), 0 0 0 1.5px #f4efe4; }
html[data-appearance-page="map"][data-map-tiles-theme="light"] .vehicle-marker::before { background: #4f685b; }
html[data-appearance-page="map"][data-map-tiles-theme="light"] .vehicle-marker::after { background: #b85f49; }

html[data-appearance-page="map"][data-map-tiles-theme="dark"] #map { background: #232120; }
html[data-appearance-page="map"][data-map-tiles-theme="dark"] .leaflet-tile-pane { filter: invert(1) grayscale(1) brightness(.8) contrast(.92); }
html[data-appearance-page="map"][data-map-tiles-theme="dark"] .nearby-map-marker { box-shadow: 0 0 0 5px rgba(29, 28, 25, .78), var(--shadow-marker); }
html[data-appearance-page="map"][data-map-tiles-theme="dark"] .vehicle-marker { border-color: #f3ebde; background: #28251f; box-shadow: var(--shadow-marker), 0 0 0 1.5px #28251f; }
html[data-appearance-page="map"][data-map-tiles-theme="dark"] .vehicle-marker::before { background: #81a08f; }
html[data-appearance-page="map"][data-map-tiles-theme="dark"] .vehicle-marker::after { background: #df7357; }
`
