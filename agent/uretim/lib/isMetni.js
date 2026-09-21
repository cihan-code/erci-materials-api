'use strict';

// Turns scheduled operations into the sentence a foreman actually reads:
// "Kumaş ve yaka ribanası kesilecek", "Dikim sürüyor", "Baskıya bırakılacak".
//
// The rota labels are nominalised ("Kumaşın kesimi", "Dikime bırakılması") because
// they name a step in a route. On a daily sheet the same step has to read as work
// to be done today, which is what this module produces. It rewrites nothing else:
// the operation set, its parts and its dates all come from the scheduler.

// Base phrasing per operation. A multi-day operation gets its tense from the span.
const EYLEM = {
  fabric_order: 'Kumaş siparişi geçilecek',
  fabric_arrival: 'Kumaş atölyeye gelecek',
  cut_main: 'Kumaş kesilecek',
  cut_extra_parts: null,          // built from the parts being cut
  print_dropoff: 'Baskıya bırakılacak',
  print_work: 'Baskı yapılacak',
  embroidery_dropoff: 'Nakışa bırakılacak',
  embroidery_work: 'Nakış yapılacak',
  sewing_dropoff: 'Dikime bırakılacak',
  sewing: 'Dikilecek',
  buttonhole_button: 'İlik ve düğme yapılacak',
  iron_pack: 'Ütü ve paketleme yapılacak',
  delivery: 'Teslim edilecek',
};

// Operations that can run over several days; only these get a tense.
const SUREKLI = {
  print_work: ['Baskı başlayacak', 'Baskı sürüyor', 'Baskı bugün bitiyor'],
  embroidery_work: ['Nakış başlayacak', 'Nakış sürüyor', 'Nakış bugün bitiyor'],
  sewing: ['Dikim başlayacak', 'Dikim sürüyor', 'Dikim bugün bitiyor'],
};

function kucult(s) {
  return s ? s.charAt(0).toLocaleLowerCase('tr-TR') + s.slice(1) : s;
}

// "Kaşkorse (etek ve kol)" + "Kapüşon astarı" -> "kaşkorse (etek ve kol) ve kapüşon astarı"
function parcaListesi(parts) {
  const list = (parts || []).map(kucult);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(', ') + ' ve ' + list[list.length - 1];
}

// One operation -> one phrase. `today` decides the tense of a multi-day operation.
function opEylemi(op, today) {
  if (op.op_id === 'cut_extra_parts') {
    const parcalar = parcaListesi(op.parts);
    return parcalar ? parcalar.charAt(0).toLocaleUpperCase('tr-TR') + parcalar.slice(1) + ' kesilecek'
      : 'Ek parça kesilecek';
  }

  const asama = SUREKLI[op.op_id];
  if (asama && op.start && op.end && op.start !== op.end) {
    if (op.start === today) return asama[0];
    if (op.end === today) return asama[2];
    return asama[1];
  }

  if (op.op_id === 'buttonhole_button' && op.label && op.label !== 'İlik ve düğme') {
    // e.g. "Kapüşonda ilik açılması (kordon için)" -> "Kapüşonda ilik açılacak (kordon için)"
    return op.label.replace('açılması', 'açılacak');
  }

  return EYLEM[op.op_id] || op.label || op.op_id;
}

// All of one job's operations at one station, today, as a single sentence.
// Cutting is the common case: the main fabric and the extra parts are cut together,
// so they read as one instruction rather than two lines.
function gunlukIs(ops, today) {
  const ids = ops.map((o) => o.op_id);

  if (ids.indexOf('cut_main') !== -1 && ids.indexOf('cut_extra_parts') !== -1) {
    const extra = ops.filter((o) => o.op_id === 'cut_extra_parts');
    const parcalar = parcaListesi([].concat.apply([], extra.map((o) => o.parts || [])));
    return parcalar ? 'Kumaş ve ' + parcalar + ' kesilecek' : 'Kumaş kesilecek';
  }

  const seen = [];
  ops.forEach((o) => {
    const t = opEylemi(o, today);
    if (seen.indexOf(t) === -1) seen.push(t);
  });
  return seen.join(' · ');
}

// Optional parts that are only being cut because somebody confirmed them - the
// foreman needs the reminder, the standard parts speak for themselves.
function onaylananParcaNotu(ops) {
  const onayli = [];
  ops.forEach((o) => (o.confirmed_parts || []).forEach((p) => {
    if (onayli.indexOf(p) === -1) onayli.push(p);
  }));
  if (!onayli.length) return null;
  return onayli.join(' ve ') + ' kesilecek';
}

module.exports = { gunlukIs, opEylemi, onaylananParcaNotu, parcaListesi };
