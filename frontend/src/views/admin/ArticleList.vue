<template>
  <div class="article-list-admin">
    <div class="page-header">
      <h2 class="page-title">文章管理</h2>
      <el-button type="primary" @click="goToCreate">
        新建文章
      </el-button>
    </div>
    
    <el-card>
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
        <template #empty>
          暂无文章
        </template>
      </el-table>
      
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
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../../api'
import Pagination from '../../components/Pagination.vue'

const router = useRouter()

const articles = ref([])
const loading = ref(false)
const currentPage = ref(1)
const pagination = ref({
  total: 0,
  page: 1,
  limit: 10,
  totalPages: 0
})

// Ignore responses from requests that were superseded (e.g. fast paging).
let latestRequestId = 0

onMounted(() => {
  fetchArticles()
})

async function fetchArticles() {
  const requestId = ++latestRequestId
  loading.value = true
  try {
    const response = await api.get('/articles', {
      params: { page: currentPage.value, limit: pagination.value.limit }
    })
    if (requestId !== latestRequestId) return

    articles.value = response.data.articles
    pagination.value = response.data.pagination

    // The server clamps pages past the last one (e.g. after deleting the
    // final article on the last page) and returns that page's rows in the
    // same response; just realign the pager with what was returned.
    if (response.data.pagination.page !== currentPage.value) {
      currentPage.value = response.data.pagination.page
    }
  } catch (error) {
    if (requestId !== latestRequestId) return
    console.error('Failed to fetch articles:', error)
    ElMessage.error('获取文章列表失败')
  } finally {
    if (requestId === latestRequestId) loading.value = false
  }
}

function handlePageChange(page) {
  currentPage.value = page
  fetchArticles()
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
    fetchArticles()
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

.tag-cell {
  margin-right: 4px;
}
</style>
