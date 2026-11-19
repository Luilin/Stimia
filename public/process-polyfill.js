/*
 * Polyfill minimo di `process` richiesto da alcune librerie browser.
 * È un file separato (e non uno script inline) per poter usare una
 * Content-Security-Policy senza `unsafe-inline` sugli script.
 */
window.process = {
  env: { NODE_ENV: 'production' },
  version: '',
  nextTick: function (callback) {
    setTimeout(callback, 0);
  },
};
