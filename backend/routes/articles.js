const express = require('express');
const { getDb } = require('../db/init');
const { authenticateToken } = require('../middleware/auth');
const {
  buildArticleFilter,
  whereSqlFrom,
  parsePagination,
  effectivePage
} = require('./filters');

const router = express.Router();

// GET /api/articles - List articles with pagination, tag filter, search and
// optional date range (start_date / end_date). The list, count and the
// /api/stats summary all share buildArticleFilter so they can never diverge.
router.get('/', (req, res) => {
  const db = getDb();

  try {
    const { page: requestedPage, limit } = parsePagination(req.query);
    const { clauses, params: filterParams } = buildArticleFilter(req.query);
    const whereSql = whereSqlFrom(clauses);

    const countQuery = `SELECT COUNT(*) as total FROM articles ${whereSql}`;
    const { total } = db.prepare(countQuery).get(...filterParams);

    const totalPages = Math.ceil(total / limit);
    const page = effectivePage(requestedPage, totalPages);
    const offset = (page - 1) * limit;

    const articlesQuery = `
      SELECT id, title, summary, tags, created_at, updated_at
      FROM articles ${whereSql}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `;
    const articles = db
      .prepare(articlesQuery)
      .all(...filterParams, limit, offset);

    const parsedArticles = articles.map(article => ({
      ...article,
      tags: article.tags ? article.tags.split(',').map(t => t.trim()) : []
    }));

    res.json({
      articles: parsedArticles,
      pagination: {
        total,
        page,
        requestedPage,
        limit,
        totalPages
      }
    });
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    const error = err.status ? err.message : 'Failed to fetch articles';
    res.status(status).json({ error });
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
      tags: article.tags ? article.tags.split(',').map(t => t.trim()) : []
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
      tags: article.tags ? article.tags.split(',').map(t => t.trim()) : []
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
      tags: article.tags ? article.tags.split(',').map(t => t.trim()) : []
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
