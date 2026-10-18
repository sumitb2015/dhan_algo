import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommits, groupByDay, countUnread, latestDate, hrefForScope,
} from './releaseNotes.ts';

const rec = (hash: string, date: string, subject: string, body = '') =>
  `${hash}\x1f${date}\x1f${subject}\x1f${body}\x1e\n`;

const RAW =
  rec('a1', '2026-10-18T08:33:41+05:30', 'docs: add TODO') +
  rec('b2', '2026-10-18T00:33:00+05:30', 'feat(focus-tool): add re-entry', 'Line one\n\nCo-Authored-By: X <x@y>') +
  rec('c3', '2026-10-17T22:58:16+05:30', 'fix(copy-trade): proportional exits') +
  rec('d4', '2026-10-17T10:00:00+05:30', 'feat(skills): new skill') +
  rec('e5', '2026-10-17T09:00:00+05:30', "Merge branch 'x'") +
  rec('f6', '2026-10-16T09:00:00+05:30', '﻿perf(options): faster chain');

test('parseCommits keeps feat/fix/perf and drops the rest', () => {
  const notes = parseCommits(RAW);
  assert.deepEqual(notes.map((n) => n.hash), ['b2', 'c3', 'f6']);
  assert.deepEqual(notes.map((n) => n.type), ['new', 'fix', 'perf']);
});

test('parseCommits strips BOM, trailers and maps scope to a page', () => {
  const [first] = parseCommits(RAW);
  assert.equal(first.href, '/focus-tool');
  assert.equal(first.detail, 'Line one');
  assert.equal(parseCommits(RAW)[2].subject, 'faster chain');
});

test('unknown scope has no link; empty input is safe', () => {
  assert.equal(hrefForScope('copy-trade'), null);
  assert.equal(hrefForScope(null), null);
  assert.deepEqual(parseCommits(''), []);
});

test('groupByDay uses the commit calendar date', () => {
  const days = groupByDay(parseCommits(RAW));
  assert.deepEqual(days.map((d) => [d.day, d.notes.length]), [
    ['2026-10-18', 1], ['2026-10-17', 1], ['2026-10-16', 1],
  ]);
});

test('countUnread counts only strictly newer notes; null means none', () => {
  const notes = parseCommits(RAW);
  assert.equal(countUnread(notes, null), 0);
  assert.equal(countUnread(notes, 'garbage'), 0);
  assert.equal(countUnread(notes, '2026-10-17T22:58:16+05:30'), 1);
  assert.equal(countUnread(notes, '2026-10-01T00:00:00Z'), 3);
});

test('latestDate returns the newest commit date', () => {
  assert.equal(latestDate(parseCommits(RAW)), '2026-10-18T00:33:00+05:30');
  assert.equal(latestDate([]), null);
});
