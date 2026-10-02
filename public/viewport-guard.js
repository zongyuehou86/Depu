/* Keep the table at its layout size while preserving ordinary vertical scrolling. */
(() => {
  'use strict';
  const preventPinch = event => { if (event.cancelable) event.preventDefault(); };
  for (const kind of ['gesturestart', 'gesturechange']) {
    document.addEventListener(kind, preventPinch, { passive: false });
  }
  document.addEventListener('touchmove', event => {
    if (event.touches?.length > 1) preventPinch(event);
  }, { passive: false });
})();
