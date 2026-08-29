// Model yanitindan JSON ayikla - ```json``` citi, prose on ek, veya kesik yanit olsa bile.
// document.js (Vision) ve sdr/* (arastirma/mail) ayni ihtiyaci paylasiyor - tek kaynak.

// metinden JSON ayikla (```json ... ``` cit veya prose ile gelse bile)
function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```\s*(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  else t = t.replace(/^\s*```\s*(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim(); // tek tarafli cit
  if (t[0] !== '{') {
    const i = t.indexOf('{'); const j = t.lastIndexOf('}');
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
  }
  return JSON.parse(t);
}

// Acik string/parantezleri kapat (kesik JSON icin).
function closeJson(s) {
  let inStr = false; let esc = false; const st = [];
  for (const c of s) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') st.push('}');
    else if (c === '[') st.push(']');
    else if (c === '}' || c === ']') st.pop();
  }
  let out = s;
  if (inStr) out += '"';
  while (st.length) out += st.pop();
  return out;
}

// Kesik/bozuk model yanitini onar: ilk {'den basla, en uzun gecerli deger sinirina kadar
// kes, kapanmamis parantezleri kapat. Basarisizsa null.
function tryRepairJson(raw) {
  let t = String(raw || '').replace(/^\s*```\s*(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = t.indexOf('{');
  if (start < 0) return null;
  t = t.slice(start);
  if (t.length > 200000) t = t.slice(0, 200000);

  const bounds = [];
  let inStr = false; let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') { inStr = false; bounds.push(i + 1); }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') continue;
    if (c === '}' || c === ']') { bounds.push(i + 1); continue; }
    if (/[0-9tfn-]/.test(c) && !/[a-z0-9_]/i.test(t[i - 1] || '')) {
      const m = t.slice(i).match(/^(-?\d[\d.eE+-]*|true|false|null)/);
      if (m) { bounds.push(i + m[0].length); i += m[0].length - 1; }
    }
  }
  for (let b = bounds.length - 1; b >= 0; b--) {
    const s = closeJson(t.slice(0, bounds[b]).replace(/\s*,\s*$/, ''));
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (e) { /* sonraki sinir */ }
  }
  return null;
}

// parse + basarisizsa repair. Ikisi de olmazsa hata.
function parseModelJson(text, label) {
  try { return parseJsonLoose(text); }
  catch (e) {
    const r = tryRepairJson(text);
    if (r) return r;
    throw new Error((label || 'Model yanıtı') + ' JSON olarak ayrıştırılamadı: ' + String(text).slice(0, 300));
  }
}

module.exports = { parseJsonLoose, closeJson, tryRepairJson, parseModelJson };
