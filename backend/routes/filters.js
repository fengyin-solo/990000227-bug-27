// Shared query-condition builder so that the article list, counts and the
// dashboard summary always run against exactly the same filters.

const MAX_LIMIT = 100;

function isValidDate(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

/**
 * Build WHERE clauses + bound parameters from the common query params:
 * tag, search, start_date, end_date.
 *
 * Dates are compared through SQLite's datetime(), which understands both the
 * ISO-8601 strings written by the API ("2026-09-24T03:00:00.000Z") and the
 * "YYYY-MM-DD HH:MM:SS" values produced by CURRENT_TIMESTAMP.
 *
 * Returns non-date clauses/params separately so callers (e.g. the stats
 * trend comparison) can reuse tag/search filters while swapping the window.
 */
function buildArticleFilter(query = {}) {
  const clauses = [];
  const params = [];
  const dateClauses = [];
  const dateParams = [];

  if (query.tag) {
    clauses.push(`',' || tags || ',' LIKE ?`);
    params.push(`%,${query.tag},%`);
  }

  if (query.search) {
    clauses.push(`(title LIKE ? OR summary LIKE ?)`);
    const searchTerm = `%${query.search}%`;
    params.push(searchTerm, searchTerm);
  }

  if (query.start_date !== undefined && query.start_date !== '') {
    if (!isValidDate(query.start_date)) {
      const error = new Error('start_date is invalid');
      error.status = 400;
      throw error;
    }
    dateClauses.push(`datetime(created_at) >= datetime(?)`);
    dateParams.push(query.start_date);
  }

  if (query.end_date !== undefined && query.end_date !== '') {
    if (!isValidDate(query.end_date)) {
      const error = new Error('end_date is invalid');
      error.status = 400;
      throw error;
    }
    // Inclusive upper bound: a date-only end_date covers the whole day.
    const endValue = /^\d{4}-\d{2}-\d{2}$/.test(query.end_date)
      ? `${query.end_date} 23:59:59`
      : query.end_date;
    dateClauses.push(`datetime(created_at) <= datetime(?)`);
    dateParams.push(endValue);
  }

  const startMs = Date.parse(query.start_date);
  const endMs = Date.parse(query.end_date);
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs > endMs) {
    const error = new Error('start_date must not be later than end_date');
    error.status = 400;
    throw error;
  }

  const allClauses = [...clauses, ...dateClauses];
  const allParams = [...params, ...dateParams];

  return {
    clauses: allClauses,
    params: allParams,
    baseClauses: clauses,
    baseParams: params,
    dateClauses,
    dateParams
  };
}

function whereSqlFrom(clauses) {
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

// Parse pagination params with sane defaults and bounds. Out-of-range pages
// are reported back to the caller, which clamps the effective page against
// the real total so over-paginated views (e.g. after deleting the last item
// on the last page) never end up showing an empty list with a stale total.
function parsePagination(query = {}) {
  const requestedPage = Number.parseInt(query.page, 10);
  const requestedLimit = Number.parseInt(query.limit, 10);

  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_LIMIT)
    : 10;

  return { page, limit, maxLimit: MAX_LIMIT };
}

// Clamp the requested page into [1, totalPages] once the total is known.
function effectivePage(page, totalPages) {
  if (totalPages <= 0) return 1;
  return Math.min(Math.max(page, 1), totalPages);
}

module.exports = {
  MAX_LIMIT,
  buildArticleFilter,
  whereSqlFrom,
  parsePagination,
  effectivePage
};
