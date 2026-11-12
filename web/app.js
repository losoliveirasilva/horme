'use strict';
/* Horme — interface. O servidor é a única autoridade sobre o texto do todo.txt: a interface
   manda operações ("concluir a linha N, que eu vi como X") e redesenha com o estado devolvido. */

/* ======================================================= utilidades */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// preferências gravadas quando o app se chamava Prumo (mesma origem): copia uma vez para o nome novo
try {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('prumo.') && localStorage.getItem('horme.' + k.slice(6)) == null) localStorage.setItem('horme.' + k.slice(6), localStorage.getItem(k));
  }
} catch { /* sem armazenamento */ }
const LS = {
  get(k, d) { try { const v = localStorage.getItem('horme.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('horme.' + k, JSON.stringify(v)); } catch { /* sem armazenamento: tudo bem */ } },
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const svg = (d, w = 14, sw = 2.2) => `<svg aria-hidden="true" width="${w}" height="${w}" style="width:${w / 16}rem;height:${w / 16}rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  inbox: svg('<path d="M4 13h4l1.5 3h5L16 13h4"/><path d="M5.5 5h13L21 13v6H3v-6z"/>'),
  today: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><circle cx="12" cy="15" r="1.4" fill="currentColor"/>'),
  week: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4M8 15h8"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  clockS: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 11, 2.4),
  check: svg('<path d="M5 12.5 10 17.5 19 7"/>'),
  rec: svg('<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13"/><path d="M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>', 13),
  link: svg('<path d="M10 14a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>', 13),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>', 15),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', 16),
  moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>', 16),
  auto: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>', 16),
};

/* ======================================================= datas (sempre locais, ao meio-dia, para não sofrer com horário de verão) */
const pad = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoOf(new Date());
function dateOf(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], 12);
  return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
}
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => {
  const y = d.getFullYear(), m = d.getMonth() + n;
  const last = new Date(y, m + 1, 0, 12).getDate();
  return new Date(y, m, Math.min(d.getDate(), last), 12);
};
function addBusiness(d, n) {
  let x = new Date(d), r = Math.abs(n);
  const step = n >= 0 ? 1 : -1;
  while (r) { x = addDays(x, step); const w = x.getDay(); if (w !== 0 && w !== 6) r--; }
  return x;
}
function shiftDate(d, n, unit) {
  return { d: () => addDays(d, n), w: () => addDays(d, 7 * n), m: () => addMonths(d, n), y: () => addMonths(d, 12 * n), b: () => addBusiness(d, n) }[unit]?.() ?? null;
}
const diffDays = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 864e5);
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const WDL = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MON = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const fmtDate = s => { const d = dateOf(s); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : s; };
const fmtShort = (s, today) => {
  const d = dateOf(s); if (!d) return s;
  const base = `${d.getDate()} ${MON[d.getMonth()]}`;
  return d.getFullYear() === dateOf(today).getFullYear() ? base : `${base} ${d.getFullYear()}`;
};
const fmtLong = s => { const d = dateOf(s); return d ? `${WDL[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}` : s; };
function relDays(n) {
  if (n === 0) return 'hoje';
  if (n === 1) return 'amanhã';
  if (n === -1) return 'ontem';
  return n > 0 ? `em ${n} dias` : `há ${-n} dias`;
}

/* Palavras de data na digitação: due:amanhã, due:sex, t:hoje, due:+3d → AAAA-MM-DD.
   (`t:-3d` é sintaxe válida — relativa ao vencimento — e fica como está.) */
const WORDS = { hoje: 0, hj: 0, today: 0, amanha: 1, tomorrow: 1 };
const WEEKDAYS = { dom: 0, domingo: 0, sun: 0, sunday: 0, seg: 1, segunda: 1, mon: 1, monday: 1, ter: 2, terca: 2, tue: 2, tuesday: 2,
  qua: 3, quarta: 3, wed: 3, wednesday: 3, qui: 4, quinta: 4, thu: 4, thursday: 4, sex: 5, sexta: 5, fri: 5, friday: 5,
  sab: 6, sabado: 6, sat: 6, saturday: 6 };
function wordDate(word, key) {
  const w = norm(word), today = dateOf(todayISO());
  if (w in WORDS) return isoOf(addDays(today, WORDS[w]));
  if (w in WEEKDAYS) return isoOf(addDays(today, ((WEEKDAYS[w] - today.getDay() + 7) % 7) || 7));
  const m = key === 'due' && /^\+?(\d+)([dbwmy])$/.exec(w);
  if (m) return isoOf(shiftDate(today, +m[1], m[2]));
  return null;
}
function expandDates(text) {
  return text.replace(/(^|\s)(due|t):(\S+)/g, (all, sp, key, val) => {
    const d = wordDate(val, key);
    return d ? `${sp}${key}:${d}` : all;
  });
}
function withCreated(s) {
  if (/^x\s/.test(s)) return s;
  const m = /^(\([A-Z]\)[ \t]+)?(\d{4}-\d{2}-\d{2}(?:[ \t]|$))?/.exec(s);
  if (m[2]) return s;
  const pre = m[1] || '';
  return pre + todayISO() + ' ' + s.slice(pre.length);
}

/* ======================================================= estado */
const S = {
  data: null, fp: null,
  view: LS.get('view', 'pending'),
  projects: new Set(LS.get('projects', [])),
  contexts: new Set(LS.get('contexts', [])),
  pris: new Set(LS.get('pris', [])),
  recOnly: LS.get('recOnly', false),
  search: '',
  group: LS.get('group', 'due'),
  sort: LS.get('sort', 'priority'),
  density: LS.get('density', 'compact'),
  collapsed: new Set(LS.get('collapsed', [])),
  theme: LS.get('theme', 'auto'),
  sel: null, selPos: 0, selKey: null,
  panel: false, panelKey: null, recCustom: false,
  editing: null,
  flash: new Set(),
  archive: null,
  inflight: 0, conn: 'connecting', lastExternal: null,
  chord: null, chordTimer: 0,
  rows: [],
};
function persist() {
  LS.set('view', S.view); LS.set('projects', [...S.projects]); LS.set('contexts', [...S.contexts]);
  LS.set('pris', [...S.pris]); LS.set('recOnly', S.recOnly); LS.set('group', S.group); LS.set('sort', S.sort);
  LS.set('density', S.density); LS.set('collapsed', [...S.collapsed]); LS.set('theme', S.theme);
}
const tasks = () => (S.data && S.data.tasks) || [];
const isFuture = (t, today) => !!(t.tDate && t.tDate > today);
const ref = t => ({ i: t.i, raw: t.raw });

function findTask(r) {
  if (!r) return null;
  let best = null, bd = Infinity;
  for (const t of tasks()) if (t.raw === r.raw && Math.abs(t.i - r.i) < bd) { bd = Math.abs(t.i - r.i); best = t; }
  if (best) return best;
  // a linha mudou fora do Horme: fica com a mais parecida (palavras em comum), se houver
  const a = new Set(r.raw.split(/\s+/));
  let bs = 0;
  for (const t of tasks()) {
    const b = t.raw.split(/\s+/);
    let inter = 0;
    for (const w of b) if (a.has(w)) inter++;
    const sim = inter / Math.max(a.size, b.length);
    const score = sim - Math.abs(t.i - r.i) * 1e-4;
    if (sim >= 0.6 && score > bs) { bs = score; best = t; }
  }
  return best;
}
const selected = () => (S.sel ? findTask(S.sel) : null);

/* ======================================================= visões, filtros, ordenação, grupos */
const VIEWS = [
  { id: 'pending', label: 'Pendentes', icon: ICON.inbox, test: (t, d) => !t.done && !isFuture(t, d) },
  { id: 'today', label: 'Hoje', icon: ICON.today, test: (t, d) => !t.done && !isFuture(t, d) && !!t.dueDate && t.dueDate <= d },
  { id: 'week', label: 'Próximos 7 dias', icon: ICON.week, test: (t, d) => !t.done && !isFuture(t, d) && !!t.dueDate && t.dueDate <= isoOf(addDays(dateOf(d), 7)) },
  { id: 'scheduled', label: 'Programadas', icon: ICON.clock, test: (t, d) => !t.done && isFuture(t, d) },
  { id: 'done', label: 'Concluídas', icon: ICON.check, test: t => t.done },
];
const viewOf = id => VIEWS.find(v => v.id === id) || VIEWS[0];

function inView(today) { const v = viewOf(S.view); return tasks().filter(t => v.test(t, today)); }
function hasFilters() { return S.projects.size || S.contexts.size || S.pris.size || S.recOnly || S.search.trim(); }
function applyFilters(list) {
  const terms = norm(S.search).split(/\s+/).filter(Boolean);
  return list.filter(t =>
    (!S.projects.size || t.projects.some(p => S.projects.has(p))) &&
    (!S.contexts.size || t.contexts.some(c => S.contexts.has(c))) &&
    (!S.pris.size || S.pris.has(t.pri || '-')) &&
    (!S.recOnly || !!t.rec) &&
    (!terms.length || (h => terms.every(w => h.includes(w)))(norm(t.raw))));
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const priKey = t => t.pri || '~';
const dueKey = t => t.dueDate || '9999-99-99';
const SORTS = {
  priority: { label: 'Prioridade', cmp: (a, b) => cmpStr(priKey(a), priKey(b)) || cmpStr(dueKey(a), dueKey(b)) || a.i - b.i },
  due: { label: 'Vencimento', cmp: (a, b) => cmpStr(dueKey(a), dueKey(b)) || cmpStr(priKey(a), priKey(b)) || a.i - b.i },
  created: { label: 'Criação (recentes)', cmp: (a, b) => cmpStr(b.created || '', a.created || '') || a.i - b.i },
  alpha: { label: 'Descrição (A–Z)', cmp: (a, b) => plainDesc(a).localeCompare(plainDesc(b), 'pt-BR', { sensitivity: 'base' }) || a.i - b.i },
  file: { label: 'Ordem do arquivo', cmp: (a, b) => a.i - b.i },
};
const GROUPS = { due: 'Vencimento', priority: 'Prioridade', project: 'Projeto', context: 'Contexto', none: 'Nenhum' };

function dueBucket(t, today) {
  if (!t.dueDate) return t.due ? ['invalid', 'Vencimento inválido', 'warn'] : ['none', 'Sem vencimento'];
  const n = diffDays(today, t.dueDate);
  if (n < 0) return ['overdue', 'Vencidas', 'bad'];
  if (n === 0) return ['today', 'Hoje', 'warn'];
  if (n === 1) return ['tomorrow', 'Amanhã'];
  if (n <= 7) return ['week', 'Próximos 7 dias'];
  if (n <= 30) return ['month', 'Próximos 30 dias'];
  return ['later', 'Mais tarde'];
}
const DUE_ORDER = ['overdue', 'today', 'tomorrow', 'week', 'month', 'later', 'invalid', 'none'];

function doneLabel(d, today) {
  if (!d) return 'Sem data de conclusão';
  const n = diffDays(d, today);
  if (n === 0) return 'Hoje';
  if (n === 1) return 'Ontem';
  return `${WD[dateOf(d).getDay()]} · ${fmtShort(d, today)}`;
}
function thrBucket(t, today) {
  const n = diffDays(today, t.tDate);
  if (n === 1) return ['tomorrow', 'Amanhã'];
  if (n <= 7) return ['week', 'Nos próximos 7 dias'];
  if (n <= 30) return ['month', 'Nos próximos 30 dias'];
  return ['later', 'Mais tarde'];
}

function buildGroups(list, today) {
  const mk = (key, label, cls, items) => ({ key: `${S.view}:${key}`, label, cls, items });
  if (S.view === 'done') {
    list.sort((a, b) => cmpStr(b.doneDate || '', a.doneDate || '') || b.i - a.i);
    const m = new Map();
    for (const t of list) { const k = t.doneDate || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    return [...m].map(([k, items]) => mk('done-' + k, doneLabel(k, today), '', items));
  }
  if (S.view === 'scheduled') {
    list.sort((a, b) => cmpStr(a.tDate, b.tDate) || SORTS.priority.cmp(a, b));
    const m = new Map();
    for (const t of list) { const [k, l] = thrBucket(t, today); if (!m.has(k)) m.set(k, { l, items: [] }); m.get(k).items.push(t); }
    return [...m].map(([k, g]) => mk('thr-' + k, g.l, '', g.items));
  }
  list.sort(SORTS[S.sort].cmp);
  if (S.group === 'none') return [mk('all', null, '', list)];
  if (S.group === 'due') {
    const m = new Map();
    for (const t of list) { const [k, l, c] = dueBucket(t, today); if (!m.has(k)) m.set(k, { l, c, items: [] }); m.get(k).items.push(t); }
    return DUE_ORDER.filter(k => m.has(k)).map(k => mk('due-' + k, m.get(k).l, m.get(k).c, m.get(k).items));
  }
  if (S.group === 'priority') {
    const m = new Map();
    for (const t of list) { const k = t.pri || '~'; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    return [...m.keys()].sort().map(k => mk('pri-' + k, k === '~' ? 'Sem prioridade' : `Prioridade ${k}`, '', m.get(k)));
  }
  const field = S.group === 'project' ? 'projects' : 'contexts';
  const sig = S.group === 'project' ? '+' : '@';
  const m = new Map(), none = [];
  for (const t of list) {
    if (!t[field].length) none.push(t);
    for (const n of t[field]) { if (!m.has(n)) m.set(n, []); m.get(n).push(t); }
  }
  const out = [...m.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }))
    .map(n => ({ ...mk(`${field}-${n}`, sig + n, S.group === 'project' ? 'proj' : 'ctx', m.get(n)), tag: sig + n }));
  if (none.length) out.push(mk(`${field}-none`, S.group === 'project' ? 'Sem projeto' : 'Sem contexto', '', none));
  return out;
}

/* ======================================================= texto da tarefa */
function splitTokens(tokens) {
  let last = -1;
  tokens.forEach((x, n) => { if (x.k === 'text') last = n; });
  if (last < 0) return { desc: tokens, trail: [], bare: true };
  return { desc: tokens.slice(0, last + 1), trail: tokens.slice(last + 1), bare: false };
}
const safeUrl = u => (/^https?:\/\//i.test(u) ? u : null);
function shortUrl(u) {
  try {
    const x = new URL(u);
    const parts = x.pathname.split('/').filter(Boolean);
    const tail = parts.length > 2 ? '…/' + parts.slice(-2).join('/') : parts.join('/');
    return x.host.replace(/^www\./, '') + (tail ? '/' + tail : '');
  } catch { return u; }
}
function tokenHtml(x) {
  switch (x.k) {
    case 'project': return `<span class="tk-proj">${esc(x.v)}</span>`;
    case 'context': return `<span class="tk-ctx">${esc(x.v)}</span>`;
    case 'kv': return `<span class="tk-kv">${esc(x.v)}</span>`;
    case 'url': {
      const u = safeUrl(x.v);
      return u ? linkHtml(u, shortUrl(u)) : esc(x.v);
    }
    default: return esc(x.v);
  }
}
// Link markdown [rótulo](url): exibe só o rótulo, clicável. A URL aceita um nível de parênteses (ex.: Wikipedia).
const MDLINK = String.raw`\[([^\[\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)`;
const linkHtml = (u, label) => `<a class="tk-url" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${esc(label)}</a>`;
function descHtml(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].v.includes('[')) {
      // o rótulo pode ter espaços (vários tokens); a URL fica no primeiro token com "](http"
      const j = toks.findIndex((x, n) => n >= i && n < i + 30 && /\]\(https?:\/\//i.test(x.v));
      if (j >= 0) {
        const s = toks.slice(i, j + 1).map(x => x.v).join(' ');
        const m = new RegExp(MDLINK, 'i').exec(s);
        if (m && m.index < toks[i].v.length) {  // o link tem que começar neste token
          out.push(esc(s.slice(0, m.index)) + linkHtml(m[2], m[1]) + esc(s.slice(m.index + m[0].length)));
          i = j;
          continue;
        }
      }
    }
    out.push(tokenHtml(toks[i]));
  }
  return out.join(' ');
}
function plainDesc(t) { return splitTokens(t.tokens).desc.map(x => x.v).join(' ').replace(new RegExp(MDLINK, 'gi'), '$1'); }

const UNIT = { d: ['dia', 'dias'], b: ['dia útil', 'dias úteis'], w: ['semana', 'semanas'], m: ['mês', 'meses'], y: ['ano', 'anos'] };
const EVERY1 = { d: 'todo dia', b: 'todo dia útil', w: 'toda semana', m: 'todo mês', y: 'todo ano' };
const usesDay = (s, day) => !!(s && day && 'my'.includes(s.unit));
const lastDayOf = iso => { const d = dateOf(iso); return new Date(d.getFullYear(), d.getMonth() + 1, 0, 12).getDate(); };
const withDay = (d, day) => new Date(d.getFullYear(), d.getMonth(), Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0, 12).getDate()), 12);
const dayText = day => (day >= 31 ? 'no último dia do mês' : day > 28 ? `no dia ${day} (ou no último, em meses menores)` : `no dia ${day}`);
function recLabel(s, day) {
  if (!s) return '';
  const every = s.n === 1 ? EVERY1[s.unit] : `a cada ${s.n} ${UNIT[s.unit][1]}`;
  return `${every}${usesDay(s, day) ? ', ' + dayText(day) : ''}, contando ${s.strict ? 'do vencimento' : 'da conclusão'}`;
}
function nextDue(t, today) {
  const s = t.recSpec;
  if (!s) return null;
  const anchor = s.strict ? (dateOf(t.dueDate) || dateOf(today)) : dateOf(today);
  let d = shiftDate(anchor, s.n, s.unit);
  if (d && usesDay(s, t.recDay)) d = withDay(d, t.recDay);
  return d ? isoOf(d) : null;
}
function thrLabel(t, today) {
  if (!t.t) return '';
  if (!t.tDate) return '';
  const n = diffDays(today, t.tDate);
  return n > 0 ? `aparece ${relDays(n)} (${fmtShort(t.tDate, today)})` : `visível desde ${fmtShort(t.tDate, today)}`;
}

/* ======================================================= linha da lista */
function dueChip(t, today) {
  if (!t.due) return '';
  if (!t.dueDate) return `<span class="chip warnchip" title="vencimento inválido">due:${esc(t.due)}?</span>`;
  const n = diffDays(today, t.dueDate);
  let cls = '', text;
  if (n < 0) { cls = 'bad'; text = n === -1 ? 'ontem' : `há ${-n} d`; }
  else if (n === 0) { cls = 'warn'; text = 'hoje'; }
  else if (n === 1) { cls = 'soon'; text = 'amanhã'; }
  else if (n < 7) { cls = 'soon'; text = WD[dateOf(t.dueDate).getDay()]; }
  else text = fmtShort(t.dueDate, today);
  if (t.done) cls = '';
  return `<span class="chip due ${cls}" title="vence ${esc(fmtLong(t.dueDate))} · ${relDays(n)}">${esc(text)}</span>`;
}

function rowHtml(t, gkey, today, hide) {
  const { desc, trail } = splitTokens(t.tokens);
  const isSel = S.sel && S.sel.i === t.i;
  const key = `${gkey}|${t.i}`;
  const tags = [], extra = [], links = [];
  for (const x of trail) {
    if ((x.k === 'project' || x.k === 'context') && !hide.has(x.v)) tags.push(`<span class="tag ${x.k === 'project' ? 'proj' : 'ctx'}">${esc(x.v)}</span>`);
    else if (x.k === 'url') { const u = safeUrl(x.v); if (u) links.push(u); else extra.push(x.v); }
    else if (x.k === 'kv' && !['due', 't', 'rec'].includes(x.key) && !(t.done && x.key === 'pri') && !(x.key === 'day' && t.rec)) extra.push(x.v);
  }
  let tagHtml = tags.join('');
  if (S.density === 'compact' && tags.length > 2) tagHtml = tags.slice(0, 2).join('') + `<span class="tag more" title="${tags.length - 2} a mais">+${tags.length - 2}</span>`;
  const chips = [];
  if (S.view === 'scheduled' && t.tDate) chips.push(`<span class="chip thr" title="${esc(thrLabel(t, today))}">${ICON.clockS}${esc(fmtShort(t.tDate, today))}</span>`);
  chips.push(dueChip(t, today));
  if (t.rec) chips.push(t.recSpec ? `<span class="chip rec" title="repete ${esc(recLabel(t.recSpec, t.recDay))} (rec:${esc(t.rec)}${usesDay(t.recSpec, t.recDay) ? ' day:' + esc(t.day) : ''})">${ICON.rec}</span>`
    : `<span class="chip warnchip" title="recorrência não reconhecida">rec:${esc(t.rec)}?</span>`);
  for (const u of links.slice(0, 2)) chips.push(`<a class="chip lnk" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}" aria-label="abrir link">${ICON.link}</a>`);
  const plain = plainDesc(t);
  const pri = t.pri ? `<span class="pri ${t.pri.toLowerCase()}" title="prioridade ${t.pri}">${t.pri}</span>` : '<span class="pri none"></span>';
  const cls = ['task', t.done && 'done', isSel && 'sel', S.flash.has(t.i) && 'flash'].filter(Boolean).join(' ');
  return `<li class="${cls}" data-i="${t.i}" data-key="${esc(key)}" tabindex="-1"${isSel ? ' aria-current="true"' : ''}>`
    + `<input type="checkbox" class="chk" ${t.done ? 'checked' : ''} ${t.readonly ? 'disabled' : ''} aria-label="${t.done ? 'Reabrir' : 'Concluir'}: ${esc(plain)}">`
    + pri
    + `<span class="txt" title="${esc(plain.length > 60 ? plain : '')}">${descHtml(desc)}</span>`
    + `<span class="meta">${tagHtml}${chips.join('')}</span>`
    + `<div class="extra">${extra.map(e => `<span>${esc(e)}</span>`).join('')}</div>`
    + '</li>';
}

/* ======================================================= render */
function render() {
  if (!S.data) return;
  applyTheme();
  renderHeader();
  if (!S.data.file) { renderSetup(); return; }
  $('#addForm').hidden = false;
  const today = todayISO();
  renderSide(today);
  renderToolbar(today);
  renderActiveFilters();
  renderList(today);
  renderPanel();
  renderBanner();
}

function renderHeader() {
  const f = S.data.file;
  const chip = $('#fileChip');
  chip.textContent = f ? f.path.replace(/^\/home\/[^/]+/, '~') : 'escolher arquivo';
  chip.title = f ? `${f.path}${f.real ? ` → ${f.real}` : ''}\nclique para ver detalhes` : '';
  const sync = $('#sync');
  const ext = S.lastExternal ? ` · alterado fora às ${S.lastExternal}` : '';
  const st = { ok: ['ok', 'sincronizado' + ext], warn: ['warn', 'reconectando…'], bad: ['bad', 'sem conexão'], connecting: ['warn', 'conectando…'] }[S.conn];
  sync.className = `sync ${st[0]}${S.pulse ? ' pulse' : ''}`;
  sync.innerHTML = `<i class="dot"></i><span>${esc(st[1])}</span>`;
  S.pulse = false;
  const ub = $('#undoBtn');
  ub.hidden = !S.data.undo;
  ub.title = S.data.undo ? `Desfazer: ${S.data.undo} (u)` : '';
  ub.setAttribute('aria-label', ub.title || 'Desfazer');
}

function renderSide(today) {
  const all = tasks();
  const counts = Object.fromEntries(VIEWS.map(v => [v.id, all.filter(t => v.test(t, today)).length]));
  const overdue = all.filter(t => !t.done && !isFuture(t, today) && t.dueDate && t.dueDate < today).length;
  const base = inView(today);
  const tally = field => {
    const m = new Map();
    for (const t of base) for (const n of t[field]) m.set(n, (m.get(n) || 0) + 1);
    return m;
  };
  const pm = tally('projects'), cm = tally('contexts');
  for (const p of S.projects) if (!pm.has(p)) pm.set(p, 0);
  for (const c of S.contexts) if (!cm.has(c)) cm.set(c, 0);
  const sorted = m => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR', { sensitivity: 'base' }));
  const prim = new Map();
  for (const t of base) prim.set(t.pri || '-', (prim.get(t.pri || '-') || 0) + 1);
  for (const p of S.pris) if (!prim.has(p)) prim.set(p, 0);
  const recCount = base.filter(t => t.rec).length;

  const item = (cls, attrs, ico, name, ct, on, ctCls = '') =>
    `<button class="sitem ${cls}${on ? ' on' : ''}${ct === 0 ? ' zero' : ''}" ${attrs} aria-pressed="${on}">${ico}<span class="nm">${name}</span><span class="ct ${ctCls}">${ct}</span></button>`;

  let h = '<div class="sgroup"><h2>Visões</h2>';
  VIEWS.forEach((v, n) => {
    h += item('', `data-view="${v.id}" title="${v.label} (${n + 1})"`, `<span class="ico">${v.icon}</span>`, v.label, counts[v.id],
      S.view === v.id, v.id === 'today' && overdue ? 'bad' : '');
  });
  h += '</div>';
  if (pm.size) {
    h += `<div class="sgroup"><h2>Projetos${S.projects.size ? '<button class="link" data-clear="projects">limpar</button>' : ''}</h2>`;
    for (const [n, c] of sorted(pm)) h += item('proj', `data-proj="${esc(n)}"`, '', '<span class="sig">+</span>' + esc(n), c, S.projects.has(n));
    h += '</div>';
  }
  if (cm.size) {
    h += `<div class="sgroup"><h2>Contextos${S.contexts.size ? '<button class="link" data-clear="contexts">limpar</button>' : ''}</h2>`;
    for (const [n, c] of sorted(cm)) h += item('ctx', `data-ctx="${esc(n)}"`, '', '<span class="sig">@</span>' + esc(n), c, S.contexts.has(n));
    h += '</div>';
  }
  if (prim.size) {
    h += `<div class="sgroup"><h2>Prioridade${S.pris.size ? '<button class="link" data-clear="pris">limpar</button>' : ''}</h2><div class="prigrid">`;
    for (const [p, c] of [...prim].sort((a, b) => (a[0] === '-' ? 1 : b[0] === '-' ? -1 : cmpStr(a[0], b[0])))) {
      h += `<button class="${S.pris.has(p) ? 'on' : ''}${c ? '' : ' zero'}" data-pri="${p}" aria-pressed="${S.pris.has(p)}" title="${p === '-' ? 'sem prioridade' : 'prioridade ' + p}: ${c}">${p === '-' ? '–' : p}</button>`;
    }
    h += '</div></div>';
  }
  if (recCount || S.recOnly) {
    h += '<div class="sgroup"><h2>Outros</h2>' + item('', 'data-rec="1"', `<span class="ico">${ICON.rec}</span>`, 'Recorrentes', recCount, S.recOnly) + '</div>';
  }
  $('#side').innerHTML = h;
}

function renderToolbar(today) {
  const v = viewOf(S.view);
  const n = applyFilters(inView(today)).length;
  let h = `<h2>${esc(v.label)}</h2><span class="count">${plural(n, 'tarefa', 'tarefas')}</span><span class="spacer"></span>`;
  if (S.view === 'done') {
    const doneN = tasks().filter(t => t.done).length;
    h += `<button data-act="archive" ${doneN ? '' : 'disabled'} title="Move as concluídas do todo.txt para o done.txt">Arquivar concluídas</button>`;
  } else if (S.view !== 'scheduled') {
    h += `<label>Agrupar <select id="groupSel">${Object.entries(GROUPS).map(([k, l]) => `<option value="${k}" ${S.group === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    h += `<label>Ordenar <select id="sortSel">${Object.entries(SORTS).map(([k, s]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>`;
  }
  h += `<span class="seg" role="group" aria-label="Densidade"><button data-density="compact" class="${S.density === 'compact' ? 'on' : ''}" aria-pressed="${S.density === 'compact'}" title="Compacto (v)">Compacto</button><button data-density="detailed" class="${S.density === 'detailed' ? 'on' : ''}" aria-pressed="${S.density === 'detailed'}" title="Detalhado (v)">Detalhado</button></span>`;
  $('#toolbar').innerHTML = h;
}

function renderActiveFilters() {
  const chips = [];
  for (const p of S.projects) chips.push(`<button class="fchip proj" data-unproj="${esc(p)}" title="tirar filtro">+${esc(p)}<span class="x">✕</span></button>`);
  for (const c of S.contexts) chips.push(`<button class="fchip ctx" data-unctx="${esc(c)}" title="tirar filtro">@${esc(c)}<span class="x">✕</span></button>`);
  for (const p of S.pris) chips.push(`<button class="fchip" data-unpri="${p}" title="tirar filtro">${p === '-' ? 'sem prioridade' : 'prioridade ' + p}<span class="x">✕</span></button>`);
  if (S.recOnly) chips.push('<button class="fchip" data-unrec="1">recorrentes<span class="x">✕</span></button>');
  if (S.search.trim()) chips.push(`<button class="fchip" data-unsearch="1">“${esc(S.search.trim())}”<span class="x">✕</span></button>`);
  if (chips.length > 1) chips.push('<button class="link" data-clear="all">limpar filtros</button>');
  $('#activeFilters').innerHTML = chips.join('');
}

function renderList(today) {
  const list = applyFilters(inView(today));
  const groups = buildGroups(list, today);
  const hide = new Set();
  if (S.projects.size === 1) hide.add('+' + [...S.projects][0]);
  if (S.contexts.size === 1) hide.add('@' + [...S.contexts][0]);
  const el = $('#list');
  el.className = `list ${S.density}`;
  const hadFocus = el.contains(document.activeElement) && document.activeElement.classList.contains('task');
  if (!list.length) {
    el.innerHTML = emptyHtml(today);
    S.rows = [];
  } else {
    el.innerHTML = groups.map(g => {
      const gh = g.tag ? new Set([...hide, g.tag]) : hide;
      const collapsed = S.collapsed.has(g.key);
      const head = g.label == null ? '' : `<button class="ghead ${g.cls || ''}" data-toggle="${esc(g.key)}" aria-expanded="${!collapsed}"><span class="chev">▾</span>${esc(g.label)}<span class="ct">${g.items.length}</span></button>`;
      return `<section class="group${collapsed ? ' collapsed' : ''}">${head}<ul class="tasks" role="list">${g.items.map(t => rowHtml(t, g.key, today, gh)).join('')}</ul></section>`;
    }).join('') + hiddenNote(today);
    S.rows = $$('.group:not(.collapsed) .task', el);
  }
  // seleção: mantém a tarefa; se ela saiu da visão, fica na mesma posição da lista
  let cur = S.sel ? (S.rows.find(r => r.dataset.key === S.selKey && +r.dataset.i === S.sel.i) || S.rows.find(r => +r.dataset.i === S.sel.i)) : null;
  if (!cur && S.sel && S.rows.length && !S.editing) {
    cur = S.rows[Math.min(S.selPos, S.rows.length - 1)];
    const t = tasks().find(x => x.i === +cur.dataset.i);
    S.sel = t ? ref(t) : null;
    $$('.task.sel', el).forEach(r => { r.classList.remove('sel'); r.removeAttribute('aria-current'); });
    $$(`.task[data-i="${cur.dataset.i}"]`, el).forEach(r => { r.classList.add('sel'); r.setAttribute('aria-current', 'true'); });
  }
  if (cur) {
    S.selPos = S.rows.indexOf(cur);
    S.selKey = cur.dataset.key;
    cur.tabIndex = 0;
    if (hadFocus) cur.focus({ preventScroll: true });
  } else if (S.rows[0]) S.rows[0].tabIndex = 0;
  S.flash.clear();
}

function emptyHtml(today) {
  if (hasFilters()) return '<div class="empty"><b>Nada com esses filtros</b><button class="link" data-clear="all">limpar filtros</button></div>';
  const msg = {
    pending: ['Nenhuma tarefa pendente', 'Adicione uma no campo acima (n).'],
    today: ['Nada vence hoje', 'Nem tarefas vencidas. Bom sinal.'],
    week: ['Nada vence nos próximos 7 dias', ''],
    scheduled: ['Nenhuma tarefa programada', 'Tarefas com t: no futuro aparecem aqui até a data chegar.'],
    done: ['Nenhuma concluída no todo.txt', ''],
  }[S.view];
  return `<div class="empty"><b>${msg[0]}</b>${esc(msg[1])}</div>` + hiddenNote(today);
}
function hiddenNote(today) {
  if (S.view === 'done') return archiveBox();
  if (S.view === 'scheduled') return '';
  const n = tasks().filter(t => !t.done && isFuture(t, today)).length;
  return n ? `<div class="hidden-note">${plural(n, 'tarefa programada oculta', 'tarefas programadas ocultas')} até a data do <code>t:</code> · <button class="link" data-view="scheduled">ver</button></div>` : '';
}
function archiveBox() {
  const a = S.archive;
  let inner = '';
  if (S.archiveOpen) {
    if (!a) inner = '<div class="empty">carregando…</div>';
    else if (!a.tasks.length) inner = `<div class="empty">${a.exists ? 'done.txt vazio' : 'ainda não existe done.txt'}</div>`;
    else {
      const today = todayISO();
      const list = a.tasks.slice().sort((x, y) => cmpStr(y.doneDate || '', x.doneDate || '') || y.i - x.i);
      const shown = list.slice(0, 300);
      inner = `<ul class="tasks" role="list">${shown.map(t => rowHtml(t, 'arch', today, new Set()).replace('class="task', 'class="task arch')).join('')}</ul>`
        + (list.length > 300 ? `<div class="hidden-note">mostrando 300 de ${list.length}</div>` : '');
    }
  }
  return `<details class="archive-box" ${S.archiveOpen ? 'open' : ''}><summary>Arquivadas em ${esc((S.data.file.done || 'done.txt').replace(/^\/home\/[^/]+/, '~'))}</summary>${inner}</details>`;
}

function renderBanner() {
  const f = S.data.file, b = $('#banner');
  let msg = '', cls = '';
  if (!f.exists) { msg = `O arquivo ${f.path} ainda não existe: ele será criado ao adicionar a primeira tarefa.`; cls = 'info'; }
  else if (!f.writable) { msg = `Sem permissão de escrita em ${f.real || f.path}.`; cls = 'bad'; }
  else if (S.data.unreadable) msg = `${plural(S.data.unreadable, 'linha tem', 'linhas têm')} bytes que não são UTF-8: aparecem só para leitura e não são alteradas.`;
  b.hidden = !msg;
  b.className = `banner ${cls}`;
  b.textContent = msg;
}

function renderSetup() {
  $('#side').innerHTML = '';
  $('#toolbar').innerHTML = '';
  $('#activeFilters').innerHTML = '';
  $('#addForm').hidden = true;
  $('#banner').hidden = true;
  closePanel(true);
  $('#list').innerHTML = `<div class="setup"><h2>Onde está o seu todo.txt?</h2>
    <p>Nenhum arquivo foi indicado por <code>$TODO_FILE</code>, <code>$TODO_DIR</code> ou argumento, e não há <code>todo.txt</code> na pasta onde o Horme foi aberto. Informe o caminho: ele fica salvo em <code>~/.config/horme/config.json</code>.</p>
    ${pathForm(S.data.suggest || '~/todo.txt')}</div>`;
}
function pathForm(value) {
  return `<form class="pathform" data-pathform><input name="file" value="${esc(value)}" spellcheck="false" aria-label="Caminho do todo.txt"><button class="primary">Usar este arquivo</button></form><div class="err" data-patherr></div>`;
}

/* ======================================================= painel de detalhes */
function openPanel(focus) {
  if (!selected()) return;
  S.panel = true;
  renderPanel(true);
  if (focus) setTimeout(() => { const el = $(focus); if (el) el.focus(); }, 0);
}
function closePanel(silent) {
  S.panel = false; S.editing = null; S.recCustom = false; S.panelKey = null;
  $('#panel').hidden = true;
  $('#layout').classList.remove('with-panel');
  if (!silent) focusSelectedRow();
}

function renderPanel(force) {
  const p = $('#panel');
  if (!S.panel) { p.hidden = true; $('#layout').classList.remove('with-panel'); return; }
  const t = selected();
  const ed = S.editing;
  const lost = ed && !tasks().some(x => x.raw === ed.raw);
  const key = t ? `${t.i}\u0000${t.raw}\u0000${!!ed}\u0000${lost}\u0000${S.recCustom}\u0000${todayISO()}` : 'none';
  if (!force && key === S.panelKey && !p.hidden) return;
  if (!t && !ed) { closePanel(true); return; }
  const focusId = p.contains(document.activeElement) ? document.activeElement.id : null;
  S.panelKey = key;
  p.hidden = false;
  $('#layout').classList.add('with-panel');
  p.innerHTML = t ? panelHtml(t, lost) : lostHtml();
  const ta = $('#pEdit', p);
  if (ta) {
    ta.value = ed.draft;
    autoGrow(ta);
    attachAC(ta);
  }
  for (const id of ['pAddProj', 'pAddCtx']) { const el = $('#' + id, p); if (el) attachAC(el, id === 'pAddProj' ? '+' : '@'); }
  if (focusId) { const el = document.getElementById(focusId); if (el) el.focus(); }
}

function lostHtml() {
  return `<div class="ph"><span class="spacer"></span><button class="iconbtn" data-act="close" aria-label="Fechar">${ICON.close}</button></div>
    <div class="pnotice bad">A tarefa que você editava mudou ou sumiu fora do Horme.<br>
    <button data-act="use-mine">Salvar meu texto como nova tarefa</button><button data-act="discard">Descartar</button></div>
    <div class="rawline" style="margin-top:0.625rem">${esc(S.editing.draft)}</div>`;
}

const PRESETS = [['none', 'Não repete'], ['1d', 'Todo dia'], ['1b', 'Todo dia útil'], ['1w', 'Toda semana'], ['2w', 'A cada 2 semanas'],
  ['1m', 'Todo mês'], ['3m', 'A cada 3 meses'], ['1y', 'Todo ano'], ['custom', 'Personalizar…']];

function panelHtml(t, lost) {
  const today = todayISO();
  const ed = S.editing;
  const ro = !!t.readonly;
  let h = `<div class="ph"><span class="lineref" title="linha no arquivo">linha ${t.i + 1}</span>${t.created ? `<span>· criada ${esc(fmtShort(t.created, today))}</span>` : ''}<span class="spacer"></span>`
    + `<button class="iconbtn" data-act="close" aria-label="Fechar detalhes (Esc)">${ICON.close}</button></div>`;
  h += `<div class="ptitle ${t.done ? 'task-done' : ''}">`
    + `<input type="checkbox" class="chk" data-act="toggle" ${t.done ? 'checked' : ''} ${ro ? 'disabled' : ''} aria-label="${t.done ? 'Reabrir' : 'Concluir'}">`;
  if (ed) {
    h += `<div class="editbox ac-wrap"><textarea id="pEdit" rows="2" spellcheck="false" aria-label="Texto da tarefa (linha do todo.txt)"></textarea>`
      + `<div class="hint"><span><kbd>Enter</kbd> salva</span><span><kbd>Esc</kbd> cancela</span><span><code>+</code> <code>@</code> <code>due:</code> <code>rec:</code> completam</span></div></div>`;
  } else {
    const { desc } = splitTokens(t.tokens);
    h += `<div class="pdesc" ${ro ? '' : 'data-act="edit" title="Clique para editar (e)"'}>${descHtml(desc) || '<i>(sem descrição)</i>'}</div>`;
  }
  h += '</div>';
  if (lost) h += `<div class="pnotice">Esta tarefa mudou fora do Horme enquanto você editava. Versão atual:<div class="rawline" style="margin-top:0.375rem">${esc(t.raw)}</div>`
    + '<button data-act="rebase">Editar a versão atual</button><span>ou <kbd>Enter</kbd> para gravar o seu texto por cima.</span></div>';
  if (ro) h += '<div class="pnotice">Esta linha tem bytes que não são UTF-8. Para não corromper o arquivo, edite num editor de texto.</div>';

  h += `<fieldset class="fieldwrap" ${ed ? 'disabled title="termine a edição do texto primeiro"' : ''}><div class="fields">`;
  const dups = ['due', 't', 'rec'].filter(k => t.tokens.filter(x => x.k === 'kv' && x.key === k).length > 1);
  if (dups.length) h += `<div class="k"></div><div class="v"><div class="note warn">a linha tem mais de um ${dups.map(k => `<code>${k}:</code>`).join(', ')} — vale o primeiro</div></div>`;
  if (t.done) {
    h += `<div class="k">Concluída</div><div class="v"><div>${t.doneDate ? esc(fmtLong(t.doneDate)) : '<span class="note">sem data</span>'}</div>${t.savedPri ? `<div class="note">prioridade original: ${esc(t.savedPri)} (volta ao reabrir)</div>` : ''}</div>`;
    if (t.due) h += `<div class="k">Vencimento</div><div class="v">${esc(t.dueDate ? fmtLong(t.dueDate) : t.due)}</div>`;
    if (t.rec) h += `<div class="k">Recorrência</div><div class="v"><span>${esc(t.recSpec ? recLabel(t.recSpec, t.recDay) : 'inválida')} <code>rec:${esc(t.rec)}</code></span></div>`;
  } else {
    // prioridade
    const more = 'EFGHIJKLMNOPQRSTUVWXYZ'.split('');
    h += `<div class="k">Prioridade</div><div class="v"><div class="pribar" role="group" aria-label="Prioridade">`
      + `<button data-act="pri" data-v="" class="${!t.pri ? 'on' : ''}" ${ro ? 'disabled' : ''} title="sem prioridade">–</button>`
      + ['A', 'B', 'C', 'D'].map(p => `<button data-act="pri" data-v="${p}" class="${t.pri === p ? 'on ' + p.toLowerCase() : ''}" ${ro ? 'disabled' : ''} aria-pressed="${t.pri === p}">${p}</button>`).join('')
      + `<select id="pPriMore" aria-label="Outras prioridades" ${ro ? 'disabled' : ''}><option value="">E–Z</option>${more.map(p => `<option ${t.pri === p ? 'selected' : ''}>${p}</option>`).join('')}</select>`
      + '</div></div>';
    // vencimento
    const dn = t.dueDate ? diffDays(today, t.dueDate) : null;
    h += `<div class="k"><label for="pDue">Vencimento</label></div><div class="v"><div class="row">`
      + `<input type="date" id="pDue" value="${esc(t.dueDate || '')}" ${ro ? 'disabled' : ''}>`
      + `<span class="row quick"><button data-act="due" data-v="0" ${ro ? 'disabled' : ''}>Hoje</button><button data-act="due" data-v="1" ${ro ? 'disabled' : ''}>Amanhã</button><button data-act="due" data-v="7" ${ro ? 'disabled' : ''}>+1 sem</button>${t.due ? `<button data-act="due" data-v="" ${ro ? 'disabled' : ''} title="remover vencimento">✕</button>` : ''}</span></div>`;
    if (t.due && !t.dueDate) h += `<div class="note bad">valor atual inválido: <code>due:${esc(t.due)}</code></div>`;
    else if (dn != null) h += `<div class="note ${dn < 0 ? 'bad' : dn === 0 ? 'warn' : ''}">${esc(fmtLong(t.dueDate))} · ${relDays(dn)}</div>`;
    h += '</div>';
    // disponibilidade
    h += `<div class="k"><label for="pThr">Disponível</label></div><div class="v"><div class="row">`
      + `<input type="text" id="pThr" value="${esc(t.t || '')}" placeholder="2026-11-18 ou -3d" size="12" spellcheck="false" ${ro ? 'disabled' : ''}>`
      + '<span class="row quick">'
      + (t.dueDate ? `<button data-act="thr" data-v="0d" title="só no dia do vencimento">no dia</button><button data-act="thr" data-v="-3d" title="3 dias antes do vencimento">−3d</button><button data-act="thr" data-v="-1w" title="1 semana antes do vencimento">−1 sem</button>` : `<button data-act="thr" data-v="${isoOf(addDays(dateOf(today), 1))}">amanhã</button><button data-act="thr" data-v="${isoOf(addDays(dateOf(today), 7))}">em 1 sem</button>`)
      + (t.t ? '<button data-act="thr" data-v="" title="remover">✕</button>' : '') + '</span></div>';
    if (t.t && !t.tDate) h += `<div class="note ${/^[+-]?\d+[dbwm]$/.test(t.t) ? 'warn' : 'bad'}">${/^[+-]?\d+[dbwm]$/.test(t.t) ? 'relativo, mas a tarefa não tem vencimento nem data de criação: fica sempre visível' : 'valor não reconhecido: a tarefa fica sempre visível'}</div>`;
    else if (t.t) h += `<div class="note">${esc(thrLabel(t, today))}${/^[+-]?\d/.test(t.t) ? ' · acompanha o vencimento' : ''}</div>`;
    else h += '<div class="note">a tarefa fica oculta até essa data (data fixa ou relativa ao vencimento)</div>';
    h += '</div>';
    // recorrência
    const s = t.recSpec;
    const code = s ? `${s.n}${s.unit}` : null;
    const preset = !t.rec ? 'none' : (!s ? 'custom' : (S.recCustom || !PRESETS.some(p => p[0] === code) ? 'custom' : code));
    const strict = s ? s.strict : !!t.dueDate;
    h += `<div class="k"><label for="pRec">Recorrência</label></div><div class="v"><div class="recline">`
      + `<select id="pRec" ${ro ? 'disabled' : ''}>${PRESETS.map(([v, l]) => `<option value="${v}" ${preset === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    if (preset === 'custom') {
      h += `<span>a cada</span><input type="number" id="pRecN" min="1" max="999" value="${s ? s.n : 1}" aria-label="Intervalo">`
        + `<select id="pRecU" aria-label="Unidade">${Object.entries(UNIT).map(([u, l]) => `<option value="${u}" ${(s ? s.unit : 'w') === u ? 'selected' : ''}>${l[1]}</option>`).join('')}</select>`;
    }
    h += '</div>';
    if (t.rec && !s) h += `<div class="note bad"><code>rec:${esc(t.rec)}</code> não é reconhecido: nada será repetido</div>`;
    if (t.rec || preset === 'custom') {
      h += `<div class="radio" role="radiogroup" aria-label="Contar a partir de">`
        + `<label><input type="radio" name="recBase" value="done" ${!strict ? 'checked' : ''} ${ro ? 'disabled' : ''}> contar da conclusão <code>rec:${s ? s.n + s.unit : '1w'}</code></label>`
        + `<label><input type="radio" name="recBase" value="due" ${strict ? 'checked' : ''} ${ro ? 'disabled' : ''}> contar do vencimento anterior <code>rec:+${s ? s.n + s.unit : '1w'}</code></label></div>`;
      if (s && 'my'.includes(s.unit)) {
        const dueDay = t.dueDate ? +t.dueDate.slice(8) : null;
        const opts = [['', 'conforme a soma (pode escorregar)'], ['31', 'sempre no último dia do mês']];
        if (dueDay && dueDay >= 29 && dueDay < 31) opts.push([String(dueDay), `sempre no dia ${dueDay}`]);
        if (t.recDay && !opts.some(o => o[0] === String(t.recDay))) opts.push([String(t.recDay), `sempre no dia ${t.recDay}`]);
        h += `<div class="recline"><label for="pRecDay" class="note">Dia do mês</label><select id="pRecDay" ${ro ? 'disabled' : ''}>`
          + opts.map(([v, l]) => `<option value="${v}" ${String(t.recDay || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('') + '</select></div>';
        if (t.day && !t.recDay) h += `<div class="note bad"><code>day:${esc(t.day)}</code> não é um dia válido (1–31): ignorado</div>`;
        else if (!t.recDay && dueDay >= 29) h += `<div class="note warn">vence no dia ${dueDay}: sem fixar o dia, a data escorrega em meses menores e não volta (31 → 28 → 28…)</div>`;
      } else if (t.day && s) h += `<div class="note warn"><code>day:${esc(t.day)}</code> só vale com recorrência mensal ou anual</div>`;
      const nd = s && nextDue(t, today);
      if (nd) h += `<div class="note">Concluindo hoje, a próxima vence ${esc(fmtLong(nd))}${s.strict && !t.dueDate ? ' (sem vencimento: conta de hoje)' : ''}.</div>`;
    }
    h += '</div>';
  }
  // projetos e contextos
  const tagRow = (list, sigil, id, label, cls) => `<div class="k"><label for="${id}">${label}</label></div><div class="v"><div class="tagedit">`
    + list.map(n => `<span class="tag ${cls}">${sigil}${esc(n)}${ro || t.done ? '' : `<button data-act="untag" data-sigil="${sigil}" data-name="${esc(n)}" aria-label="remover ${sigil}${esc(n)}">✕</button>`}</span>`).join('')
    + (ro || t.done ? (list.length ? '' : '<span class="note">—</span>') : `<span class="ac-wrap"><input id="${id}" placeholder="${sigil} adicionar" spellcheck="false" autocomplete="off"></span>`)
    + '</div></div>';
  h += tagRow(t.projects, '+', 'pAddProj', 'Projetos', 'proj');
  h += tagRow(t.contexts, '@', 'pAddCtx', 'Contextos', 'ctx');
  // outros metadados
  const others = t.tokens.filter(x => (x.k === 'kv' && !['due', 't', 'rec'].includes(x.key) && !(t.done && x.key === 'pri') && !(x.key === 'day' && t.rec && !t.done)) || x.k === 'url');
  if (others.length) {
    h += '<div class="k">Metadados</div><div class="v"><div class="kvlist">' + others.map(x => {
      if (x.k === 'url') { const u = safeUrl(x.v); return `<span class="kk">link</span><span class="vv">${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(x.v)}</a>` : esc(x.v)}</span>`; }
      return `<span class="kk">${esc(x.key)}</span><span class="vv">${esc(x.val)}</span>`;
    }).join('') + '</div></div>';
  }
  h += `<div class="k">Linha</div><div class="v"><details class="rawbox"><summary>como está no todo.txt</summary><div class="rawline">${esc(t.raw)}</div></details></div>`;
  h += '</div></fieldset>';
  if (!ro) {
    h += `<div class="pactions">${ed ? '<button class="primary" data-act="save-edit">Salvar</button><button data-act="cancel-edit">Cancelar</button>' : `<button data-act="edit">Editar texto</button>`}`
      + `<span class="spacer" style="flex:1"></span><button class="danger" data-act="delete">Excluir</button></div>`;
  }
  return h;
}

function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; }

/* ======================================================= autocompletar (+projeto, @contexto, due:, t:, rec:) */
function suggestions(word, forced) {
  const today = dateOf(todayISO());
  const all = tasks();
  const count = field => {
    const m = new Map();
    for (const t of all) for (const n of t[field]) m.set(n, (m.get(n) || 0) + (t.done ? 0.1 : 1));
    return [...m].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  };
  let sig = word[0], q = word.slice(1);
  if (forced) { sig = forced; q = word.replace(/^[+@]/, ''); }
  if (sig === '+' || sig === '@') {
    const nq = norm(q);
    return count(sig === '+' ? 'projects' : 'contexts').filter(n => norm(n).startsWith(nq) && n !== q).slice(0, 8)
      .map(n => ({ label: sig + n, insert: (forced ? '' : sig) + n }));
  }
  const m = /^(due|t|rec):(.*)$/.exec(word);
  if (!m) return [];
  const [, key, val] = m;
  let opts = [];
  if (key === 'due' || key === 't') {
    opts = [['hoje', 0], ['amanhã', 1]].map(([l, n]) => ({ label: l, hint: fmtShort(isoOf(addDays(today, n)), todayISO()), insert: `${key}:${isoOf(addDays(today, n))}` }));
    for (let n = 2; n <= 7; n++) {
      const d = addDays(today, n);
      opts.push({ label: WDL[d.getDay()], hint: fmtShort(isoOf(d), todayISO()), insert: `${key}:${isoOf(d)}` });
    }
    opts.push({ label: 'em 2 semanas', hint: fmtShort(isoOf(addDays(today, 14)), todayISO()), insert: `${key}:${isoOf(addDays(today, 14))}` });
    if (key === 't') opts.push(...[['-1d', '1 dia antes do vencimento'], ['-3d', '3 dias antes do vencimento'], ['-1w', '1 semana antes do vencimento'], ['0d', 'no dia do vencimento']].map(([v, l]) => ({ label: v, hint: l, insert: `t:${v}` })));
  } else {
    opts = [['1d', 'todo dia'], ['1b', 'todo dia útil'], ['1w', 'semanal, da conclusão'], ['+1w', 'semanal, do vencimento'], ['2w', 'quinzenal'],
      ['1m', 'mensal, da conclusão'], ['+1m', 'mensal, do vencimento'], ['1y', 'anual, da conclusão'], ['+1y', 'anual, do vencimento']]
      .map(([v, l]) => ({ label: v, hint: l, insert: `rec:${v}` }));
  }
  const nv = norm(val);
  return opts.filter(o => !nv || norm(o.label).startsWith(nv) || norm(o.insert.split(':')[1]).startsWith(nv)).slice(0, 10);
}

function attachAC(el, forced) {
  if (el._ac) return;
  const box = document.createElement('div');
  box.className = 'ac';
  box.hidden = true;
  box.setAttribute('role', 'listbox');
  el.parentElement.appendChild(box);
  let items = [], idx = -1;
  const word = () => {
    const v = el.value, pos = el.selectionStart ?? v.length;
    let s = pos;
    while (s > 0 && !/\s/.test(v[s - 1])) s--;
    return { s, e: pos, w: v.slice(s, pos) };
  };
  const hide = () => { box.hidden = true; items = []; idx = -1; };
  const show = () => {
    box.innerHTML = items.map((it, n) => `<div role="option" data-n="${n}" class="${n === idx ? 'on' : ''}">${esc(it.label)}${it.hint ? `<span>${esc(it.hint)}</span>` : ''}</div>`).join('');
    box.hidden = !items.length;
  };
  const update = () => {
    const { w } = word();
    items = forced ? suggestions(w || '', forced) : (w.length >= 1 ? suggestions(w) : []);
    if (forced && !w) items = [];
    idx = -1;
    show();
  };
  const pick = it => {
    const { s, e } = word();
    const v = el.value;
    const ins = it.insert + (forced ? '' : ' ');
    el.value = v.slice(0, s) + ins + v.slice(e).replace(/^ /, '');
    const caret = s + ins.length;
    el.setSelectionRange(caret, caret);
    hide();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (forced) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  el.addEventListener('keydown', e => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      idx = idx < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      show(); e.preventDefault(); e.stopImmediatePropagation();
    } else if (e.key === 'Tab' || (e.key === 'Enter' && idx >= 0)) {
      e.preventDefault(); e.stopImmediatePropagation(); pick(items[Math.max(idx, 0)]);
    } else if (e.key === 'Escape') { hide(); e.preventDefault(); e.stopImmediatePropagation(); }
  });
  el.addEventListener('input', e => { if (e.isTrusted) update(); });
  el.addEventListener('blur', () => setTimeout(hide, 150));
  box.addEventListener('mousedown', e => {
    const d = e.target.closest('[data-n]');
    if (d) { e.preventDefault(); pick(items[+d.dataset.n]); }
  });
  el._ac = true;
}

/* ======================================================= servidor */
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  let j = {};
  try { j = await r.json(); } catch { /* corpo vazio */ }
  return { ok: r.ok, status: r.status, j };
}

async function op(body) {
  S.inflight++;
  try {
    const { ok, status, j } = await api('/api/op', body);
    if (j.state) applyState(j.state, true);
    if (!ok) {
      toast(j.error || `erro ${status}`, { bad: true });
      return null;
    }
    return j;
  } catch {
    toast('Sem conexão com o servidor do Horme.', { bad: true });
    return null;
  } finally { S.inflight--; }
}

function applyState(st, own) {
  const prev = S.data;
  if (!own && prev && prev.tasks && st.tasks && st.fp !== prev.fp) {
    const before = new Map();
    for (const t of prev.tasks) before.set(t.raw, (before.get(t.raw) || 0) + 1);
    for (const t of st.tasks) {
      const n = before.get(t.raw) || 0;
      if (n) before.set(t.raw, n - 1); else S.flash.add(t.i);
    }
    const d = new Date();
    S.lastExternal = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    S.pulse = true;
  }
  S.data = st;
  S.fp = st.fp;
  if (S.sel) {
    const t = findTask(S.sel);
    if (t) S.sel = ref(t);
  }
  if (S.archiveOpen && S.view === 'done') loadArchive();
  render();
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const { ok, j } = await api('/api/state');
      if (ok && (j.fp !== S.fp || !S.data || (j.file && S.data.file && j.file.path !== S.data.file.path) || !!j.file !== !!(S.data && S.data.file) || j.undo !== (S.data && S.data.undo))) {
        applyState(j, S.inflight > 0);
      }
    } catch { /* o SSE avisa quando voltar */ } finally { refreshing = null; }
  })();
  return refreshing;
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('change', () => refresh());
  es.onopen = () => { S.conn = 'ok'; refresh(); if (S.data) renderHeader(); };
  es.onerror = () => { S.conn = es.readyState === EventSource.CLOSED ? 'bad' : 'warn'; if (S.data) renderHeader(); };
}

async function loadArchive() {
  const { ok, j } = await api('/api/archive');
  if (ok) { S.archive = j; if (S.view === 'done') renderList(todayISO()); }
}

/* ======================================================= ações */
function selTask() { return selected(); }
function focusSelectedRow() {
  const r = S.rows.find(x => x.dataset.key === S.selKey) || S.rows[S.selPos];
  if (r) { r.focus({ preventScroll: true }); r.scrollIntoView({ block: 'nearest' }); }
}
function select(t, opts = {}) {
  S.sel = t ? ref(t) : null;
  if (opts.key) S.selKey = opts.key;
  else S.selKey = null;
  if (S.editing && (!t || t.raw !== S.editing.raw)) S.editing = null;
  S.recCustom = false;
  renderList(todayISO());
  if (S.panel) renderPanel();
  if (opts.focus !== false) focusSelectedRow();
}
function move(delta) {
  if (!S.rows.length) return;
  let pos = S.rows.findIndex(r => r.dataset.key === S.selKey);
  if (pos < 0) pos = delta > 0 ? -1 : S.rows.length;
  pos = Math.max(0, Math.min(S.rows.length - 1, pos + delta));
  const r = S.rows[pos];
  S.selPos = pos;
  select(tasks().find(t => t.i === +r.dataset.i), { key: r.dataset.key });
}

async function toggleDone(t) {
  if (!t || t.readonly) return;
  const j = await op({ op: t.done ? 'uncomplete' : 'complete', ...ref(t) });
  if (!j) { render(); return; }
  if (t.done) toast('Tarefa reaberta', { undo: true });
  else {
    let msg = 'Concluída';
    if (j.spawned) {
      const nd = /due:(\S+)/.exec(j.spawned);
      msg += nd ? ` · próxima vence ${fmtShort(nd[1], todayISO())}` : ' · próxima criada';
      S.flash.add(j.i + 1);
      renderList(todayISO());
    } else if (j.spawnSkipped) msg += ' · a próxima ocorrência já existia';
    toast(msg, { undo: true });
  }
}
async function deleteTask(t) {
  if (!t || t.readonly) return;
  if (S.editing) S.editing = null;
  if (await op({ op: 'delete', ...ref(t) })) toast('Tarefa excluída', { undo: true });
}
async function setField(t, body, after) {
  const j = await op({ ...body, ...ref(t) });
  if (j && j.raw != null) { S.sel = { i: j.i, raw: j.raw }; render(); }
  if (after) after(j);
  return j;
}
async function undo() {
  if (!S.data || !S.data.undo) { toast('Nada para desfazer'); return; }
  const label = S.data.undo;
  $$('.toast.has-undo').forEach(x => x.remove());
  if (await op({ op: 'undo' })) toast(`Desfeito: ${label}`);
}
function startEdit(t) {
  if (!t || t.readonly) return;
  S.sel = ref(t);
  S.editing = { i: t.i, raw: t.raw, draft: t.raw };
  S.panel = true;
  renderPanel(true);
  const ta = $('#pEdit');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
async function saveEdit() {
  const ed = S.editing;
  if (!ed) return;
  const text = expandDates(ed.draft.replace(/\s*\n\s*/g, ' ').trim());
  if (!text) { toast('A tarefa não pode ficar vazia (use Excluir)', { bad: true }); return; }
  const cur = tasks().find(x => x.raw === ed.raw) || findTask({ i: ed.i, raw: ed.raw });
  if (!cur) return useMine();
  if (text === cur.raw) { S.editing = null; renderPanel(true); focusSelectedRow(); return; }
  const j = await op({ op: 'edit', ...ref(cur), text });
  if (j) {
    S.editing = null;
    S.sel = { i: j.i, raw: j.raw };
    render();
    renderPanel(true);
    focusSelectedRow();
  }
}
async function useMine() {
  const ed = S.editing;
  const j = await op({ op: 'add', text: expandDates(ed.draft.trim()), created: false });
  if (j) { S.editing = null; S.sel = { i: j.i, raw: j.raw }; S.flash.add(j.i); render(); renderPanel(true); }
}

/* ======================================================= adicionar */
function newTaskText(input) {
  let text = expandDates(input.replace(/\s+/g, ' ').trim());
  if (!text) return '';
  if (S.projects.size === 1) { const p = [...S.projects][0]; if (!text.split(' ').includes('+' + p)) text += ' +' + p; }
  if (S.contexts.size === 1) { const c = [...S.contexts][0]; if (!text.split(' ').includes('@' + c)) text += ' @' + c; }
  return withCreated(text);
}
function updatePreview() {
  const v = $('#addInput').value;
  const out = newTaskText(v);
  const el = $('#addPreview');
  el.innerHTML = out && out !== v.trim() ? `<span class="lbl">vai gravar</span>${esc(out)}` : '';
}
async function addTask(e) {
  e.preventDefault();
  const input = $('#addInput');
  const text = newTaskText(input.value);
  if (!text) return;
  const j = await op({ op: 'add', text });
  if (!j) return;
  input.value = '';
  updatePreview();
  S.flash.add(j.i);
  const t = tasks().find(x => x.i === j.i);
  const today = todayISO();
  if (t && !applyFilters(inView(today)).includes(t)) toast('Tarefa adicionada — não aparece nesta visão', { action: { label: 'Mostrar', fn: () => { clearFilters(); S.view = VIEWS.find(v => v.test(t, today))?.id || 'pending'; persist(); render(); } } });
  render();
}

/* ======================================================= filtros */
function clearFilters() { S.projects.clear(); S.contexts.clear(); S.pris.clear(); S.recOnly = false; S.search = ''; $('#search').value = ''; }
function toggleIn(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }
function setView(id) {
  S.view = id;
  if (id === 'done' && S.archiveOpen) loadArchive();
  persist();
  render();
}

/* ======================================================= tema */
function applyTheme() {
  const root = document.documentElement;
  if (S.theme === 'auto') root.removeAttribute('data-theme'); else root.dataset.theme = S.theme;
  const b = $('#themeBtn');
  b.innerHTML = { auto: ICON.auto, light: ICON.sun, dark: ICON.moon }[S.theme];
  const label = { auto: 'Tema: automático', light: 'Tema: claro', dark: 'Tema: escuro' }[S.theme];
  b.title = label + ' (clique para trocar)';
  b.setAttribute('aria-label', b.title);
}

/* ======================================================= avisos */
function toast(msg, opts = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (opts.bad ? ' bad' : '') + (opts.undo ? ' has-undo' : '');
  el.setAttribute('role', opts.bad ? 'alert' : 'status');
  el.innerHTML = `<span class="msg">${esc(msg)}</span>`;
  const action = opts.undo ? { label: 'Desfazer', fn: undo } : opts.action;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.fn(); };
    el.appendChild(b);
  }
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), opts.ms || (action ? 6000 : opts.bad ? 6000 : 2600));
}

/* ======================================================= arquivo (diálogo) */
const SOURCE = {
  arg: 'argumento na linha de comando', TODO_FILE: 'variável $TODO_FILE', TODO_DIR: 'variável $TODO_DIR',
  config: 'configuração do Horme (~/.config/horme/config.json)', cwd: 'todo.txt da pasta onde o Horme foi aberto',
};
function openFileDialog() {
  const f = S.data.file;
  if (!f) return;
  $('#fileBody').innerHTML = `<div class="filegrid">
    <span class="k">todo.txt</span><span class="v mono">${esc(f.path)}${f.real ? `<br><span class="note">→ ${esc(f.real)}</span>` : ''}</span>
    <span class="k">origem</span><span class="v">${esc(SOURCE[f.source] || f.source)}</span>
    <span class="k">done.txt</span><span class="v mono">${esc(f.done)}</span>
    <span class="k">formato</span><span class="v">${plural(tasks().length, 'tarefa', 'tarefas')} · quebras de linha ${esc(f.eol)} · ${f.exists ? (f.writable ? 'gravável' : 'somente leitura') : 'ainda não criado'}</span>
    <span class="k">segurança</span><span class="v">gravação atômica; cópia do arquivo antes de cada alteração em <code>~/.local/state/horme/backups</code></span>
  </div>${f.configurable ? `<div class="k" style="font-size:0.75rem;color:var(--muted);margin-bottom:0.375rem">Trocar de arquivo</div>${pathForm(f.path.replace(/^\/home\/[^/]+/, '~'))}`
    : '<p class="note" style="color:var(--muted);font-size:0.7812rem">Para trocar de arquivo, mude a variável de ambiente ou o argumento e reinicie o Horme.</p>'}`;
  $('#fileDlg').showModal();
}
async function submitPath(form) {
  const err = $('[data-patherr]', form.parentElement);
  const { ok, j } = await api('/api/config', { file: form.file.value });
  if (!ok) { err.textContent = j.error || 'erro'; return; }
  $('#fileDlg').close();
  S.sel = null; closePanel(true);
  applyState(j.state, true);
  toast('Arquivo trocado');
}

/* ======================================================= eventos */
function bind() {
  $('#addForm').addEventListener('submit', addTask);
  const add = $('#addInput');
  attachAC(add);
  add.addEventListener('input', updatePreview);
  add.addEventListener('keydown', e => { if (e.key === 'Escape') { if (add.value) { add.value = ''; updatePreview(); } else { add.blur(); focusSelectedRow(); } } });

  const search = $('#search');
  search.addEventListener('input', () => { S.search = search.value; render(); });
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (search.value) { search.value = ''; S.search = ''; render(); } else { search.blur(); focusSelectedRow(); } }
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); if (S.rows[0]) { const r = S.rows[0]; S.selPos = 0; select(tasks().find(t => t.i === +r.dataset.i), { key: r.dataset.key }); } }
  });

  $('#undoBtn').onclick = undo;
  $('#themeBtn').onclick = () => { S.theme = { auto: 'light', light: 'dark', dark: 'auto' }[S.theme]; persist(); applyTheme(); };
  $('#helpBtn').onclick = () => $('#helpDlg').showModal();
  $('#fileChip').onclick = openFileDialog;
  $('#navToggle').onclick = () => { const s = $('#side'); s.classList.toggle('open'); $('#navToggle').setAttribute('aria-expanded', s.classList.contains('open')); };
  for (const d of $$('dialog')) d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });

  // lateral
  $('#side').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.view) setView(d.view);
    else if (d.proj != null) toggleIn(S.projects, d.proj);
    else if (d.ctx != null) toggleIn(S.contexts, d.ctx);
    else if (d.pri) toggleIn(S.pris, d.pri);
    else if (d.rec) S.recOnly = !S.recOnly;
    else if (d.clear) S[d.clear].clear();
    persist();
    render();
    if (d.view && window.matchMedia('(max-width: 984px)').matches) $('#side').classList.remove('open');
  });

  // barra e filtros ativos
  $('#toolbar').addEventListener('change', e => {
    if (e.target.id === 'groupSel') S.group = e.target.value;
    if (e.target.id === 'sortSel') S.sort = e.target.value;
    persist(); render();
  });
  $('#toolbar').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.density) { S.density = b.dataset.density; persist(); render(); }
    if (b.dataset.act === 'archive') {
      const n = tasks().filter(t => t.done).length;
      if (!confirm(`Mover ${plural(n, 'tarefa concluída', 'tarefas concluídas')} do todo.txt para o done.txt?`)) return;
      const j = await op({ op: 'archive' });
      if (j) { toast(`${plural(j.archived, 'tarefa arquivada', 'tarefas arquivadas')} no done.txt`); S.archive = null; if (S.archiveOpen) loadArchive(); }
    }
  });
  $('#activeFilters').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.unproj != null) S.projects.delete(d.unproj);
    if (d.unctx != null) S.contexts.delete(d.unctx);
    if (d.unpri) S.pris.delete(d.unpri);
    if (d.unrec) S.recOnly = false;
    if (d.unsearch) { S.search = ''; $('#search').value = ''; }
    if (d.clear === 'all') clearFilters();
    persist(); render();
  });

  // lista
  const list = $('#list');
  list.addEventListener('change', e => {
    if (!e.target.classList.contains('chk')) return;
    const row = e.target.closest('.task');
    const t = tasks().find(x => x.i === +row.dataset.i);
    if (t && !row.classList.contains('arch')) { S.sel = ref(t); S.selKey = row.dataset.key; toggleDone(t); }
  });
  list.addEventListener('click', e => {
    if (e.target.closest('a') || e.target.classList.contains('chk')) return;
    const b = e.target.closest('button');
    if (b && b.dataset.toggle) {
      toggleIn(S.collapsed, b.dataset.toggle); persist(); renderList(todayISO()); return;
    }
    if (b && b.dataset.clear === 'all') { clearFilters(); persist(); render(); return; }
    if (b && b.dataset.view) { setView(b.dataset.view); return; }
    const sum = e.target.closest('.archive-box summary');
    if (sum) {
      e.preventDefault();
      S.archiveOpen = !S.archiveOpen;
      if (S.archiveOpen) { S.archive = null; loadArchive(); }
      renderList(todayISO());
      return;
    }
    const row = e.target.closest('.task');
    if (!row || row.classList.contains('arch')) return;
    const t = tasks().find(x => x.i === +row.dataset.i);
    if (!t) return;
    S.selPos = S.rows.indexOf(row);
    S.panel = true;
    select(t, { key: row.dataset.key });
  });
  list.addEventListener('dblclick', e => {
    const row = e.target.closest('.task');
    if (!row || row.classList.contains('arch') || e.target.closest('a, .chk')) return;
    startEdit(tasks().find(x => x.i === +row.dataset.i));
  });

  // painel
  const panel = $('#panel');
  panel.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const t = selTask();
    const act = el.dataset.act, v = el.dataset.v;
    if (act === 'close') return closePanel();
    if (act === 'use-mine') return useMine();
    if (act === 'discard') { S.editing = null; return renderPanel(true); }
    if (act === 'rebase' && t) { S.editing = { i: t.i, raw: t.raw, draft: t.raw }; renderPanel(true); const ta = $('#pEdit'); if (ta) ta.focus(); return; }
    if (!t) return;
    if (act === 'toggle') { e.preventDefault(); return toggleDone(t); }
    if (act === 'edit') return startEdit(t);
    if (act === 'save-edit') return saveEdit();
    if (act === 'cancel-edit') { S.editing = null; renderPanel(true); return focusSelectedRow(); }
    if (act === 'delete') return deleteTask(t);
    if (act === 'pri') return setField(t, { op: 'priority', value: v || null });
    if (act === 'due') return setField(t, { op: 'set', key: 'due', value: v === '' ? null : isoOf(addDays(dateOf(todayISO()), +v)) });
    if (act === 'thr') return setField(t, { op: 'set', key: 't', value: v || null });
    if (act === 'untag') return setField(t, { op: 'tag', sigil: el.dataset.sigil, name: el.dataset.name, remove: true });
  });
  panel.addEventListener('change', e => {
    const t = selTask();
    if (!t) return;
    const id = e.target.id;
    if (id === 'pDue') return scheduleDue(t, e.target.value);
    if (id === 'pThr') return setThreshold(t, e.target.value);
    if (id === 'pPriMore' && e.target.value) return setField(t, { op: 'priority', value: e.target.value });
    if (id === 'pRecDay') return setField(t, { op: 'set', key: 'day', value: e.target.value || null });
    const clearDay = unit => (t.day && !'my'.includes(unit) ? ['day'] : []);  // day: só faz sentido em mensal/anual
    if (id === 'pRec') {
      const v = e.target.value;
      if (v === 'custom') { S.recCustom = true; return renderPanel(true); }
      S.recCustom = false;
      if (v === 'none') return setField(t, { op: 'set', key: 'rec', value: null, clear: t.day ? ['day'] : [] });
      const strict = t.recSpec ? t.recSpec.strict : !!t.dueDate;
      return setField(t, { op: 'set', key: 'rec', value: (strict ? '+' : '') + v, clear: clearDay(v.slice(-1)) });
    }
    if (id === 'pRecN' || id === 'pRecU' || e.target.name === 'recBase') {
      const n = Math.max(1, Math.min(999, parseInt(($('#pRecN') || {}).value || (t.recSpec ? t.recSpec.n : 1), 10) || 1));
      const u = ($('#pRecU') || {}).value || (t.recSpec ? t.recSpec.unit : 'w');
      const base = ($('input[name=recBase]:checked') || {}).value;
      const strict = base ? base === 'due' : (t.recSpec ? t.recSpec.strict : !!t.dueDate);
      return setField(t, { op: 'set', key: 'rec', value: `${strict ? '+' : ''}${n}${u}`, clear: clearDay(u) });
    }
  });
  panel.addEventListener('keydown', e => {
    const t = selTask();
    const id = e.target.id;
    if (id === 'pEdit') {
      if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
      else if (e.key === 'Escape') { e.preventDefault(); S.editing = null; renderPanel(true); focusSelectedRow(); }
      return;
    }
    if (e.key === 'Escape' && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) { e.preventDefault(); e.target.blur(); focusSelectedRow(); return; }
    if (!t) return;
    if (id === 'pThr' && e.key === 'Enter') { e.preventDefault(); setThreshold(t, e.target.value); }
    if ((id === 'pAddProj' || id === 'pAddCtx') && e.key === 'Enter') {
      e.preventDefault();
      const name = e.target.value.trim().replace(/^[+@]/, '');
      if (!name) return;
      setField(t, { op: 'tag', sigil: id === 'pAddProj' ? '+' : '@', name }, j => { if (j) setTimeout(() => { const el = $('#' + id); if (el) el.focus(); }, 0); });
    }
  });
  panel.addEventListener('focusout', e => { if (e.target.id === 'pDue') flushDue(); });
  panel.addEventListener('keydown', e => { if (e.target.id === 'pDue' && e.key === 'Enter') { e.preventDefault(); flushDue(); } }, true);
  panel.addEventListener('input', e => {
    if (e.target.id === 'pEdit' && S.editing) { S.editing.draft = e.target.value.replace(/\n/g, ' '); if (e.target.value.includes('\n')) e.target.value = S.editing.draft; autoGrow(e.target); }
  });

  document.addEventListener('submit', e => {
    if (e.target.matches('[data-pathform]')) { e.preventDefault(); submitPath(e.target); }
  });
  document.addEventListener('keydown', onKey);
  // virada do dia: recalcula vencidas/hoje sem precisar recarregar
  const midnight = () => { const d = new Date(); const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 5); setTimeout(() => { render(); midnight(); }, next - d); };
  midnight();
}

let dueTimer = 0, duePending = null;
function scheduleDue(t, value) {
  clearTimeout(dueTimer);
  if (value && +value.slice(0, 4) < 1900) return;  // ainda digitando o ano
  duePending = () => { duePending = null; if ((t.dueDate || '') !== value) setField(t, { op: 'set', key: 'due', value: value || null }); };
  dueTimer = setTimeout(() => duePending && duePending(), 900);
}
function flushDue() { clearTimeout(dueTimer); if (duePending) duePending(); }

function setThreshold(t, raw) {
  const v = expandDates('t:' + raw.trim()).slice(2);
  if ((t.t || '') === v) return;
  return setField(t, { op: 'set', key: 't', value: v || null });
}

function onKey(e) {
  if ($$('dialog[open]').length) return;
  const tg = e.target;
  const typing = (tg.tagName === 'INPUT' && !['checkbox', 'button'].includes(tg.type)) || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!S.data || !S.data.file) return;
  const t = selTask();
  if (S.chord === 'p') {
    S.chord = null;
    clearTimeout(S.chordTimer);
    if (t && !t.done && /^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); setField(t, { op: 'priority', value: e.key.toUpperCase() }); }
    else if (t && !t.done && ['-', '0', 'Backspace', 'Delete'].includes(e.key)) { e.preventDefault(); setField(t, { op: 'priority', value: null }); }
    return;
  }
  const k = e.key;
  if ((k === 'Enter' || k === ' ') && tg.closest && tg.closest('button, a, summary')) return;
  const act = {
    j: () => move(1), ArrowDown: () => move(1), k: () => move(-1), ArrowUp: () => move(-1),
    Home: () => move(-1e9), End: () => move(1e9),
    Enter: () => { if (t) openPanel(); }, o: () => { if (t) openPanel(); },
    e: () => startEdit(t),
    x: () => toggleDone(t),
    ' ': () => { if (!tg.classList.contains('chk')) toggleDone(t); },
    Delete: () => deleteTask(t), '#': () => deleteTask(t),
    p: () => { if (t && !t.done) { S.chord = 'p'; S.chordTimer = setTimeout(() => { S.chord = null; }, 1500); toast('Prioridade: tecle A–Z, ou − para remover', { ms: 1500 }); } },
    d: () => { if (t && !t.done) openPanel('#pDue'); },
    n: () => $('#addInput').focus(), a: () => $('#addInput').focus(),
    '/': () => $('#search').focus(),
    u: () => undo(),
    v: () => { S.density = S.density === 'compact' ? 'detailed' : 'compact'; persist(); render(); },
    '?': () => $('#helpDlg').showModal(),
    Escape: () => {
      if (S.panel) closePanel();
      else if (S.search) { S.search = ''; $('#search').value = ''; render(); }
      else if ($('#side').classList.contains('open')) $('#side').classList.remove('open');
      else if (S.sel) { S.sel = null; S.selKey = null; render(); }
    },
  }[k] || (/^[1-5]$/.test(k) ? () => setView(VIEWS[+k - 1].id) : null);
  if (act) { e.preventDefault(); act(); }
}

/* ======================================================= início */
applyTheme();
bind();
refresh().then(connect);
