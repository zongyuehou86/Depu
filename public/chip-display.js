/* Display units only. All server commands and balances remain integer chips. */
(() => {
  'use strict';
  const key = 'poker-chip-unit';
  let unit = 'chips';
  try { if (localStorage.getItem(key) === 'bb') unit = 'bb'; } catch { /* Storage may be unavailable. */ }

  function getUnit() { return unit; }
  function setUnit(value) {
    unit = value === 'bb' ? 'bb' : 'chips';
    try { localStorage.setItem(key, unit); } catch { /* Keep this tab's preference. */ }
    return unit;
  }
  function getBlind(data) {
    const blind = Number(data?.bigBlind);
    return Number.isSafeInteger(blind) && blind > 0 ? blind : 20;
  }
  function format(value, data, displayUnit = unit) {
    const number = Number(value) || 0;
    if (displayUnit !== 'bb') return Math.round(number).toLocaleString('en-US');
    return `${(number / getBlind(data)).toLocaleString('en-US', { maximumFractionDigits: 6 })} BB`;
  }
  function inputValue(value, data, displayUnit = unit) {
    if (value === '' || value == null || !Number.isFinite(Number(value))) return '';
    return String(Number(value) / (displayUnit === 'bb' ? getBlind(data) : 1));
  }
  function toChips(value, data, displayUnit = unit) {
    if (value == null || String(value).trim() === '') return NaN;
    const chips = Number(value) * (displayUnit === 'bb' ? getBlind(data) : 1);
    const rounded = Math.round(chips);
    // Allow floating-point representation noise, never silently round a partial chip.
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(chips)) * 4;
    return Number.isSafeInteger(rounded) && Math.abs(chips - rounded) <= tolerance ? rounded : NaN;
  }
  function inputStep(data, displayUnit = unit) {
    return inputValue(1, data, displayUnit);
  }

  window.PokerChips = Object.freeze({ getUnit, setUnit, getBlind, format, inputValue, toChips, inputStep });
})();
