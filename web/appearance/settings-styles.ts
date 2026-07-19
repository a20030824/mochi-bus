export const appearanceSettingsStyles = `
.appearance-list {
  display: grid;
  margin-top: 10px;
  border-block: 1px solid #ded6c9;
}
.appearance-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  min-height: 58px;
  padding: 10px 2px;
  border-bottom: 1px solid #ded6c9;
}
.appearance-row:last-child { border-bottom: 0; }
.appearance-label { color: inherit; font-size: 14px; }
.appearance-segmented {
  display: grid;
  grid-template-columns: repeat(2, minmax(54px, 1fr));
  gap: 2px;
  min-width: 132px;
  padding: 3px;
  border: 1px solid #d8d0c2;
  border-radius: 999px;
  background: #e9e1d5;
}
.appearance-segment { position: relative; }
.appearance-option-input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.appearance-segment span {
  display: grid;
  min-height: 30px;
  place-items: center;
  padding: 0 13px;
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 800;
  pointer-events: none;
  user-select: none;
  transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}
.appearance-segment:hover .appearance-option-input:not(:checked) + span {
  background: rgba(41, 37, 31, .06);
  color: #29251f;
}
.appearance-option-input:checked + span {
  background: #29251f;
  color: #fffaf0;
  box-shadow: 0 1px 4px rgba(41, 37, 31, .18);
}
.appearance-option-input:focus-visible + span {
  outline: 2px solid #4f685b;
  outline-offset: 2px;
}
.appearance-message { min-height: 18px; margin: 8px 0 0; }
@media (prefers-color-scheme: dark) {
  .appearance-list, .appearance-row { border-color: #4d473e; }
  .appearance-segmented { border-color: #4d473e; background: #302c26; }
  .appearance-segment:hover .appearance-option-input:not(:checked) + span { background: rgba(248, 240, 227, .08); color: #f8f0e3; }
  .appearance-option-input:checked + span { background: #f8f0e3; color: #211f1b; box-shadow: 0 1px 4px rgba(0, 0, 0, .34); }
  .appearance-option-input:focus-visible + span { outline-color: #81a08f; }
}
@media (prefers-reduced-motion: reduce) {
  .appearance-segment span { transition: none; }
}
`
