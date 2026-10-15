// Reads athlete lists pasted from Excel / Google Sheets (tab-separated) or CSV files.

export function parseTable(text) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  const delim = first.includes('\t') ? '\t'
    : first.split(';').length > first.split(',').length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell.trim() === '') { q = true; cell = ''; }
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c));
}

const isNumberish = s => /^#?\d+[a-z]?$/i.test(String(s || '').trim());
const cleanBib = s => String(s || '').trim().replace(/^#/, '');

export function mapColumns(rows) {
  const H = rows[0].map(c => c.toLowerCase().replace(/[^a-z0-9# ]/g, ' ').replace(/\s+/g, ' ').trim());
  const find = re => H.findIndex(h => re.test(h));
  const hasHeader = H.some(h => /\b(name|athlete|competitor|participant|bib|division|first|last)\b/.test(h));

  let idx;
  if (hasHeader) {
    idx = {
      name: find(/^(name|full name|athlete|athlete name|competitor|competitor name|participant|participant name|ninja|ninja name)$/),
      first: find(/^(first|first name|firstname|given name)$/),
      last: find(/^(last|last name|lastname|surname|family name)$/),
      bib: find(/^(bib|bib number|bib no|bib #|number|no|#|num|race number)$/),
      div: find(/^(division|div|class|category|age group|agegroup|level|group)$/),
      flight: find(/^(flight|flight number|flight no|flight #|flt|heat|wave)$/),
    };
    if (idx.name < 0 && idx.first < 0) {
      idx.name = find(/name/); // e.g. "Athlete's Name"
      if (idx.name < 0) return { error: "Couldn't find a Name column. Add a header row with a column called Name (or First Name and Last Name)." };
    }
    rows = rows.slice(1);
  } else {
    // No header: [bib,] name [, division [, flight]]
    const r0 = rows[0];
    if (r0.length >= 2 && isNumberish(r0[0])) idx = { bib: 0, name: 1, div: r0.length > 2 ? 2 : -1, flight: r0.length > 3 ? 3 : -1, first: -1, last: -1 };
    else if (r0.length >= 2 && isNumberish(r0[1])) idx = { name: 0, bib: 1, div: r0.length > 2 ? 2 : -1, flight: r0.length > 3 ? 3 : -1, first: -1, last: -1 };
    else idx = { name: 0, bib: -1, div: r0.length > 1 ? 1 : -1, flight: -1, first: -1, last: -1 };
  }

  const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
  const records = rows.map(r => {
    let name = get(r, idx.name);
    if (!name && (idx.first >= 0 || idx.last >= 0)) name = [get(r, idx.first), get(r, idx.last)].filter(Boolean).join(' ');
    return { name: name.replace(/\s+/g, ' '), bib: cleanBib(get(r, idx.bib)), division: get(r, idx.div), flight: get(r, idx.flight) };
  });

  const found = [
    idx.name >= 0 ? 'Name' : idx.first >= 0 ? 'First + Last name' : null,
    idx.bib >= 0 ? 'Bib' : null,
    idx.div >= 0 ? 'Division' : null,
    idx.flight >= 0 ? 'Flight' : null,
  ].filter(Boolean).join(', ') + (hasHeader ? '' : ' (no header row, guessed by position)');

  return { records, found };
}
