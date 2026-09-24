const express = require('express');
const { getDb } = require('../db/init');
const {
  buildArticleFilter,
  whereSqlFrom,
  parsePagination,
  effectivePage
} = require('./filters');

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;

function countWith(db, extraClauses, filterParams) {
  const clauses = whereSqlFrom(extraClauses);
  const { total } = db
    .prepare(`SELECT COUNT(*) as total FROM articles ${clauses}`)
    .get(...filterParams);
  return total;
}

// GET /api/stats - Single aggregated dashboard summary.
//
// Every number in the response (totals, range articles, trend, popular tags,
// the paginated article list) is derived from one buildArticleFilter() call,
// so switching tag/search/date range can never leave widgets showing results
// from different conditions. Supports the same query params as /api/articles:
// tag, search, start_date, end_date, page, limit.
router.get('/', (req, res) => {
  const db = getDb();

  try {
    const { page: requestedPage, limit } = parsePagination(req.query);
    const filter = buildArticleFilter(req.query);
    const { clauses, params: filterParams } = filter;
    const whereSql = whereSqlFrom(clauses);

    // Totals over the whole table (independent of the selected range).
    const { total: totalArticles } = db
      .prepare('SELECT COUNT(*) as total FROM articles')
      .get();
    const { totalTags } = db
      .prepare(`WITH RECURSIVE split(id, value, rest) AS (
                  SELECT id, '', ifnull(tags, '') || ',' FROM articles
                  WHERE ifnull(tags, '') != ''
                  UNION ALL
                  SELECT id,
                         substr(rest, 1, instr(rest, ',') - 1),
                         substr(rest, instr(rest, ',') + 1)
                  FROM split WHERE rest != ''
                )
                SELECT COUNT(DISTINCT trim(value)) as totalTags
                FROM split WHERE trim(value) != ''`)
      .get();

    // Articles inside the selected range.
    const rangeArticles = countWith(db, clauses, filterParams);

    // "本周新文章" is always the trailing 7 days, regardless of the range,
    // but still honors tag/search filters.
    const oneWeekAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const recentClauses = [
      'datetime(created_at) >= datetime(?)',
      ...filter.baseClauses
    ];
    const recentParams = [oneWeekAgo, ...filter.baseParams];
    const recentArticles = countWith(db, recentClauses, recentParams);

    // Trend: compare the selected range with the immediately preceding
    // period of the same length. Unbounded ranges have no comparable
    // predecessor, so previousPeriodCount is null and percentChange is 0.
    let previousPeriodCount = null;
    let percentChange = 0;
    const startMs = req.query.start_date ? Date.parse(req.query.start_date) : NaN;
    const endMs = req.query.end_date ? Date.parse(req.query.end_date) : NaN;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      // Window duration in whole calendar days, inclusive of both ends.
      // A datetime end lands on its own day, so the span is still endDay-startDay.
      const startDay = new Date(startMs).toISOString().slice(0, 10);
      const endDay = new Date(endMs).toISOString().slice(0, 10);
      const daySpan = Math.round((Date.parse(endDay) - Date.parse(startDay)) / DAY_MS) + 1;
      const lengthMs = daySpan * DAY_MS;

      // The previous window ends the day before this one and spans the same
      // number of calendar days: [start - length, start - 1ms].
      const prevStart = new Date(startMs - lengthMs).toISOString();
      const prevEnd = new Date(startMs - 1).toISOString();

      // Keep tag/search filters but swap the date window for the previous
      // period, so parameter binding stays aligned with clause order.
      const prevClauses = [
        ...filter.baseClauses,
        'datetime(created_at) >= datetime(?)',
        'datetime(created_at) <= datetime(?)'
      ];
      const prevParams = [...filter.baseParams, prevStart, prevEnd];
      previousPeriodCount = countWith(db, prevClauses, prevParams);
      percentChange = previousPeriodCount > 0
        ? Math.round(((rangeArticles - previousPeriodCount) / previousPeriodCount) * 100)
        : (rangeArticles > 0 ? 100 : 0);
    }

    // Articles per day within the selected range (for the trend summary).
    const dailyRows = db
      .prepare(`SELECT date(created_at) as date, COUNT(*) as count
                FROM articles ${whereSql}
                GROUP BY date(created_at)
                ORDER BY date ASC`)
      .all(...filterParams);
    const dailyCounts = dailyRows.map(row => ({ date: row.date, count: row.count }));

    // Popular tags within the selected range, counted in SQL instead of
    // pulling up to a fixed page of rows into the browser.
    const popularTags = db
      .prepare(`WITH RECURSIVE split(id, value, rest) AS (
                  SELECT id, '', ifnull(tags, '') || ',' FROM articles ${whereSql}
                  UNION ALL
                  SELECT id,
                         substr(rest, 1, instr(rest, ',') - 1),
                         substr(rest, instr(rest, ',') + 1)
                  FROM split WHERE rest != ''
                )
                SELECT trim(value) as tag, COUNT(DISTINCT id) as count
                FROM split
                WHERE trim(value) != ''
                GROUP BY trim(value)
                ORDER BY count DESC, tag ASC
                LIMIT 10`)
      .all(...filterParams);

    // The article list itself: same filter, clamped pagination.
    const totalPages = Math.ceil(rangeArticles / limit);
    const page = effectivePage(requestedPage, totalPages);
    const offset = (page - 1) * limit;
    const articles = db
      .prepare(`SELECT id, title, summary, tags, created_at, updated_at
                FROM articles ${whereSql}
                ORDER BY datetime(created_at) DESC, id DESC
                LIMIT ? OFFSET ?`)
      .all(...filterParams, limit, offset);
    const parsedArticles = articles.map(article => ({
      ...article,
      tags: article.tags ? article.tags.split(',').map(t => t.trim()) : []
    }));

    res.json({
      totalArticles,
      totalTags,
      rangeArticles,
      recentArticles,
      previousPeriodCount,
      percentChange,
      dailyCounts,
      popularTags,
      articles: parsedArticles,
      pagination: {
        total: rangeArticles,
        page,
        requestedPage,
        limit,
        totalPages
      },
      filter: {
        tag: req.query.tag || null,
        search: req.query.search || null,
        start_date: req.query.start_date || null,
        end_date: req.query.end_date || null
      }
    });
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    const error = err.status ? err.message : 'Failed to fetch stats';
    res.status(status).json({ error });
  }
});

module.exports = router;
