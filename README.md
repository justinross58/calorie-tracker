# Calorie Tracker

A lightweight calorie and weight tracker for Android, installed from Chrome as an app.
All data stays on the phone. Nothing is sent anywhere.

## Install on your phone
1. Open the GitHub Pages link in **Chrome** on Android.
2. Tap **⋮ → Install app** (or "Add to Home screen").
3. Open it from your home screen. It works offline.

## Backups
Settings → **Export to CSV** saves a file to Downloads. Do this now and then:
clearing Chrome's site data, or uninstalling the app, erases what's stored on the phone.
**Import from CSV** restores a backup (it replaces what's on the phone).

## Updating the app
Change the files, then bump `CACHE` in `sw.js` (and `VERSION` in `app.js`).
Phones pick up the new version the next time the app is opened with a connection.

## Files
- `index.html`, `style.css`, `app.js` — the app (no frameworks, no build step)
- `sw.js` — offline caching
- `manifest.webmanifest`, `*.png` — install name and icons
- `*.woff2`, `OFL-*.txt` — Outfit and Figtree (SIL Open Font License)
