export const appearanceSettingsStyles = `
.appearance-list {
  display: grid;
  margin-top: 10px;
  border-block: 1px solid var(--line-soft);
}
.appearance-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  min-height: 68px;
  padding: 12px 2px;
  border-bottom: 1px solid var(--line-soft);
}
.appearance-row:last-child { border-bottom: 0; }
.appearance-label { color: inherit; font-size: 14px; }
.appearance-segmented {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 168px;
  height: 42px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--well);
  box-sizing: border-box;
  isolation: isolate;
}
.appearance-segmented::before {
  position: absolute;
  z-index: 0;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc(50% - 3px);
  border-radius: 999px;
  background: #29251f;
  box-shadow: 0 1px 3px rgba(41, 37, 31, .16);
  content: '';
  transform: translateX(0);
  transition: transform 150ms ease, background-color 150ms ease, box-shadow 150ms ease;
}
.appearance-segmented[data-selected="dark"]::before { transform: translateX(100%); }
.appearance-segment {
  position: relative;
  z-index: 1;
  display: grid;
  min-width: 0;
  cursor: pointer;
}
.appearance-option-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.appearance-segment span {
  display: grid;
  min-height: 34px;
  place-items: center;
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .02em;
  pointer-events: none;
  user-select: none;
  transition: color 150ms ease;
}
.appearance-segment:hover .appearance-option-input:not(:checked) + span { color: var(--ink); }
.appearance-option-input:checked + span { color: #fffaf0; }
.appearance-option-input:focus-visible + span {
  outline: 2px solid var(--green);
  outline-offset: -2px;
}
html[data-general-theme="dark"] .appearance-segmented::before { background: #4d473e; box-shadow: 0 1px 3px rgba(0, 0, 0, .35); }
@media (max-width: 360px) {
  .appearance-row { gap: 12px; }
  .appearance-segmented { width: 156px; }
}
@media (prefers-reduced-motion: reduce) {
  .appearance-segmented::before, .appearance-segment span { transition: none; }
}
`
