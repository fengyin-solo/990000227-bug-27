const express = require('express');
const { getDb } = require('../db/init');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const TOP_TAGS_LIMIT = 10;

// Build the shared WHERE clause and params from query filters.
// Used by the list, count and stats queries so they always agree on
// the same conditions (single source of truth for filtering).
function buildArticleFilters(query) {
  const whereClauses = [];
  const params = [];

  const tag = query.tag || null;
  const search = query.search || null;
  const from = query.from || null;
  const to = query.to || null;

  if (tag) {
    whereClauses.push(`',' || tags || ',' LIKE ?`);
    params.push(`%,${tag},%`);
  }

  if (search) {
    whereClauses.push(`(title LIKE ? OR summary LIKE ?)`);
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm);
  }

  if (from) {
    whereClauses.push(`date(created_at) >= date(?)`);
    params.push(from);
  }

  if (to) {
    whereClauses.push(`date(created_at) <= date(?)`);
    params.push(to);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  return { whereSql, params };
}

function parseTags(tagsStr) {
  return tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];
}

// GET /api/articles - List articles with pagination, tag filter, search and date range
router.get('/', (req, res) => {
  const db = getDb();
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;

  const { whereSql, params } = buildArticleFilters(req.query);

  const countQuery = `SELECT COUNT(*) as total FROM articles ${whereSql}`;
  const articlesQuery = `SELECT id, title, summary, tags, created_at, updated_at FROM articles ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;

  try {
    const { total } = db.prepare(countQuery).get(...params);
    const articles = db.prepare(articlesQuery).all(...params, limit, offset);

    const parsedArticles = articles.map(article => ({
      ...article,
      tags: parseTags(article.tags)
    }));

    res.json({
      articles: parsedArticles,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// GET /api/articles/stats - Server-side aggregation over the same filters
// (registered before /:id so "stats" is not treated as an article id)
router.get('/stats', (req, res) => {
  const db = getDb();
  const { whereSql, params } = buildArticleFilters(req.query);

  try {
    const { total } = db.prepare(
      `SELECT COUNT(*) as total FROM articles ${whereSql}`
    ).get(...params);

    // Trend summary: articles per day within the filtered set
    const trend = db.prepare(
      `SELECT date(created_at) as date, COUNT(*) as count FROM articles ${whereSql} GROUP BY date(created_at) ORDER BY date ASC`
    ).all(...params);

    // Articles created in the last 7 days, within the filtered set
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const recentWhere = whereSql
      ? `${whereSql} AND created_at >= ?`
      : `WHERE created_at >= ?`;
    const { recent } = db.prepare(
      `SELECT COUNT(*) as recent FROM articles ${recentWhere}`
    ).get(...params, weekAgo);

    // Tag distribution within the filtered set
    const tagRows = db.prepare(
      `SELECT tags FROM articles ${whereSql}`
    ).all(...params);
    const tagCounts = new Map();
    tagRows.forEach(row => {
      parseTags(row.tags).forEach(tag => {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });
    });
    const topTags = Array.from(tagCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, TOP_TAGS_LIMIT);

    res.json({
      totalArticles: total,
      totalTags: tagCounts.size,
      recentArticles: recent,
      trend,
      topTags
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch article stats' });
  }
});

// GET /api/articles/:id - Get single article
router.get('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  try {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.json({
      ...article,
      tags: parseTags(article.tags)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

// POST /api/articles - Create article (requires auth)
router.post('/', authenticateToken, (req, res) => {
  const db = getDb();
  const { title, body, summary, tags } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }

  try {
    const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
    const now = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO articles (title, body, summary, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(title, body, summary || '', tagsStr, now, now);

    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({
      ...article,
      tags: parseTags(article.tags)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create article' });
  }
});

// PUT /api/articles/:id - Update article (requires auth)
router.put('/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { title, body, summary, tags } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }

  try {
    const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE articles SET title = ?, body = ?, summary = ?, tags = ?, updated_at = ?
      WHERE id = ?
    `).run(title, body, summary || '', tagsStr, now, id);

    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);

    res.json({
      ...article,
      tags: parseTags(article.tags)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update article' });
  }
});

// DELETE /api/articles/:id - Delete article (requires auth)
router.delete('/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  try {
    const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }

    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    res.json({ message: 'Article deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete article' });
  }
});

// GET /api/tags - Get all unique tags (exported for use in server.js)
function getTags(req, res) {
  const db = getDb();

  try {
    const articles = db.prepare("SELECT tags FROM articles WHERE tags IS NOT NULL AND tags != ''").all();
    const tagSet = new Set();

    articles.forEach(article => {
      if (article.tags) {
        article.tags.split(',').forEach(tag => {
          const trimmed = tag.trim();
          if (trimmed) tagSet.add(trimmed);
        });
      }
    });

    const tags = Array.from(tagSet).sort();
    res.json({ tags });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
}

module.exports = router;
module.exports.getTags = getTags;
