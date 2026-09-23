<template>
  <div class="article-list-admin">
    <div class="page-header">
      <h2 class="page-title">文章管理</h2>
      <el-button type="primary" @click="goToCreate">
        新建文章
      </el-button>
    </div>

    <el-card class="stats-card" v-loading="statsLoading">
      <div class="stats-row">
        <div class="stat-item">
          <div class="stat-number">{{ stats.totalArticles }}</div>
          <div class="stat-label">筛选结果</div>
        </div>
        <div class="stat-item">
          <div class="stat-number">{{ stats.recentArticles }}</div>
          <div class="stat-label">近7天新增</div>
        </div>
        <div class="stat-item">
          <div class="stat-number">{{ stats.totalTags }}</div>
          <div class="stat-label">涉及标签</div>
        </div>
        <div class="stat-item trend-item">
          <div class="stat-label">趋势摘要</div>
          <div v-if="recentTrend.length" class="trend-bars">
            <div
              v-for="point in recentTrend"
              :key="point.date"
              class="trend-bar"
              :style="{ height: trendBarHeight(point.count) }"
              :title="`${point.date}: ${point.count} 篇`"
            ></div>
          </div>
          <div v-else class="trend-empty">暂无数据</div>
        </div>
      </div>
      <div class="top-tags">
        <span class="top-tags-label">常用标签：</span>
        <template v-if="stats.topTags.length">
          <el-tag
            v-for="tag in stats.topTags"
            :key="tag.name"
            size="small"
            class="tag-cell"
          >
            {{ tag.name }} ({{ tag.count }})
          </el-tag>
        </template>
        <span v-else class="no-tags">暂无标签</span>
      </div>
    </el-card>

    <el-card>
      <div class="filter-bar">
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="YYYY-MM-DD"
          :shortcuts="rangeShortcuts"
          @change="handleRangeChange"
        />
        <el-button @click="resetFilters">重置</el-button>
      </div>

      <el-table :data="articles" v-loading="loading" style="width: 100%">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="title" label="标题" min-width="200" />
        <el-table-column prop="tags" label="标签" width="250">
          <template #default="{ row }">
            <el-tag v-for="tag in row.tags" :key="tag" size="small" class="tag-cell">
              {{ tag }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="150">
          <template #default="{ row }">
            {{ formatDate(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="editArticle(row.id)">
              编辑
            </el-button>
            <el-button type="danger" link @click="deleteArticle(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty
        v-if="!loading && articles.length === 0"
        description="暂无符合条件的文章"
      />

      <Pagination
        v-model="currentPage"
        :total="pagination.total"
        :page-size="pagination.limit"
        @change="handlePageChange"
      />
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../../api'
import Pagination from '../../components/Pagination.vue'

const router = useRouter()

const articles = ref([])
const loading = ref(false)
const statsLoading = ref(false)
const currentPage = ref(1)
const dateRange = ref(null)
const pagination = ref({
  total: 0,
  page: 1,
  limit: 10,
  totalPages: 0
})
const stats = ref({
  totalArticles: 0,
  totalTags: 0,
  recentArticles: 0,
  trend: [],
  topTags: []
})

const TREND_DAYS_SHOWN = 14

const rangeShortcuts = [
  {
    text: '最近7天',
    value: () => {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 6)
      return [start, end]
    }
  },
  {
    text: '最近30天',
    value: () => {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 29)
      return [start, end]
    }
  }
]

// Single source of truth for filter conditions: the list query and the
// stats query are built from the same params so they can never drift apart.
const filterParams = computed(() => {
  const params = {}
  if (dateRange.value && dateRange.value[0]) {
    params.from = dateRange.value[0]
  }
  if (dateRange.value && dateRange.value[1]) {
    params.to = dateRange.value[1]
  }
  return params
})

const recentTrend = computed(() => stats.value.trend.slice(-TREND_DAYS_SHOWN))

const maxTrendCount = computed(() =>
  recentTrend.value.reduce((max, point) => Math.max(max, point.count), 0)
)

onMounted(() => {
  fetchData()
})

async function fetchArticles() {
  loading.value = true
  try {
    const response = await api.get('/articles', {
      params: {
        ...filterParams.value,
        page: currentPage.value,
        limit: pagination.value.limit
      }
    })
    articles.value = response.data.articles
    pagination.value = response.data.pagination
  } catch (error) {
    console.error('Failed to fetch articles:', error)
    ElMessage.error('获取文章列表失败')
  } finally {
    loading.value = false
  }
}

async function fetchStats() {
  statsLoading.value = true
  try {
    const response = await api.get('/articles/stats', {
      params: filterParams.value
    })
    stats.value = response.data
  } catch (error) {
    console.error('Failed to fetch article stats:', error)
    ElMessage.error('获取统计信息失败')
  } finally {
    statsLoading.value = false
  }
}

function fetchData() {
  fetchArticles()
  fetchStats()
}

function handleRangeChange() {
  // Switching the range invalidates the current page position: restart
  // from page 1 so the range and the list position stay aligned.
  currentPage.value = 1
  fetchData()
}

function resetFilters() {
  if (!dateRange.value) return
  dateRange.value = null
  currentPage.value = 1
  fetchData()
}

function handlePageChange(page) {
  currentPage.value = page
  fetchArticles()
}

function trendBarHeight(count) {
  if (!maxTrendCount.value) return '2px'
  const height = Math.round((count / maxTrendCount.value) * 40)
  return `${Math.max(height, 2)}px`
}

function goToCreate() {
  router.push('/admin/articles/new')
}

function editArticle(id) {
  router.push(`/admin/articles/${id}/edit`)
}

async function deleteArticle(article) {
  try {
    await ElMessageBox.confirm(
      `确定要删除文章「${article.title}」吗？`,
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    await api.delete(`/articles/${article.id}`)
    ElMessage.success('文章已删除')
    // Deleting the last row of a page would leave an empty page behind:
    // step back one page so the position and the numbers stay consistent.
    if (articles.value.length === 1 && currentPage.value > 1) {
      currentPage.value -= 1
    }
    fetchData()
  } catch (error) {
    if (error !== 'cancel') {
      console.error('Failed to delete article:', error)
      ElMessage.error('删除文章失败')
    }
  }
}

function formatDate(dateStr) {
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN')
}
</script>

<style scoped>
.article-list-admin {
  padding-top: 20px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.page-title {
  font-size: 24px;
  color: #303133;
  margin: 0;
}

.stats-card {
  margin-bottom: 20px;
}

.stats-row {
  display: flex;
  align-items: center;
  gap: 40px;
}

.stat-item {
  text-align: center;
  padding: 10px 0;
}

.stat-number {
  font-size: 28px;
  font-weight: bold;
  color: #409eff;
}

.stat-label {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
}

.trend-item {
  flex: 1;
  text-align: left;
}

.trend-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 40px;
  margin-top: 8px;
}

.trend-bar {
  width: 12px;
  background-color: #409eff;
  border-radius: 2px 2px 0 0;
}

.trend-empty {
  color: #909399;
  font-size: 13px;
  margin-top: 8px;
}

.top-tags {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #ebeef5;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.top-tags-label {
  font-size: 13px;
  color: #606266;
  margin-right: 4px;
}

.no-tags {
  font-size: 13px;
  color: #909399;
}

.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.tag-cell {
  margin-right: 4px;
}
</style>
