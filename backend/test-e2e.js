const assert = require('assert');
const { getDb } = require('./db/init');
const { buildArticleFilter } = require('./routes/filters');

const db = getDb();
const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Isolated fixtures: tagged E2E so seed articles sharing the same dates
// never influence the assertions.
db.prepare("DELETE FROM articles WHERE title LIKE 'E2E %'").run();
db.prepare("DELETE FROM articles WHERE title = 'E2E legacy fmt'").run();
const insert = db.prepare(
  "INSERT INTO articles (title, body, summary, tags, created_at, updated_at) VALUES (?,?,?,?,?,?)"
);
const fixtureDays = [];
for (let i = 0; i < 12; i++) {
  const t = iso(now - i * DAY);
  fixtureDays[i] = t.slice(0, 10);
  insert.run(`E2E article ${i}`, 'body', '', i % 2 === 0 ? 'E2E,Shared' : 'E2E', t, t);
}

const api = (path) => fetch('http://localhost:3001/api' + path).then(async r => ({ status: r.status, body: await r.json() }));

(async () => {
  const start = fixtureDays[5], end = fixtureDays[1]; // i=1..5 -> 5 E2E rows
  const q = `tag=E2E&start_date=${start}&end_date=${end}`;

  // 1. /stats and /articles must return identical totals under one condition.
  const s1 = await api(`/stats?${q}&limit=2`);
  const a1 = await api(`/articles?${q}`);
  assert.strictEqual(s1.status, 200);
  assert.strictEqual(s1.body.rangeArticles, 5, 'stats rangeArticles');
  assert.strictEqual(a1.body.pagination.total, s1.body.rangeArticles, 'list/stats total agree');
  assert.strictEqual(s1.body.articles.length, 2, 'stats page size honored');
  assert.strictEqual(s1.body.pagination.totalPages, 3, 'stats totalPages');

  // 2. Trend vs previous equal-length window (i=6..10 -> 5).
  assert.strictEqual(s1.body.previousPeriodCount, 5, 'previous period count');
  assert.strictEqual(s1.body.percentChange, 0, 'flat trend');

  // 3. Popular tags computed from the SAME range (E2E=5; Shared for even i in 1..5: i=2,4 -> 2).
  const tagCounts = Object.fromEntries(s1.body.popularTags.map(t => [t.tag, t.count]));
  assert.strictEqual(tagCounts['E2E'], 5, 'popular tag E2E in range');
  assert.strictEqual(tagCounts['Shared'], 2, 'popular tag Shared in range');

  // 3b. Popular tags must reflect the range: widen to i=1..11 -> Shared for even i 2,4,6,8,10 -> 5.
  const s1b = await api(`/stats?tag=E2E&start_date=${fixtureDays[11]}&end_date=${end}`);
  const tagCountsB = Object.fromEntries(s1b.body.popularTags.map(t => [t.tag, t.count]));
  assert.strictEqual(tagCountsB['Shared'], 5, 'popular tags change with range');

  // 4. Empty range: every widget empties together, page clamps to 1.
  const s2 = await api('/stats?tag=E2E&start_date=2020-01-01&end_date=2020-01-31&page=3');
  assert.strictEqual(s2.body.rangeArticles, 0);
  assert.strictEqual(s2.body.articles.length, 0);
  assert.deepStrictEqual(s2.body.popularTags, []);
  assert.deepStrictEqual(s2.body.dailyCounts, []);
  assert.strictEqual(s2.body.pagination.page, 1);
  assert.strictEqual(s2.body.pagination.totalPages, 0);

  const a2e = await api('/articles?tag=E2E&start_date=2020-01-01&end_date=2020-01-31&page=3');
  assert.strictEqual(a2e.body.articles.length, 0);
  assert.strictEqual(a2e.body.pagination.page, 1);

  // 5. Page beyond last page clamps server-side.
  const a2 = await api('/articles?page=999&limit=10');
  assert.strictEqual(a2.body.pagination.requestedPage, 999);
  assert.strictEqual(a2.body.pagination.page, a2.body.pagination.totalPages);
  assert.ok(a2.body.articles.length > 0);

  // 6. Limit cap.
  assert.strictEqual((await api('/articles?limit=10000')).body.pagination.limit, 100);
  assert.strictEqual((await api('/stats?limit=10000')).body.pagination.limit, 100);

  // 7. Invalid params -> 400 on both endpoints.
  assert.strictEqual((await api('/articles?start_date=banana')).status, 400);
  assert.strictEqual((await api('/stats?start_date=2026-09-20&end_date=2026-09-01')).status, 400);

  // 8. Date-only end includes the whole end day.
  const today = iso(now).slice(0, 10);
  const s3 = await api(`/stats?tag=E2E&start_date=${today}&end_date=${today}`);
  assert.strictEqual(s3.body.rangeArticles, 1, 'end day inclusive');

  // 9. "本周新文章" computed from dates, not from a capped page of rows.
  //    Fixtures use whole-day offsets; the trailing 7d window includes the
  //    seven calendar days up to today.
  const s4 = await api('/stats?tag=E2E');
  assert.strictEqual(s4.body.recentArticles >= 7, true, 'trailing week covers at least 7 days');
  const boundaryDay = iso(now - 7 * DAY).slice(0, 10);
  const onBoundary = await api(`/articles?tag=E2E&start_date=${boundaryDay}&end_date=${boundaryDay}`);
  assert.ok(onBoundary.body.pagination.total >= 1, 'boundary-day fixture exists');

  // 10. Filter builder parameter grouping.
  const f = buildArticleFilter({ tag: 'E2E', start_date: '2026-09-01', end_date: '2026-09-10' });
  assert.strictEqual(f.clauses.length, 3);
  assert.strictEqual(f.baseParams.length, 1);
  assert.strictEqual(f.dateParams.length, 2);
  assert.ok(f.dateParams[1].endsWith('23:59:59'));

  // 11. Legacy space-separated datetime remains comparable.
  db.prepare("INSERT INTO articles (title, body, tags, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run('E2E legacy fmt', 'body', 'Legacy', '2026-09-05 12:00:00', '2026-09-05 12:00:00');
  const a4 = await api('/articles?start_date=2026-09-05&end_date=2026-09-05&tag=Legacy');
  assert.strictEqual(a4.body.pagination.total, 1, 'space-separated datetime filtered');

  // 12. Rising trend: single-day window today vs yesterday (1 vs 1 => 0);
  //     pick i=0 only window vs previous empty => +100.
  const s5 = await api(`/stats?tag=E2E&start_date=${fixtureDays[0]}&end_date=${fixtureDays[0]}`);
  assert.strictEqual(s5.body.previousPeriodCount, 1);
  assert.strictEqual(s5.body.percentChange, 0);

  db.prepare("DELETE FROM articles WHERE title LIKE 'E2E %'").run();
  db.prepare("DELETE FROM articles WHERE title = 'E2E legacy fmt'").run();
  console.log('ALL BACKEND ASSERTIONS PASSED');
})().catch(e => {
  db.prepare("DELETE FROM articles WHERE title LIKE 'E2E %'").run();
  db.prepare("DELETE FROM articles WHERE title = 'E2E legacy fmt'").run();
  console.error('FAILED:', e.message);
  process.exit(1);
});
