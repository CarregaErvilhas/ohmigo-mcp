// "Install app": puts the site on the home screen, where it opens full screen
// like an app (PWA). Same file on every site of the group; each page brings the
// markup, already in its language, and this script only decides what to show:
//   [data-install-open]  buttons that start it (footer, banner); the page's CSS
//                        shows them once <html data-install="ready">
//   #install-bar         banner shown on phones, data-install-key = storage key
//   #install-dialog      the steps, one [data-install-hint] block per browser
// Clicks are caught on the document, so a button the page draws later (the
// CEME assistant redraws each screen) works too.
//
// Chromium browsers (Chrome, Edge, Samsung Internet, Brave, Opera) fire
// beforeinstallprompt once the manifest is installable and the visitor has used
// the page for a while; from then on the button opens the browser's own install
// dialog. Before that, and on Safari, every iOS browser and Firefox, which have
// no such event, it opens the steps for the browser in use. In-app browsers
// (Facebook, Instagram, Messenger...) can't install at all: their steps say to
// open the page in the real browser first.
(function (root) {
  'use strict';

  // Which block of steps fits this browser. Pure, so the tests can feed it
  // user agents.
  function installHint(ua, touchPoints, brave) {
    ua = ua || '';
    if (/FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|LinkedInApp|MicroMessenger|TikTok|musical_ly|Snapchat|Pinterest|Line\/|GSA\//.test(ua)) return 'in-app';
    // iPadOS says it is a Mac; only the touch screen gives it away.
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) {
      return brave || /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|Ddg\//.test(ua) ? 'ios-other' : 'ios-safari';
    }
    if (/Android/.test(ua)) {
      if (/; wv\)/.test(ua)) return 'in-app'; // another app's WebView
      if (/SamsungBrowser/.test(ua)) return 'samsung';
      if (/Firefox/.test(ua)) return 'android-firefox';
      return 'android';
    }
    return /Mobi/.test(ua) ? 'android' : 'desktop';
  }

  if (typeof document === 'undefined') { root.installHint = installHint; return; }

  // Already opened from the home screen: nothing to offer.
  if (matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches || navigator.standalone === true) return;

  var hint = installHint(navigator.userAgent, navigator.maxTouchPoints || 0, !!navigator.brave);
  var SNOOZE = 30 * 864e5; // "Not now" keeps the banner away for 30 days
  var deferred = null;
  var each = function (sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); };

  function bar() { return document.getElementById('install-bar'); }
  function key() { var b = bar(); return b && b.getAttribute('data-install-key'); }
  // localStorage can throw (private mode, blocked site data): then the banner
  // simply shows again next time.
  function snoozed() { try { return Date.now() - Number(localStorage.getItem(key()) || 0) < SNOOZE; } catch (e) { return false; } }
  function snooze() { try { if (key()) localStorage.setItem(key(), String(Date.now())); } catch (e) {} }
  function hideBar() { var b = bar(); if (b) b.hidden = true; }

  function installed() {
    deferred = null;
    snooze();
    document.documentElement.setAttribute('data-install', 'done');
    hideBar();
  }

  function showSteps() {
    var d = document.getElementById('install-dialog');
    if (!d) return;
    each('#install-dialog [data-install-hint]', function (b) {
      b.hidden = b.getAttribute('data-install-hint').split(' ').indexOf(hint) < 0;
    });
    each('#install-dialog [data-install-url]', function (u) { u.textContent = location.href; });
    if (!d.open) d.showModal();
  }

  function open() {
    snooze();
    hideBar();
    // The Web Install API, where it exists, is the browser's own dialog. It
    // must run inside the click, so nothing is awaited before it.
    if (typeof navigator.install === 'function') {
      navigator.install().then(installed, function (e) { if (!e || e.name !== 'AbortError') showSteps(); });
      return;
    }
    if (deferred) {
      // Single use: drop it before waiting for the answer.
      var e = deferred;
      deferred = null;
      e.prompt();
      e.userChoice.then(function (c) { if (c && c.outcome === 'accepted') installed(); }, function () {});
      return;
    }
    showSteps();
  }

  addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); // our banner replaces Chrome's mini-infobar
    deferred = e;
  });
  addEventListener('appinstalled', installed);

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-install-open], [data-install-dismiss], [data-install-close], [data-install-copy]');
    if (!b) return;
    if (b.hasAttribute('data-install-open')) open();
    else if (b.hasAttribute('data-install-dismiss')) { snooze(); hideBar(); }
    else if (b.hasAttribute('data-install-close')) { var d = document.getElementById('install-dialog'); if (d) d.close(); }
    else if (navigator.clipboard) {
      navigator.clipboard.writeText(location.href).then(function () {
        b.textContent = b.getAttribute('data-copied') || b.textContent;
      }, function () {});
    }
  });

  function init() {
    document.documentElement.setAttribute('data-install', 'ready');
    // Tapping outside closes the dialog: closedby="any" does it where it is
    // supported, this click does it in Safari.
    var d = document.getElementById('install-dialog');
    if (d && !('closedBy' in HTMLDialogElement.prototype)) {
      d.addEventListener('click', function (ev) {
        if (ev.target !== d) return;
        var r = d.getBoundingClientRect();
        if (ev.clientY < r.top || ev.clientY > r.bottom || ev.clientX < r.left || ev.clientX > r.right) d.close();
      });
    }
    // The banner only on phones and tablets: on a computer Chrome and Edge show
    // their own install icon, and the footer button is enough.
    var b = bar();
    if (b && hint !== 'desktop' && !snoozed()) b.hidden = false;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(this);
