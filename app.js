'use strict';

const VERSION = '1.3.0';
const AI_MODEL = 'claude-haiku-5-5';
const KG_PER_LB = 0.45359237;
const RING_C = 2 * Math.PI * 110; // ring circumference in the 260x260 viewBox

/* ---------------------------------------------------------------- storage */

const db = {
  _db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('calorie-tracker', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('weights')) d.createObjectStore('weights', { keyPath: 'day' });
        if (!d.objectStoreNames.contains('goals')) d.createObjectStore('goals', { keyPath: 'from' });
      };
      req.onsuccess = () => { this._db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this._db.transaction(store, mode);
      let out;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()); },
  put(store, value) { return this.tx(store, 'readwrite', s => s.put(value)); },
  del(store, key) { return this.tx(store, 'readwrite', s => s.delete(key)); },
  replaceAll(data) {
    return new Promise((resolve, reject) => {
      const names = ['entries', 'weights', 'goals'];
      const t = this._db.transaction(names, 'readwrite');
      for (const n of names) {
        const s = t.objectStore(n);
        s.clear();
        for (const v of data[n]) s.put(v);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
};

function readSettings() {
  try { return JSON.parse(localStorage.getItem('ct.settings')) || {}; } catch { return {}; }
}
const settings = Object.assign({ units: 'lb', dayStart: 0, lastExport: null, snoozeUntil: null, apiKey: '', addMode: 'keypad' }, readSettings());
function saveSettings() {
  try { localStorage.setItem('ct.settings', JSON.stringify(settings)); } catch { /* storage blocked */ }
}

let persistAsked = false;
function requestPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ state */

const S = {
  entries: [],            // { id, day, ts, kcal, label, timed? }
  weights: new Map(),     // day -> { day, lb }
  goals: [],              // { from, kcal, target } sorted by from
  day: null,
  lastToday: null,
  view: 'day',
  editing: null,
  tab: 'cal',
  calRange: 14,
  wtRange: 30
};

async function loadAll() {
  const [entries, weights, goals] = await Promise.all([db.all('entries'), db.all('weights'), db.all('goals')]);
  S.entries = entries;
  S.weights = new Map(weights.map(w => [w.day, w]));
  S.goals = goals.sort((a, b) => (a.from < b.from ? -1 : 1));
}

/* ------------------------------------------------------------------ dates */

const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (k, n) => { const d = dateOf(k); d.setDate(d.getDate() + n); return keyOf(d); };
const todayKey = () => keyOf(new Date(Date.now() - settings.dayStart * 3600e3));
const daysBetween = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 864e5);
const fmtDay = k => dateOf(k).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const fmtShort = k => dateOf(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmt = n => Math.round(n).toLocaleString('en-US');

/* --------------------------------------------------------- domain helpers */

function goalFor(day) {
  let g = null;
  for (const x of S.goals) { if (x.from <= day) g = x; else break; }
  return g || S.goals[0] || { from: day, kcal: 2000, target: null };
}
const currentGoal = () => goalFor(todayKey());

async function setGoal(patch) {
  const t = todayKey();
  const g = { ...currentGoal(), ...patch, from: t };
  await db.put('goals', g);
  const i = S.goals.findIndex(x => x.from === t);
  if (i >= 0) S.goals[i] = g; else { S.goals.push(g); S.goals.sort((a, b) => (a.from < b.from ? -1 : 1)); }
}

const entriesOn = d => S.entries.filter(e => e.day === d).sort((a, b) => a.ts - b.ts || a.id - b.id);
const eatenOn = d => S.entries.reduce((s, e) => (e.day === d ? s + e.kcal : s), 0);

const toUnit = lb => (settings.units === 'kg' ? lb * KG_PER_LB : lb);
const fromUnit = v => (settings.units === 'kg' ? v / KG_PER_LB : v);
const fmtW = lb => toUnit(lb).toFixed(1);
const parseNum = s => parseFloat(String(s).trim().replace(',', '.').replace('−', '-'));

async function addEntries(day, items) {
  const isToday = day === todayKey();
  const ts = isToday ? Date.now() : dateOf(day).getTime();
  const added = [];
  for (const it of items) {
    const e = { day, ts, kcal: it.kcal, label: it.label || '' };
    if (!isToday) e.timed = false;
    e.id = await db.put('entries', e);
    S.entries.push(e);
    added.push(e);
  }
  requestPersist();
  render();
  const total = added.reduce((s, e) => s + e.kcal, 0);
  const what = `${total < 0 ? '−' : ''}${fmt(Math.abs(total))}${added.length > 1 ? ` (${added.length} items)` : ''}`;
  toast(`Added ${what}${isToday ? '' : ' to ' + fmtShort(day)}`, async () => {
    for (const e of added) await removeEntry(e.id, true);
  });
}

const addEntry = (day, kcal, label) => addEntries(day, [{ kcal, label }]);

async function removeEntry(id, silent) {
  const i = S.entries.findIndex(e => e.id === id);
  if (i < 0) return;
  const [e] = S.entries.splice(i, 1);
  await db.del('entries', id);
  S.editing = null;
  render();
  if (!silent) {
    toast(`Deleted ${fmt(Math.abs(e.kcal))}`, async () => { await db.put('entries', e); S.entries.push(e); render(); });
  }
}

async function updateEntry(id, kcal, label) {
  const e = S.entries.find(x => x.id === id);
  if (!e) return;
  e.kcal = kcal;
  e.label = label;
  await db.put('entries', e);
  S.editing = null;
  render();
}

function quickValues() {
  const since = addDays(todayKey(), -60);
  const counts = new Map();
  for (const e of S.entries) {
    if (e.kcal <= 0 || e.day < since) continue;
    const c = counts.get(e.kcal) || { n: 0, ts: 0 };
    c.n++; c.ts = Math.max(c.ts, e.ts);
    counts.set(e.kcal, c);
  }
  const vals = [...counts.entries()]
    .filter(([, c]) => c.n >= 2)
    .sort((a, b) => b[1].n - a[1].n || b[1].ts - a[1].ts)
    .slice(0, 4)
    .map(([k]) => k);
  for (const d of [100, 250, 400, 600]) { if (vals.length >= 4) break; if (!vals.includes(d)) vals.push(d); }
  return vals.sort((a, b) => a - b);
}

function needsBackup() {
  if (!S.entries.length) return false;
  const now = Date.now();
  if (settings.snoozeUntil && now < settings.snoozeUntil) return false;
  const first = S.entries.reduce((m, e) => Math.min(m, e.ts), Infinity);
  return now - (settings.lastExport || first) > 30 * 864e5;
}

/* --------------------------------------------------------------------- UI */

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

function render() {
  if (S.view === 'day') renderDay();
  else if (S.view === 'trends') renderTrends();
  else renderSettings();
}

function showView(v) {
  S.view = v;
  for (const n of ['day', 'trends', 'settings']) $('view-' + n).hidden = n !== v;
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'));
  render();
  $('view-' + v).scrollTop = 0;
}

function goToDay(day) {
  const t = todayKey();
  S.day = day > t ? t : day;
  S.editing = null;
  if (S.view !== 'day') showView('day'); else renderDay();
}

/* Day view */

function renderDay() {
  const d = S.day, t = todayKey(), isToday = d === t;
  const ago = daysBetween(d, t);
  $('day-name').textContent = isToday ? 'Today' : fmtDay(d);
  $('day-sub').textContent = isToday ? fmtDay(d) : ago === 1 ? 'Yesterday' : `${ago} days ago`;
  $('next-day').disabled = d >= t;
  $('back-today').hidden = isToday;
  $('nav-day-label').textContent = isToday ? 'Today' : 'Day';

  const goal = goalFor(d).kcal, eaten = eatenOn(d), left = goal - eaten, over = left < 0;
  $('ring').classList.toggle('over', over);
  $('ring-num').textContent = fmt(Math.abs(left));
  $('ring-label').textContent = over ? 'over goal' : 'calories left';
  const frac = over ? 1 : Math.max(0, eaten) / goal;
  const fg = $('ring-fg');
  fg.setAttribute('stroke-dasharray', `${(frac * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`);
  fg.style.opacity = eaten > 0 ? 1 : 0;
  $('eaten').textContent = fmt(eaten);
  $('goal').textContent = fmt(goal);
  const maint = goalFor(d).maint, net = $('net');
  net.hidden = !maint;
  if (maint) {
    const diff = maint - eaten;
    net.className = diff < 0 ? 'net over' : 'net';
    net.innerHTML = `<strong>${fmt(Math.abs(diff))}</strong> ${diff < 0 ? 'over' : 'under'} break-even of ${fmt(maint)}`;
  }

  $('backup-banner').hidden = !needsBackup();

  $('quick').innerHTML = quickValues().map(v => `<button data-kcal="${v}" aria-label="Add ${v} calories">+${fmt(v)}</button>`).join('');
  $('add-label').textContent = isToday ? 'Add calories' : `Add to ${fmtShort(d)}`;

  const w = S.weights.get(d);
  $('weight-chip').innerHTML = w ? `${fmtW(w.lb)} ${settings.units}` : `${PLUS}Log weight`;
  $('weight-chip').setAttribute('aria-label', w ? `Weight ${fmtW(w.lb)} ${settings.units}, tap to edit` : 'Log weight');

  const list = entriesOn(d);
  $('entries-title').textContent = list.length ? (isToday ? "Today's entries · tap to edit" : 'Entries · tap to edit') : (isToday ? "Today's entries" : 'Entries');
  $('entries').innerHTML = list.length
    ? list.map(e => (S.editing === e.id ? editRow(e) : entryRow(e))).join('')
    : `<li class="empty">No entries yet. Tap Add or a quick amount.</li>`;
  if (S.editing != null) {
    const k = $('edit-kcal');
    if (k) { k.focus(); k.select(); }
  }
}

function entryRow(e) {
  const time = e.timed === false ? '' : new Date(e.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const neg = e.kcal < 0;
  return `<li><button class="entry" data-id="${e.id}"><span class="t">${time}</span>` +
    `<span class="l${e.label ? '' : ' none'}">${e.label ? esc(e.label) : '—'}</span>` +
    `<span class="k${neg ? ' neg' : ''}">${neg ? '−' : ''}${fmt(Math.abs(e.kcal))}</span></button></li>`;
}

function editRow(e) {
  return `<li class="edit" data-edit="${e.id}"><div class="edit-fields">` +
    `<input class="field" id="edit-label" value="${esc(e.label)}" placeholder="Label" maxlength="40" aria-label="Label" autocomplete="off">` +
    `<input class="field num" id="edit-kcal" value="${e.kcal}" inputmode="numeric" aria-label="Calories" autocomplete="off" enterkeyhint="done"></div>` +
    `<div class="edit-btns"><button class="text-btn danger" data-act="del">Delete</button>` +
    `<button class="text-btn" data-act="cancel">Cancel</button><button class="small-btn" data-act="save">Save</button></div></li>`;
}

function saveEdit() {
  const li = document.querySelector('[data-edit]');
  if (!li) return;
  const id = Number(li.dataset.edit);
  const kcal = Math.round(parseNum($('edit-kcal').value));
  if (!Number.isFinite(kcal) || kcal === 0 || Math.abs(kcal) > 20000) { toast('Enter calories between 1 and 20,000'); return; }
  updateEntry(id, kcal, $('edit-label').value.trim());
}

/* Sheets */

let openSheetEl = null;
function showSheet(el, pushHistory = true) {
  if (openSheetEl) hideSheet();
  openSheetEl = el;
  $('toast').classList.remove('show');
  el.classList.add('show');
  $('scrim').classList.add('show');
  if (pushHistory) history.pushState({ sheet: true }, '');
}
function hideSheet() {
  if (!openSheetEl) return;
  openSheetEl.classList.remove('show');
  $('scrim').classList.remove('show');
  openSheetEl = null;
  if (document.activeElement) document.activeElement.blur();
}
function closeSheet() {
  if (!openSheetEl) return;
  hideSheet();
  if (history.state && history.state.sheet) history.back();
}

/* Add sheet */

const add = { buf: '', neg: false };
const addValue = () => { const v = parseInt(add.buf || '0', 10); return add.neg ? -v : v; };

function openAdd() {
  add.buf = ''; add.neg = false;
  $('add-label-input').value = '';
  $('add-when').textContent = S.day === todayKey() ? 'Today · now' : fmtDay(S.day);
  renderAdd();
  resetAI();
  setAddMode(settings.addMode, false);
  showSheet($('add-sheet'));
}

function setAddMode(mode, remember = true) {
  if (remember && settings.addMode !== mode) { settings.addMode = mode; saveSettings(); }
  paintSeg($('add-mode'), 'mode', mode);
  $('mode-keypad').hidden = mode !== 'keypad';
  $('mode-describe').hidden = mode !== 'describe';
  if (mode === 'describe') {
    const hasKey = !!settings.apiKey;
    $('ai-nokey').hidden = hasKey;
    $('ai-form').hidden = !hasKey;
    if (hasKey && !ai.items.length) setTimeout(() => $('ai-text').focus(), 250);
  }
}

/* AI estimate (Claude) */

const ai = { items: [], busy: false };

function resetAI() {
  ai.items = [];
  ai.busy = false;
  $('ai-text').value = '';
  $('ai-results').hidden = true;
  setAIStatus('');
  $('ai-go').disabled = false;
  $('ai-go').textContent = 'Estimate calories';
}

function setAIStatus(msg, isErr) {
  const el = $('ai-status');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}

const AI_SYSTEM = `You estimate calories for food a person says they ate, for a personal calorie log.
Split the description into separate foods or drinks. Use the quantities and serving sizes given. When a size is missing, assume one typical US serving and say what you assumed in the portion.
Count added fats, sauces, dressings, milk and sugar in drinks when they are mentioned. Use typical home or restaurant preparation unless told otherwise.
Give realistic, typical values rounded to the nearest 5 kcal. name: the food, at most 24 characters. portion: the amount, at most 22 characters.
If the text is not about food or drink, return no items and explain briefly in note. Always answer by calling record_foods.`;

const AI_TOOL = {
  name: 'record_foods',
  description: 'Record the estimated calories for each food or drink eaten.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Food or drink, e.g. "Scrambled eggs"' },
            portion: { type: 'string', description: 'Amount, e.g. "2 large"' },
            kcal: { type: 'integer', description: 'Estimated calories for this portion' }
          },
          required: ['name', 'portion', 'kcal']
        }
      },
      note: { type: 'string', description: 'Optional short note, e.g. why nothing was found' }
    },
    required: ['items']
  }
};

async function callClaude(body, signal) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Claude took too long to answer. Try again.');
    throw new Error(navigator.onLine === false ? 'You’re offline. Use the keypad, or try again when you have a connection.' : 'Couldn’t reach Claude. Check your connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const type = data && data.error && data.error.type;
    const msg = (data && data.error && data.error.message) || '';
    if (res.status === 401 || type === 'authentication_error') throw new Error('Your API key wasn’t accepted. Check it in Settings.');
    if (res.status === 403 || type === 'permission_error') throw new Error('Your API key doesn’t have permission to use this model.');
    if (/credit balance|billing/i.test(msg)) throw new Error('Your Anthropic account is out of credit. Add credit at console.anthropic.com.');
    if (res.status === 429 || type === 'rate_limit_error') throw new Error('Too many requests just now. Wait a moment and try again.');
    if (res.status === 529 || res.status >= 500 || type === 'overloaded_error') throw new Error('Claude is busy right now. Try again in a moment.');
    if (type === 'not_found_error') throw new Error('The AI model isn’t available to your key.');
    throw new Error(msg ? `Claude returned an error: ${msg}` : `Claude returned an error (${res.status}).`);
  }
  return data;
}

async function estimate() {
  const text = $('ai-text').value.trim();
  if (!text || ai.busy) { if (!text) $('ai-text').focus(); return; }
  if (!settings.apiKey) { setAddMode('describe'); return; }
  ai.busy = true;
  $('ai-go').disabled = true;
  $('ai-go').textContent = 'Estimating…';
  setAIStatus('');
  $('ai-text').blur();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const data = await callClaude({
      model: AI_MODEL,
      max_tokens: 1024,
      system: AI_SYSTEM,
      tools: [AI_TOOL],
      tool_choice: { type: 'tool', name: 'record_foods' },
      messages: [{ role: 'user', content: text }]
    }, ctl.signal);
    const use = (data.content || []).find(c => c.type === 'tool_use');
    const out = (use && use.input) || {};
    const items = (Array.isArray(out.items) ? out.items : [])
      .map(it => ({
        label: [String(it.name || 'Food').trim(), String(it.portion || '').trim()].filter(Boolean).join(', ').slice(0, 40),
        kcal: Math.max(0, Math.round(Number(it.kcal) || 0))
      }))
      .filter(it => it.label);
    if (!items.length) {
      setAIStatus(out.note || 'Claude couldn’t find any food in that. Try describing what you ate and how much.', true);
      $('ai-results').hidden = true;
      ai.items = [];
    } else {
      ai.items = items;
      renderAIItems();
      $('ai-results').hidden = false;
      setAIStatus(out.note || '');
      $('ai-add').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } catch (err) {
    setAIStatus(err.message, true);
  } finally {
    clearTimeout(timer);
    ai.busy = false;
    $('ai-go').disabled = false;
    $('ai-go').textContent = ai.items.length ? 'Estimate again' : 'Estimate calories';
  }
}

const X_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function renderAIItems() {
  $('ai-items').innerHTML = ai.items.map((it, i) =>
    `<li data-i="${i}"><input class="field name" value="${esc(it.label)}" maxlength="40" aria-label="Food" autocomplete="off">` +
    `<input class="field kc" value="${it.kcal}" inputmode="numeric" aria-label="Calories" autocomplete="off">` +
    `<button class="icon-btn" data-rm="${i}" aria-label="Remove ${esc(it.label)}">${X_ICON}</button></li>`).join('');
  renderAITotal();
}

function renderAITotal() {
  const total = ai.items.reduce((s, it) => s + it.kcal, 0);
  $('ai-total').textContent = fmt(total);
  const left = goalFor(S.day).kcal - eatenOn(S.day) - total;
  const when = S.day === todayKey() ? 'today' : fmtShort(S.day);
  const a = $('ai-after');
  if (left >= 0) { a.className = 'after'; a.innerHTML = `Leaves <strong>${fmt(left)}</strong> for ${when}`; }
  else { a.className = 'after over'; a.innerHTML = `Puts you <strong>${fmt(-left)}</strong> over for ${when}`; }
  const n = ai.items.filter(it => it.kcal > 0).length;
  $('ai-add').disabled = n === 0;
  $('ai-add').textContent = n === 0 ? 'Add' : n === 1 ? `Add ${fmt(total)}` : `Add ${n} items · ${fmt(total)}`;
}

function confirmAI() {
  const items = ai.items
    .map(it => ({ label: it.label.trim(), kcal: Math.min(20000, it.kcal) }))
    .filter(it => it.kcal > 0);
  if (!items.length) return;
  closeSheet();
  addEntries(S.day, items);
}

async function testKey() {
  const r = $('key-test-result');
  r.textContent = 'Testing…';
  try {
    await callClaude({ model: AI_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] });
    r.textContent = 'Working';
    toast('Your key works');
  } catch (err) {
    r.textContent = 'Failed';
    toast(err.message);
  }
}

function renderAdd() {
  const v = addValue();
  $('amount').textContent = (add.neg ? '−' : '') + fmt(Math.abs(v));
  const left = goalFor(S.day).kcal - eatenOn(S.day) - v;
  const when = S.day === todayKey() ? 'today' : fmtShort(S.day);
  const a = $('after');
  if (v === 0) { a.className = 'after'; a.textContent = ''; }
  else if (left >= 0) { a.className = 'after'; a.innerHTML = `Leaves <strong>${fmt(left)}</strong> for ${when}`; }
  else { a.className = 'after over'; a.innerHTML = `Puts you <strong>${fmt(-left)}</strong> over for ${when}`; }
  const b = $('add-confirm');
  b.disabled = v === 0;
  b.textContent = v === 0 ? 'Add' : `Add ${add.neg ? '−' : ''}${fmt(Math.abs(v))}`;
  document.querySelector('[data-k="neg"]').setAttribute('aria-pressed', String(add.neg));
}

function pressKey(k) {
  if (k === 'del') add.buf = add.buf.slice(0, -1);
  else if (k === 'neg') add.neg = !add.neg;
  else if (/^\d$/.test(k) && add.buf.length < 5) add.buf = (add.buf + k).replace(/^0+/, '');
  renderAdd();
}

function confirmAdd() {
  const v = addValue();
  if (!v) return;
  const label = $('add-label-input').value.trim();
  closeSheet();
  addEntry(S.day, v, label);
}

/* Weight sheet */

function openWeight() {
  const w = S.weights.get(S.day);
  $('wt-unit').textContent = settings.units;
  $('wt-input').value = w ? fmtW(w.lb) : '';
  $('wt-remove').hidden = !w;
  $('wt-error').hidden = true;
  $('wt-when').textContent = S.day === todayKey() ? 'Today' : fmtDay(S.day);
  showSheet($('weight-sheet'));
  setTimeout(() => $('wt-input').focus(), 250);
}

function weightError(el, msg) { el.textContent = msg; el.hidden = false; el.style.color = 'var(--warn)'; }
const weightRangeMsg = () => (settings.units === 'kg' ? 'Enter a weight between 23 and 317 kg' : 'Enter a weight between 50 and 700 lb');

async function saveWeight() {
  const v = parseNum($('wt-input').value);
  const lb = fromUnit(v);
  if (!(lb >= 50 && lb <= 700)) { weightError($('wt-error'), weightRangeMsg()); return; }
  const w = { day: S.day, lb: Math.round(lb * 100) / 100 };
  await db.put('weights', w);
  S.weights.set(w.day, w);
  requestPersist();
  closeSheet();
  render();
  toast('Weight saved');
}

async function removeWeight() {
  await db.del('weights', S.day);
  S.weights.delete(S.day);
  closeSheet();
  render();
}

/* First-run setup */

let setupUnits = 'lb';
function openSetup() {
  setupUnits = settings.units;
  paintSeg($('setup-units'), 'unit', setupUnits);
  showSheet($('setup-sheet'), false);
}

async function finishSetup() {
  const err = $('setup-error');
  const kcal = Math.round(parseNum($('setup-goal').value));
  if (!(kcal >= 500 && kcal <= 10000)) { weightError(err, 'Enter a daily goal between 500 and 10,000'); return; }
  settings.units = setupUnits;
  let target = null;
  const tv = $('setup-target').value.trim();
  if (tv) {
    target = fromUnit(parseNum(tv));
    if (!(target >= 50 && target <= 700)) { weightError(err, weightRangeMsg().replace('a weight', 'a target')); return; }
    target = Math.round(target * 100) / 100;
  }
  saveSettings();
  // The first goal covers every earlier day too, so backfilled days have a goal
  // and a later change (even the same day) only applies from that day on.
  const g = { from: '0000-01-01', kcal, target };
  await db.put('goals', g);
  S.goals = [g];
  hideSheet();
  render();
}

function paintSeg(container, attr, value) {
  container.querySelectorAll(`[data-${attr}]`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)));
}

/* Trends */

const CW = 342, CH = 160;

function renderTrends() {
  paintSeg(document.querySelector('#view-trends .seg'), 'tab', S.tab);
  $('trend-body').innerHTML = S.tab === 'cal' ? caloriesCard() + weightSummary() : weightCard();
}

function ranges(name, opts, current) {
  return `<div class="ranges" role="group" aria-label="Range">` +
    opts.map(([v, l]) => `<button data-${name}="${v}" aria-pressed="${v === current}">${l}</button>`).join('') + `</div>`;
}

function caloriesCard() {
  const n = S.calRange, t = todayKey();
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(addDays(t, -i));
  const sums = new Map();
  for (const e of S.entries) sums.set(e.day, (sums.get(e.day) || 0) + e.kcal);
  const vals = days.map(d => { const g = goalFor(d); return { d, v: Math.max(0, sums.get(d) || 0), g: g.kcal, m: g.maint || null }; });
  const past = vals.filter(x => x.d !== t && x.v > 0);
  const avg = past.length ? past.reduce((s, x) => s + x.v, 0) / past.length : null;
  const onGoal = past.filter(x => x.v <= x.g).length;
  const overDays = vals.filter(x => x.d !== t && x.v > x.g).length;

  // Average daily balance against break-even, over finished days that have one set
  const withM = past.filter(x => x.m);
  const netAvg = withM.length ? withM.reduce((s, x) => s + (x.v - x.m), 0) / withM.length : null;
  let netStat = '', pace = '';
  if (netAvg != null) {
    const sign = netAvg < -0.5 ? '−' : netAvg > 0.5 ? '+' : '';
    netStat = `<div class="stat"><b class="${netAvg <= 0 ? 'good' : 'warnc'}">${sign}${fmt(Math.abs(netAvg))}</b><span>per day vs break-even</span></div>`;
    const perWeek = Math.abs(netAvg) * 7 / (settings.units === 'kg' ? 7700 : 3500);
    pace = Math.abs(netAvg) < 50
      ? `<p class="pace">At that pace your weight should hold about steady.</p>`
      : `<p class="pace">At that pace: about <strong>${perWeek.toFixed(1)} ${settings.units}</strong> ${netAvg < 0 ? 'lost' : 'gained'} per week.</p>`;
  }
  const hasM = vals.some(x => x.m);
  const view = settings.calView === 'cum' ? 'cum' : 'daily';
  const head = `<div class="tcard-head"><span>Last ${n} days</span>${ranges('cal', [[14, '14d'], [30, '30d'], [90, '90d']], n)}</div>
    <div class="seg mini" role="group" aria-label="Chart view"><button data-cview="daily" aria-pressed="${view === 'daily'}">Daily</button><button data-cview="cum" aria-pressed="${view === 'cum'}">Cumulative</button></div>`;
  if (view === 'cum') return cumulativeCard(n, days, vals, t, head);

  const top = Math.ceil(Math.max(...vals.map(x => Math.max(x.v, x.g, x.m || 0))) * 1.08 / 500) * 500;
  const y = v => CH - (v / top) * CH;
  const step = CW / n, bw = Math.max(2, step * 0.64), r = Math.min(4, bw / 2);
  let bars = '', hits = '', goalPath = '', maintPath = '', pen = false;
  vals.forEach((x, i) => {
    const bx = i * step + (step - bw) / 2;
    if (x.v > 0) {
      const cls = x.d === t ? 'bar today' : x.v > x.g ? 'bar over' : 'bar';
      bars += `<rect class="${cls}" x="${bx.toFixed(1)}" y="${y(x.v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(CH - y(x.v)).toFixed(1)}" rx="${r}"/>`;
    }
    hits += `<rect class="hit" data-day="${x.d}" x="${(i * step).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${CH + 24}"><title>${fmtShort(x.d)}: ${fmt(x.v)} of ${fmt(x.g)}</title></rect>`;
    goalPath += `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${y(x.g).toFixed(1)}L${((i + 1) * step).toFixed(1)} ${y(x.g).toFixed(1)}`;
    if (x.m) { maintPath += `${pen ? 'L' : 'M'}${(i * step).toFixed(1)} ${y(x.m).toFixed(1)}L${((i + 1) * step).toFixed(1)} ${y(x.m).toFixed(1)}`; pen = true; }
    else pen = false;
  });
  const mid = days[Math.floor(n / 2)];
  const midX = (Math.floor(n / 2) + 0.5) * step;
  const svg = `<svg class="chart" viewBox="0 -24 ${CW} ${CH + 50}" role="img" aria-label="Daily calories versus goal, last ${n} days; ${overDays} days over goal">
    <line class="axis" x1="0" y1="${CH}" x2="${CW}" y2="${CH}"/>
    ${bars}
    <path class="goal" d="${goalPath}"/>
    ${hasM ? `<path class="maint" d="${maintPath}"/>` : ''}
    <text x="0" y="-10">Goal ${fmt(currentGoal().kcal)}${currentGoal().maint ? ` · Break-even ${fmt(currentGoal().maint)}` : ''}</text>
    <text x="0" y="${CH + 20}">${fmtShort(days[0])}</text>
    <text x="${midX.toFixed(1)}" y="${CH + 20}" text-anchor="middle">${fmtShort(mid)}</text>
    <text x="${CW}" y="${CH + 20}" text-anchor="end">Today</text>
    ${hits}
  </svg>`;

  return `<section class="tcard">
    ${head}
    <div class="stats">
      <div class="stat"><b>${avg == null ? '—' : fmt(avg)}</b><span>avg per logged day</span></div>
      <div class="stat"><b>${past.length ? `${onGoal} <small>of ${past.length}</small>` : '—'}</b><span>days at or under goal</span></div>
      ${netStat}
    </div>
    ${pace}
    ${svg}
    <div class="legend"><span><i class="a"></i>At or under</span><span><i class="o"></i>Over goal</span><span><i class="t"></i>Today so far</span><span><i class="gline"></i>Goal</span>${hasM ? '<span><i class="mline"></i>Break-even</span>' : ''}</div>
    <p class="hint" style="margin-top:8px">Tap a day to open it.</p>
  </section>`;
}

// Running balance over the period: how far over (+) or under (−) goal and break-even,
// adding up finished days that have something logged. Today and blank days don't count.
function cumulativeCard(n, days, vals, t, head) {
  const signed = v => (v < -0.5 ? '−' : v > 0.5 ? '+' : '') + fmt(Math.abs(v));
  let eaten = 0, logged = 0, bg = 0, bm = 0, mDays = 0;
  const pts = [{ g: 0, m: 0 }];
  for (const x of vals) {
    if (x.d !== t && x.v > 0) {
      eaten += x.v; logged++; bg += x.v - x.g;
      if (x.m) { bm += x.v - x.m; mDays++; }
    }
    pts.push({ g: bg, m: bm });
  }
  if (!logged) {
    return `<section class="tcard">${head}<p class="note">Log a few days to see your running total.</p></section>`;
  }
  const showM = mDays > 0;

  const all = pts.flatMap(p => (showM ? [p.g, p.m] : [p.g]));
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const pad = Math.max(150, (hi - lo) * 0.12);
  lo -= lo < 0 ? pad : 0; hi += hi > 0 ? pad : 0;
  if (hi - lo < 400) { hi += 200; lo -= 200; }
  const Y = v => CH - ((v - lo) / (hi - lo)) * CH;
  const step = CW / n;
  const line = key => pts.map((p, k) => `${k ? 'L' : 'M'}${(k * step).toFixed(1)} ${Y(p[key]).toFixed(1)}`).join('');
  const zeroY = Y(0);
  const area = `${line('g')}L${CW} ${zeroY.toFixed(1)}L0 ${zeroY.toFixed(1)}Z`;
  // Shade under the zero line green and over it orange, even when the line crosses zero
  const z = zeroY.toFixed(1);
  const shade = `<defs><clipPath id="cum-over"><rect x="0" y="-24" width="${CW}" height="${(zeroY + 24).toFixed(1)}"/></clipPath>` +
    `<clipPath id="cum-under"><rect x="0" y="${z}" width="${CW}" height="${(CH - zeroY + 26).toFixed(1)}"/></clipPath></defs>` +
    `<path class="cum-area over" clip-path="url(#cum-over)" d="${area}"/><path class="cum-area" clip-path="url(#cum-under)" d="${area}"/>`;

  let hits = '';
  vals.forEach((x, i) => {
    const p = pts[i + 1];
    const tip = x.d === t ? 'today (not counted yet)' : x.v > 0 ? `running ${signed(p.g)} vs goal` + (showM ? `, ${signed(p.m)} vs break-even` : '') : 'nothing logged';
    hits += `<rect class="hit" data-day="${x.d}" x="${(i * step).toFixed(1)}" y="-24" width="${step.toFixed(1)}" height="${CH + 48}"><title>${fmtShort(x.d)}: ${tip}</title></rect>`;
  });

  const mid = days[Math.floor(n / 2)];
  const midX = (Math.floor(n / 2) + 0.5) * step;
  const svg = `<svg class="chart" viewBox="0 -24 ${CW} ${CH + 50}" role="img" aria-label="Running calorie balance over the last ${n} days: ${signed(bg)} versus goal${showM ? `, ${signed(bm)} versus break-even` : ''}">
    ${shade}
    <line class="zero" x1="0" x2="${CW}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}"/>
    ${hi > 0 ? `<text x="${CW}" y="${(Y(hi) + 12).toFixed(1)}" text-anchor="end">Over ↑</text>` : ''}
    ${lo < 0 ? `<text x="${CW}" y="${(Y(lo) - 4).toFixed(1)}" text-anchor="end">Under ↓</text>` : ''}
    ${showM ? `<path class="cm" d="${line('m')}"/>` : ''}
    <path class="cg" d="${line('g')}"/>
    <text x="0" y="-10">Running balance, kcal</text>
    <text x="0" y="${CH + 20}">${fmtShort(days[0])}</text>
    <text x="${midX.toFixed(1)}" y="${CH + 20}" text-anchor="middle">${fmtShort(mid)}</text>
    <text x="${CW}" y="${CH + 20}" text-anchor="end">Today</text>
    ${hits}
  </svg>`;

  let pace = '';
  if (showM && Math.abs(bm) >= 100) {
    const amt = Math.abs(bm) / (settings.units === 'kg' ? 7700 : 3500);
    pace = `<p class="pace">That's roughly <strong>${amt.toFixed(1)} ${settings.units}</strong> ${bm < 0 ? 'lost' : 'gained'} over this period (estimate).</p>`;
  }

  return `<section class="tcard">
    ${head}
    <div class="stats">
      <div class="stat"><b>${fmt(eaten)}</b><span>eaten over ${logged} day${logged === 1 ? '' : 's'}</span></div>
      <div class="stat"><b class="${bg <= 0 ? 'good' : 'warnc'}">${signed(bg)}</b><span>vs goal</span></div>
      ${showM ? `<div class="stat"><b class="${bm <= 0 ? 'good' : 'warnc'}">${signed(bm)}</b><span>vs break-even</span></div>` : ''}
    </div>
    ${pace}
    ${svg}
    <div class="legend"><span><i class="line"></i>vs goal</span>${showM ? '<span><i class="mline"></i>vs break-even</span>' : ''}</div>
    <p class="hint" style="margin-top:8px">Adds up finished days you logged. Below the line means under. Tap a day to open it.</p>
  </section>`;
}

function weightStats() {
  const arr = [...S.weights.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  if (!arr.length) return null;
  const t = todayKey();
  const cur = arr[arr.length - 1];
  const week = arr.filter(w => w.day <= t && daysBetween(w.day, t) < 7);
  const avg7 = week.length ? week.reduce((s, w) => s + w.lb, 0) / week.length : null;
  return { arr, cur, avg7, target: currentGoal().target };
}

function weightStatsHTML(st) {
  let toGo = '—', toLbl = 'no target set', good = '';
  if (st.target) {
    const diff = st.cur.lb - st.target;
    if (Math.abs(toUnit(diff)) < 0.05) { toGo = '0.0'; toLbl = 'at target'; good = ' class="good"'; }
    else { toGo = toUnit(Math.abs(diff)).toFixed(1); toLbl = `to ${fmtW(st.target)} target`; good = ' class="good"'; }
  }
  return `<div class="stats three">
    <div class="stat"><b>${fmtW(st.cur.lb)}</b><span>current, ${settings.units}</span></div>
    <div class="stat"><b>${st.avg7 == null ? '—' : fmtW(st.avg7)}</b><span>7-day avg</span></div>
    <div class="stat"><b${good}>${toGo}</b><span>${toLbl}</span></div>
  </div>`;
}

function weightSummary() {
  const st = weightStats();
  return `<section class="tcard"><div class="tcard-head"><span>Weight</span></div>
    ${st ? weightStatsHTML(st) : '<p class="hint" style="margin-top:10px">No weight logged yet. Use “Log weight” on the day screen.</p>'}
  </section>`;
}

function weightCard() {
  const st = weightStats();
  const head = `<div class="tcard-head"><span>Weight</span>${ranges('wt', [[30, '30d'], [90, '90d'], [0, 'All']], S.wtRange)}</div>`;
  if (!st) return `<section class="tcard">${head}<p class="note">Log your weight on a few days to see the trend.</p></section>`;
  const t = todayKey();
  const rangeStart = S.wtRange ? addDays(t, -(S.wtRange - 1)) : st.arr[0].day;
  const pts = st.arr.filter(w => w.day >= rangeStart && w.day <= t);
  // Start the axis at the first weigh-in in range so a short history isn't squeezed to one edge
  const start = pts.length ? pts[0].day : rangeStart;
  if (pts.length < 2) return `<section class="tcard">${head}${weightStatsHTML(st)}<p class="note">Log your weight on a few more days to see the trend.</p></section>`;

  const avgFor = d => { const win = st.arr.filter(w => w.day <= d && daysBetween(w.day, d) < 7); return win.reduce((s, w) => s + w.lb, 0) / win.length; };
  const avgs = pts.map(p => ({ day: p.day, lb: avgFor(p.day) }));
  let lo = Math.min(...pts.map(p => p.lb)), hi = Math.max(...pts.map(p => p.lb));
  const showTarget = st.target && st.target > lo - Math.max(10, hi - lo) && st.target < hi + Math.max(10, hi - lo);
  if (showTarget) { lo = Math.min(lo, st.target); hi = Math.max(hi, st.target); }
  const padLb = Math.max(1, (hi - lo) * 0.12);
  lo -= padLb; hi += padLb;
  const span = Math.max(1, daysBetween(start, t));
  const X = d => (daysBetween(start, d) / span) * CW;
  const Y = lb => CH - ((lb - lo) / (hi - lo)) * CH;

  const dots = pts.map(p => `<circle class="dot" cx="${X(p.day).toFixed(1)}" cy="${Y(p.lb).toFixed(1)}" r="${pts.length > 60 ? 2 : 3}"><title>${fmtShort(p.day)}: ${fmtW(p.lb)} ${settings.units}</title></circle>`).join('');
  const line = avgs.map((p, i) => `${i ? 'L' : 'M'}${X(p.day).toFixed(1)} ${Y(p.lb).toFixed(1)}`).join('');
  const tgt = showTarget
    ? `<line class="target" x1="0" x2="${CW}" y1="${Y(st.target).toFixed(1)}" y2="${Y(st.target).toFixed(1)}"/><text x="${CW}" y="${(Y(st.target) - 6).toFixed(1)}" text-anchor="end">Target ${fmtW(st.target)}</text>`
    : '';
  const svg = `<svg class="chart" viewBox="0 -24 ${CW} ${CH + 50}" role="img" aria-label="Weight trend with 7-day average">
    <line class="axis" x1="0" y1="${CH}" x2="${CW}" y2="${CH}"/>
    <text x="0" y="-10">${toUnit(hi).toFixed(0)} ${settings.units}</text>
    ${showTarget && CH - Y(st.target) < 22 ? '' : `<text x="0" y="${CH - 6}">${toUnit(lo).toFixed(0)}</text>`}
    ${tgt}${dots}<path class="avg" d="${line}"/>
    <text x="0" y="${CH + 20}">${fmtShort(start)}</text>
    <text x="${CW}" y="${CH + 20}" text-anchor="end">Today</text>
  </svg>`;
  return `<section class="tcard">${head}${weightStatsHTML(st)}${svg}
    <div class="legend"><span><i class="dotk"></i>Weigh-in</span><span><i class="line"></i>7-day average</span>${showTarget ? '<span><i class="tline"></i>Target</span>' : ''}</div>
  </section>`;
}

/* Settings */

function renderSettings() {
  const g = currentGoal();
  if (document.activeElement !== $('set-goal')) $('set-goal').value = g.kcal;
  if (document.activeElement !== $('set-maint')) $('set-maint').value = g.maint || '';
  if (document.activeElement !== $('set-target')) $('set-target').value = g.target ? `${fmtW(g.target)}` : '';
  $('set-target').setAttribute('aria-label', `Target weight in ${settings.units}`);
  $('set-target').placeholder = settings.units;
  paintSeg(document.querySelector('#view-settings .seg'), 'unit', settings.units);
  $('set-daystart').value = String(settings.dayStart);
  $('last-export').textContent = settings.lastExport ? 'Last: ' + new Date(settings.lastExport).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Never';
  $('version').textContent = VERSION;
  const k = settings.apiKey;
  $('key-status').textContent = k ? `Saved · ends …${k.slice(-4)}` : 'Not set';
  $('set-key').placeholder = k ? '••••••••' : 'Paste key';
  $('key-test').hidden = !k;
  $('key-remove').hidden = !k;
}

/* CSV export / import */

const csvCell = v => { if (v == null) return ''; const s = String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function buildCSV() {
  const rows = [['type', 'day', 'time', 'kcal', 'label', 'weight_lb', 'goal_kcal', 'target_lb', 'maint_kcal']];
  for (const g of S.goals) rows.push(['goal', g.from, '', '', '', '', g.kcal, g.target ?? '', g.maint ?? '']);
  for (const w of [...S.weights.values()].sort((a, b) => (a.day < b.day ? -1 : 1))) rows.push(['weight', w.day, '', '', '', w.lb, '', '']);
  for (const e of [...S.entries].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.ts - b.ts))) {
    rows.push(['entry', e.day, e.timed === false ? '' : new Date(e.ts).toISOString(), e.kcal, e.label, '', '', '']);
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function exportCSV() {
  const url = URL.createObjectURL(new Blob([buildCSV()], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `calorie-tracker-${todayKey()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  settings.lastExport = Date.now();
  settings.snoozeUntil = null;
  saveSettings();
  render();
  toast('Backup saved to your Downloads');
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readExport(text) {
  const rows = parseCSV(text.replace(/^﻿/, ''));
  const head = rows.shift();
  if (!head || head[0].trim() !== 'type') throw new Error('This file is not a Calorie Tracker export.');
  const idx = Object.fromEntries(head.map((n, i) => [n.trim(), i]));
  const get = (r, n) => (idx[n] == null ? '' : (r[idx[n]] ?? '')).trim();
  const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const data = { entries: [], weights: [], goals: [] };
  for (const r of rows) {
    const type = get(r, 'type'), day = get(r, 'day');
    if (!isDay(day)) continue;
    if (type === 'entry') {
      const kcal = parseInt(get(r, 'kcal'), 10);
      if (!Number.isFinite(kcal) || kcal === 0) continue;
      const ts = Date.parse(get(r, 'time'));
      const e = { day, kcal, label: get(r, 'label'), ts: Number.isFinite(ts) ? ts : dateOf(day).getTime() };
      if (!Number.isFinite(ts)) e.timed = false;
      data.entries.push(e);
    } else if (type === 'weight') {
      const lb = parseFloat(get(r, 'weight_lb'));
      if (lb > 0) data.weights.push({ day, lb });
    } else if (type === 'goal') {
      const kcal = parseInt(get(r, 'goal_kcal'), 10);
      const target = parseFloat(get(r, 'target_lb'));
      const maint = parseInt(get(r, 'maint_kcal'), 10);
      if (kcal > 0) data.goals.push({ from: day, kcal, target: Number.isFinite(target) ? target : null, maint: maint > 0 ? maint : null });
    }
  }
  return data;
}

async function importFile(file) {
  let data;
  try { data = readExport(await file.text()); }
  catch (err) { toast(err.message || 'Could not read that file'); return; }
  const n = data.entries.length, m = data.weights.length;
  if (!n && !m && !data.goals.length) { toast('No data found in that file'); return; }
  if (!confirm(`Replace everything on this phone with this file?\n\n${n} calorie entries, ${m} weigh-ins.`)) return;
  if (!data.goals.length) data.goals = S.goals;
  await db.replaceAll(data);
  await loadAll();
  S.editing = null;
  render();
  toast(`Imported ${n} entries and ${m} weigh-ins`);
}

/* Toast */

let toastTimer = null, undoFn = null;
function toast(msg, undo) {
  $('toast-msg').textContent = msg;
  undoFn = undo || null;
  $('toast-undo').hidden = !undo;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').classList.remove('show'); undoFn = null; }, undo ? 5000 : 2600);
}

/* --------------------------------------------------------------- bindings */

function bind() {
  $('prev-day').onclick = () => goToDay(addDays(S.day, -1));
  $('next-day').onclick = () => goToDay(addDays(S.day, 1));
  $('back-today').onclick = () => goToDay(todayKey());
  $('day-title').onclick = () => {
    const p = $('date-picker');
    p.max = todayKey();
    p.value = S.day;
    try { p.showPicker(); } catch { p.click(); }
  };
  $('date-picker').onchange = e => { if (e.target.value) goToDay(e.target.value); };

  $('quick').onclick = e => { const b = e.target.closest('[data-kcal]'); if (b) addEntry(S.day, Number(b.dataset.kcal), ''); };
  $('add-btn').onclick = openAdd;
  $('weight-chip').onclick = openWeight;

  $('entries').onclick = e => {
    const row = e.target.closest('.entry');
    if (row) { S.editing = Number(row.dataset.id); renderDay(); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const id = Number(act.closest('[data-edit]').dataset.edit);
    if (act.dataset.act === 'save') saveEdit();
    else if (act.dataset.act === 'del') removeEntry(id);
    else { S.editing = null; renderDay(); }
  };
  $('entries').onkeydown = e => {
    if (e.key === 'Enter' && e.target.closest('[data-edit]')) { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') { S.editing = null; renderDay(); }
  };

  $('banner-export').onclick = exportCSV;
  $('banner-dismiss').onclick = () => { settings.snoozeUntil = Date.now() + 7 * 864e5; saveSettings(); render(); };

  // Swipe between days
  let sx = null, sy = 0;
  const dayView = $('view-day');
  dayView.addEventListener('touchstart', e => {
    const x = e.touches[0].clientX;
    if (e.touches.length > 1 || e.target.closest('input, .edit') || x < 24 || x > window.innerWidth - 24) { sx = null; return; }
    sx = x; sy = e.touches[0].clientY;
  }, { passive: true });
  dayView.addEventListener('touchend', e => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const next = addDays(S.day, dx > 0 ? -1 : 1);
      if (next <= todayKey()) goToDay(next);
    }
  }, { passive: true });

  // Navigation
  document.querySelector('nav.tabs').onclick = e => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    if (b.dataset.view === 'day' && S.view === 'day') goToDay(todayKey());
    else showView(b.dataset.view);
  };

  // Add sheet
  $('keypad').onclick = e => { const b = e.target.closest('[data-k]'); if (b) pressKey(b.dataset.k); };
  $('add-confirm').onclick = confirmAdd;
  $('add-label-input').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); confirmAdd(); } };
  $('add-mode').onclick = e => { const b = e.target.closest('[data-mode]'); if (b) setAddMode(b.dataset.mode); };
  $('ai-go').onclick = estimate;
  $('ai-text').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); estimate(); } };
  $('ai-add').onclick = confirmAI;
  $('ai-setup').onclick = () => { closeSheet(); showView('settings'); setTimeout(() => $('set-key').focus(), 300); };
  $('ai-items').oninput = e => {
    const li = e.target.closest('[data-i]');
    if (!li) return;
    const it = ai.items[Number(li.dataset.i)];
    if (e.target.classList.contains('kc')) { it.kcal = Math.max(0, Math.round(parseNum(e.target.value)) || 0); renderAITotal(); }
    else it.label = e.target.value;
  };
  $('ai-items').onclick = e => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    ai.items.splice(Number(b.dataset.rm), 1);
    if (!ai.items.length) { $('ai-results').hidden = true; $('ai-go').textContent = 'Estimate calories'; }
    else renderAIItems();
  };
  document.addEventListener('keydown', e => {
    if (openSheetEl !== $('add-sheet') || settings.addMode !== 'keypad' || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (/^\d$/.test(e.key)) pressKey(e.key);
    else if (e.key === 'Backspace') pressKey('del');
    else if (e.key === '-') pressKey('neg');
    else if (e.key === 'Enter') confirmAdd();
    else if (e.key === 'Escape') closeSheet();
  });

  // Weight sheet
  $('wt-save').onclick = saveWeight;
  $('wt-remove').onclick = removeWeight;
  $('wt-input').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); saveWeight(); } };

  // Setup sheet
  $('setup-units').onclick = e => { const b = e.target.closest('[data-unit]'); if (b) { setupUnits = b.dataset.unit; paintSeg($('setup-units'), 'unit', setupUnits); } };
  $('setup-start').onclick = finishSetup;

  $('scrim').onclick = () => { if (openSheetEl && openSheetEl.id !== 'setup-sheet') closeSheet(); };
  window.addEventListener('popstate', () => { if (openSheetEl && openSheetEl.id !== 'setup-sheet') hideSheet(); });

  // Trends
  document.querySelector('#view-trends .seg').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { S.tab = b.dataset.tab; renderTrends(); } };
  $('trend-body').onclick = e => {
    const hit = e.target.closest('[data-day]');
    if (hit) { goToDay(hit.dataset.day); return; }
    const cv = e.target.closest('[data-cview]');
    if (cv) { settings.calView = cv.dataset.cview; saveSettings(); renderTrends(); return; }
    const c = e.target.closest('[data-cal]');
    if (c) { S.calRange = Number(c.dataset.cal); renderTrends(); return; }
    const w = e.target.closest('[data-wt]');
    if (w) { S.wtRange = Number(w.dataset.wt); renderTrends(); }
  };

  // Settings
  $('set-goal').onchange = async e => {
    const v = Math.round(parseNum(e.target.value));
    if (!(v >= 500 && v <= 10000)) { toast('Enter a goal between 500 and 10,000'); renderSettings(); return; }
    await setGoal({ kcal: v });
    e.target.blur();
    toast(`Goal set to ${fmt(v)} from today on`);
  };
  $('set-target').onchange = async e => {
    const s = e.target.value.trim();
    if (!s) { await setGoal({ target: null }); toast('Target weight cleared'); return; }
    const lb = fromUnit(parseNum(s));
    if (!(lb >= 50 && lb <= 700)) { toast(weightRangeMsg().replace('a weight', 'a target')); renderSettings(); return; }
    await setGoal({ target: Math.round(lb * 100) / 100 });
    e.target.blur();
    renderSettings();
    toast('Target weight updated');
  };
  $('set-maint').onchange = async e => {
    const s = e.target.value.trim();
    if (!s) { await setGoal({ maint: null }); toast('Break-even cleared'); return; }
    const v = Math.round(parseNum(s));
    if (!(v >= 800 && v <= 10000)) { toast('Enter a break-even between 800 and 10,000'); renderSettings(); return; }
    // The first break-even ever entered also covers earlier days, so history can be compared to it.
    // Later changes apply from today on, like the calorie goal.
    const first = !S.goals.some(g => g.maint);
    if (first) for (const g of S.goals) { g.maint = v; await db.put('goals', g); }
    await setGoal({ maint: v });
    e.target.blur();
    renderSettings();
    toast(first ? `Break-even set to ${fmt(v)}` : `Break-even set to ${fmt(v)} from today on`);
  };
  [$('set-goal'), $('set-maint'), $('set-target')].forEach(el => { el.onkeydown = e => { if (e.key === 'Enter') el.blur(); }; });
  document.querySelector('#view-settings .seg').onclick = e => {
    const b = e.target.closest('[data-unit]');
    if (!b) return;
    settings.units = b.dataset.unit;
    saveSettings();
    renderSettings();
  };
  $('set-daystart').onchange = e => {
    settings.dayStart = Number(e.target.value);
    saveSettings();
    S.day = todayKey();
    S.lastToday = S.day;
    toast('Day start updated');
  };
  $('set-key').onchange = e => {
    const v = e.target.value.trim().replace(/\s+/g, '');
    e.target.value = '';
    if (!v) return;
    if (!/^sk-ant-/.test(v)) { toast('That doesn’t look like a Claude API key (they start with sk-ant-)'); return; }
    settings.apiKey = v;
    saveSettings();
    e.target.blur();
    renderSettings();
    $('key-test-result').textContent = '';
    toast('API key saved on this phone');
  };
  $('set-key').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('key-test').onclick = testKey;
  $('key-remove').onclick = () => {
    if (!confirm('Remove your Claude API key from this phone?')) return;
    settings.apiKey = '';
    saveSettings();
    renderSettings();
    toast('API key removed');
  };
  $('export-btn').onclick = exportCSV;
  $('import-btn').onclick = () => $('import-file').click();
  $('import-file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };

  $('toast-undo').onclick = () => { const f = undoFn; undoFn = null; $('toast').classList.remove('show'); if (f) f(); };

  // Roll over to the new day if the app was left open
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const t = todayKey();
    if (S.lastToday && t !== S.lastToday && S.day === S.lastToday) S.day = t;
    S.lastToday = t;
    render();
  });
}

/* ------------------------------------------------------------------- boot */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !openSheetEl && S.editing == null) location.reload();
    hadController = true;
  });
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support unavailable */ });
}

async function init() {
  try {
    await db.open();
    await loadAll();
  } catch {
    document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif">This browser is blocking on-device storage, so the tracker can’t save anything. Open it in Chrome (not an incognito tab) and try again.</p>';
    return;
  }
  S.day = todayKey();
  S.lastToday = S.day;
  bind();
  showView('day');
  if (!S.goals.length) openSetup();
  registerSW();
}

init();
