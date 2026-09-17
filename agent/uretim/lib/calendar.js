'use strict';

// Working-day arithmetic for the production scheduler.
//
// A day carries a "factor": the fraction of a full working day available.
// Saturday is a half day for everyone EXCEPT the sewing workshop, which works
// a full Saturday - that is expressed in rota.json as calendar.overrides.sewing.
//
// All dates are ISO strings (YYYY-MM-DD) handled in UTC so there is no DST drift.

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MS_PER_DAY = 86400000;

function assertISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) {
    throw new Error('Tarih YYYY-MM-DD olmalı: ' + iso);
  }
  return iso;
}

function toDate(iso) {
  return new Date(assertISO(iso) + 'T00:00:00Z');
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, n) {
  return toISO(new Date(toDate(iso).getTime() + n * MS_PER_DAY));
}

function diffDays(fromISO, toISOStr) {
  return Math.round((toDate(toISOStr) - toDate(fromISO)) / MS_PER_DAY);
}

function dayName(iso) {
  return DAY_NAMES[toDate(iso).getUTCDay()];
}

// Fraction of a full working day available on `iso` for operation `opId`.
// opId is optional; when given, calendar.overrides[opId] wins over the default.
function dayFactor(calendar, iso, opId) {
  const name = dayName(iso);
  const overrides = (calendar && calendar.overrides) || {};
  if (opId && overrides[opId] && overrides[opId][name] !== undefined) {
    return overrides[opId][name];
  }
  const working = (calendar && calendar.working_days) || {};
  return working[name] === undefined ? 1 : working[name];
}

function isWorkingDay(calendar, iso, opId) {
  return dayFactor(calendar, iso, opId) > 0;
}

// First day at or after `iso` on which `opId` can do any work.
function nextWorkingDay(calendar, iso, opId) {
  let cur = assertISO(iso);
  for (let guard = 0; guard < 400; guard++) {
    if (isWorkingDay(calendar, cur, opId)) return cur;
    cur = addDays(cur, 1);
  }
  throw new Error('nextWorkingDay: çalışma günü bulunamadı (' + iso + ')');
}

// Consume `workDays` full-day-equivalents of effort starting at `startISO`.
// Returns { start, end } - both the first day worked and the day the work finishes.
// A 1-day task started on a Saturday (factor 0.5) spills into Monday.
function addWorkDays(calendar, startISO, workDays, opId) {
  const start = nextWorkingDay(calendar, startISO, opId);
  if (!(workDays > 0)) return { start, end: start };

  let remaining = workDays;
  let cur = start;
  for (let guard = 0; guard < 2000; guard++) {
    const factor = dayFactor(calendar, cur, opId);
    if (factor > 0) {
      remaining -= factor;
      if (remaining <= 1e-9) return { start, end: cur };
    }
    cur = addDays(cur, 1);
  }
  throw new Error('addWorkDays: sonlanmadı (' + startISO + ', ' + workDays + ')');
}

module.exports = {
  DAY_NAMES,
  addDays,
  diffDays,
  dayName,
  dayFactor,
  isWorkingDay,
  nextWorkingDay,
  addWorkDays,
  toISO,
};
