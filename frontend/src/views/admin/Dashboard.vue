<template>
  <div class="dashboard" v-loading="loading">
    <div class="page-header">
      <h2 class="page-title">管理面板</h2>
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        value-format="YYYY-MM-DD"
        :clearable="true"
        :shortcuts="dateShortcuts"
        @change="handleRangeChange"
      />
    </div>

    <el-row :gutter="20" class="stat-cards">
      <el-col :span="8">
        <el-card shadow="hover">
          <div class="stat-item">
            <div class="stat-number">{{ summary.totalArticles }}</div>
            <div class="stat-label">文章总数</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover">
          <div class="stat-item">
            <div class="stat-number">{{ summary.totalTags }}</div>
            <div class="stat-label">标签数量</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover">
          <div class="stat-item">
            <div class="stat-number">{{ summary.recentArticles }}</div>
            <div class="stat-label">本周新文章</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="summary-cards">
      <el-col :span="12">
        <el-card>
          <template #header>
            <span>趋势摘要{{ rangeLabel ? `（${rangeLabel}）` : '' }}</span>
          </template>
          <div class="trend-summary">
            <div class="trend-main">
              <span class="trend-count">{{ summary.rangeArticles }}</span>
              <span class="trend-unit">篇</span>
              <el-tag
                v-if="summary.previousPeriodCount !== null"
                :type="trendType"
                size="small"
                effect="plain"
                class="trend-tag"
              >
                较上期 {{ trendText }}
              </el-tag>
            </div>
            <div v-if="summary.previousPeriodCount !== null" class="trend-sub">
              上一区间 {{ summary.previousPeriodCount }} 篇
            </div>
            <div v-else class="trend-sub">选择起止日期后可对比上一区间</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header>
            <span>常用标签{{ rangeLabel ? `（${rangeLabel}）` : '' }}</span>
          </template>
          <div v-if="summary.popularTags.length" class="popular-tags">
            <el-tag
              v-for="item in summary.popularTags"
              :key="item.tag"
              size="small"
              class="popular-tag"
            >
              {{ item.tag }} · {{ item.count }}
            </el-tag>
          </div>
          <el-empty v-else description="该区间暂无标签" :image-size="60" />
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="quick-actions">
      <el-col :span="24">
        <el-card>
          <template #header>
            <span>快捷操作</span>
          </template>
          <el-space>
            <el-button type="primary" @click="goToCreateArticle">
              写新文章
            </el-button>
            <el-button @click="goToArticleList">
              管理文章
            </el-button>
            <el-button @click="goToHome">
              查看博客
            </el-button>
          </el-space>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="recent-articles">
      <el-col :span="24">
        <el-card>
          <template #header>
            <span>{{ rangeLabel ? `${rangeLabel}内的文章` : '最近文章' }}</span>
          </template>
          <el-table :data="recentArticles" style="width: 100%">
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column prop="title" label="标题" min-width="200" />
            <el-table-column prop="tags" label="标签" width="200">
              <template #default="{ row }">
                <el-tag v-for="tag in row.tags.slice(0, 3)" :key="tag" size="small" class="tag-cell">
                  {{ tag }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="created_at" label="创建时间" width="150">
              <template #default="{ row }">
                {{ formatDate(row.created_at) }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button type="primary" link @click="editArticle(row.id)">
                  编辑
                </el-button>
              </template>
            </el-table-column>
            <template #empty>
              该区间内暂无文章
            </template>
          </el-table>

          <Pagination
            v-model="currentPage"
            :total="pagination.total"
            :page-size="pagination.limit"
            @change="handlePageChange"
          />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api from '../../api'
import Pagination from '../../components/Pagination.vue'

const PAGE_SIZE = 5

const router = useRouter()

const loading = ref(false)
const dateRange = ref(null)
const currentPage = ref(1)

// One summary object, always replaced atomically by one /api/stats response,
// so the cards, trend, tags and list can never reflect different conditions.
const summary = reactive({
  totalArticles: 0,
  totalTags: 0,
  rangeArticles: 0,
  recentArticles: 0,
  previousPeriodCount: null,
  percentChange: 0,
  popularTags: []
})
const recentArticles = ref([])
const pagination = ref({
  total: 0,
  page: 1,
  limit: PAGE_SIZE,
  totalPages: 0
})

// Drop responses from stale in-flight requests (e.g. quick range switching)
// so an older, slower response can never overwrite the latest selection.
let latestRequestId = 0

const dateShortcuts = [
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
  },
  {
    text: '最近90天',
    value: () => {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 89)
      return [start, end]
    }
  }
]

const rangeLabel = computed(() => {
  if (!dateRange.value || !dateRange.value[0]) return ''
  const [start, end] = dateRange.value
  return start === end ? start : `${start} ~ ${end}`
})

const trendType = computed(() => {
  if (summary.percentChange > 0) return 'danger'
  if (summary.percentChange < 0) return 'success'
  return 'info'
})

const trendText = computed(() => {
  const pct = summary.percentChange
  if (pct > 0) return `上涨 ${pct}%`
  if (pct < 0) return `下降 ${Math.abs(pct)}%`
  return '持平'
})

onMounted(() => {
  fetchDashboard()
})

function buildParams(page = currentPage.value) {
  const params = { page, limit: PAGE_SIZE }
  if (dateRange.value && dateRange.value[0]) {
    params.start_date = dateRange.value[0]
    if (dateRange.value[1]) params.end_date = dateRange.value[1]
  }
  return params
}

async function fetchDashboard() {
  const requestId = ++latestRequestId
  loading.value = true
  try {
    const response = await api.get('/stats', { params: buildParams() })
    if (requestId !== latestRequestId) return

    Object.assign(summary, {
      totalArticles: response.data.totalArticles,
      totalTags: response.data.totalTags,
      rangeArticles: response.data.rangeArticles,
      recentArticles: response.data.recentArticles,
      previousPeriodCount: response.data.previousPeriodCount,
      percentChange: response.data.percentChange,
      popularTags: response.data.popularTags
    })
    recentArticles.value = response.data.articles
    pagination.value = response.data.pagination

    // The server clamps pages beyond the range (empty range, range switch);
    // keep the pager aligned with what was actually returned.
    if (response.data.pagination.page !== currentPage.value) {
      currentPage.value = response.data.pagination.page
    }
  } catch (error) {
    if (requestId !== latestRequestId) return
    console.error('Failed to fetch dashboard:', error)
    ElMessage.error(error.response?.data?.error || '获取统计数据失败')
  } finally {
    if (requestId === latestRequestId) loading.value = false
  }
}

function handleRangeChange() {
  // New condition: always start from the first page so the list and the
  // selected range never point at mismatched data.
  currentPage.value = 1
  fetchDashboard()
}

function handlePageChange(page) {
  currentPage.value = page
  fetchDashboard()
}

function goToCreateArticle() {
  router.push('/admin/articles/new')
}

function goToArticleList() {
  router.push('/admin/articles')
}

function goToHome() {
  router.push('/')
}

function editArticle(id) {
  router.push(`/admin/articles/${id}/edit`)
}

function formatDate(dateStr) {
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN')
}
</script>

<style scoped>
.dashboard {
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

.stat-cards {
  margin-bottom: 20px;
}

.summary-cards {
  margin-bottom: 20px;
}

.stat-item {
  text-align: center;
  padding: 20px 0;
}

.stat-number {
  font-size: 36px;
  font-weight: bold;
  color: #409eff;
}

.stat-label {
  font-size: 14px;
  color: #909399;
  margin-top: 8px;
}

.trend-summary {
  padding: 8px 0;
}

.trend-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.trend-count {
  font-size: 32px;
  font-weight: bold;
  color: #303133;
}

.trend-unit {
  font-size: 14px;
  color: #909399;
}

.trend-tag {
  margin-left: 8px;
}

.trend-sub {
  margin-top: 8px;
  font-size: 13px;
  color: #909399;
}

.popular-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
}

.quick-actions {
  margin-bottom: 20px;
}

.recent-articles {
  margin-bottom: 20px;
}

.tag-cell,
.popular-tag {
  margin-right: 4px;
}
</style>
