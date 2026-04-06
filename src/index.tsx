import { Hono } from 'hono'
import { cors } from 'hono/cors'

// Types
type Bindings = {
  DB: D1Database
  GEMINI_API_KEY: string
}

type Variables = {
  user?: { id: number; nickname: string }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// CORS
app.use('/api/*', cors())

// ==================== API Routes ====================

// --- 사용자 (닉네임 기반) ---
app.post('/api/users', async (c) => {
  const { nickname } = await c.req.json<{ nickname: string }>()
  if (!nickname || nickname.trim().length === 0) {
    return c.json({ error: '닉네임을 입력해주세요.' }, 400)
  }
  const trimmed = nickname.trim().slice(0, 20)

  try {
    // 기존 사용자 확인
    const existing = await c.env.DB.prepare(
      'SELECT id, nickname FROM users WHERE nickname = ?'
    ).bind(trimmed).first()

    if (existing) {
      await c.env.DB.prepare(
        "UPDATE users SET last_active_at = DATETIME('now','localtime') WHERE id = ?"
      ).bind(existing.id).run()
      return c.json({ user: existing })
    }

    // 신규 생성
    const result = await c.env.DB.prepare(
      'INSERT INTO users (nickname) VALUES (?)'
    ).bind(trimmed).run()

    return c.json({ user: { id: result.meta.last_row_id, nickname: trimmed } })
  } catch (e: any) {
    return c.json({ error: '사용자 등록 실패: ' + e.message }, 500)
  }
})

// --- 카테고리 CRUD ---
app.get('/api/categories', async (c) => {
  const results = await c.env.DB.prepare(
    'SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC'
  ).all()
  return c.json({ categories: results.results })
})

app.post('/api/categories', async (c) => {
  const { name, description, tone_instruction } = await c.req.json()
  if (!name) return c.json({ error: '카테고리 이름은 필수입니다.' }, 400)

  const maxOrder = await c.env.DB.prepare(
    'SELECT MAX(sort_order) as max_order FROM categories'
  ).first<{ max_order: number }>()

  const result = await c.env.DB.prepare(
    'INSERT INTO categories (name, description, tone_instruction, sort_order) VALUES (?, ?, ?, ?)'
  ).bind(name, description || '', tone_instruction || '', (maxOrder?.max_order || 0) + 1).run()

  return c.json({ id: result.meta.last_row_id, name })
})

// --- 핵심: 이중 글쓰기 분석 API ---
app.post('/api/analyze', async (c) => {
  const { text, category_id, user_id, tone } = await c.req.json<{
    text: string
    category_id?: number
    user_id: number
    tone?: string
  }>()

  if (!text || text.trim().length === 0) {
    return c.json({ error: '분석할 텍스트를 입력해주세요.' }, 400)
  }
  if (text.length > 3000) {
    return c.json({ error: '3,000자 이내로 입력해주세요.' }, 400)
  }
  if (!user_id) {
    return c.json({ error: '사용자 정보가 필요합니다.' }, 400)
  }

  // 카테고리 어조 가져오기
  let categoryTone = ''
  let categoryName = ''
  if (category_id) {
    const cat = await c.env.DB.prepare(
      'SELECT name, tone_instruction FROM categories WHERE id = ?'
    ).bind(category_id).first<{ name: string; tone_instruction: string }>()
    if (cat) {
      categoryTone = cat.tone_instruction
      categoryName = cat.name
    }
  }

  // Gemini API 호출
  const apiKey = c.env.GEMINI_API_KEY
  if (!apiKey) {
    return c.json({ error: 'AI API 키가 설정되지 않았습니다.' }, 500)
  }

  const systemPrompt = buildSystemPrompt(categoryName, categoryTone, tone || '')
  const userPrompt = `다음 글을 '이중 글쓰기' 원칙에 따라 분석하고 교정해주세요:\n\n${text}`

  try {
    const aiResult = await callGemini(apiKey, systemPrompt, userPrompt)

    // DB 저장
    await c.env.DB.prepare(
      `INSERT INTO writing_logs (user_id, category_id, original_text, revised_text, ai_score, human_score, feedback, checklist_json, model_used, tone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user_id,
      category_id || null,
      text,
      aiResult.revised_text,
      aiResult.analysis.ai_score,
      aiResult.analysis.human_score,
      JSON.stringify(aiResult.analysis.feedback),
      JSON.stringify(aiResult.checklist),
      'gemini',
      tone || ''
    ).run()

    return c.json({ result: aiResult })
  } catch (e: any) {
    console.error('AI 분석 오류:', e)
    return c.json({ error: 'AI 분석 중 오류가 발생했습니다: ' + e.message }, 500)
  }
})

// --- 이력 조회 ---
app.get('/api/logs', async (c) => {
  const userId = c.req.query('user_id')
  const categoryId = c.req.query('category_id')
  const limit = parseInt(c.req.query('limit') || '20')
  const offset = parseInt(c.req.query('offset') || '0')

  let query = `SELECT wl.*, c.name as category_name FROM writing_logs wl
               LEFT JOIN categories c ON wl.category_id = c.id WHERE 1=1`
  const params: any[] = []

  if (userId) {
    query += ' AND wl.user_id = ?'
    params.push(parseInt(userId))
  }
  if (categoryId) {
    query += ' AND wl.category_id = ?'
    params.push(parseInt(categoryId))
  }

  query += ' ORDER BY wl.created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const stmt = c.env.DB.prepare(query)
  const results = await stmt.bind(...params).all()

  return c.json({ logs: results.results })
})

// --- 통계 ---
app.get('/api/stats', async (c) => {
  const userId = c.req.query('user_id')
  if (!userId) return c.json({ error: 'user_id 필요' }, 400)

  const stats = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total_writes,
      ROUND(AVG(ai_score), 1) as avg_ai_score,
      ROUND(AVG(human_score), 1) as avg_human_score,
      MAX(ai_score) as best_ai_score,
      MAX(human_score) as best_human_score
    FROM writing_logs WHERE user_id = ?
  `).bind(parseInt(userId)).first()

  const recentTrend = await c.env.DB.prepare(`
    SELECT ai_score, human_score, created_at
    FROM writing_logs WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 10
  `).bind(parseInt(userId)).all()

  const categoryStats = await c.env.DB.prepare(`
    SELECT c.name, COUNT(*) as count, ROUND(AVG(wl.ai_score),1) as avg_ai, ROUND(AVG(wl.human_score),1) as avg_human
    FROM writing_logs wl JOIN categories c ON wl.category_id = c.id
    WHERE wl.user_id = ? GROUP BY c.name ORDER BY count DESC
  `).bind(parseInt(userId)).all()

  return c.json({
    stats,
    recentTrend: recentTrend.results,
    categoryStats: categoryStats.results
  })
})

// ==================== AI Functions ====================

function buildSystemPrompt(categoryName: string, categoryTone: string, userTone: string): string {
  return `당신은 블로그 수익화와 AI 검색 노출(GEO)을 설계하는 전략적 글쓰기 코치 'WriteScope'입니다.

## 임무
사용자의 초안을 분석하여 [성과 + 기준 + 대상 + 변화] (성·기·대·변) 요소가 포함된 하이브리드 문장으로 재구성합니다.
이 글은 AI(인용/검색 최적화)와 인간(공감/체류시간 극대화)을 동시에 만족시켜야 합니다.

## 채점 기준
### AI 점수 (100점 만점)
- 구체적 수치/데이터 포함 (40점): 퍼센트, 금액, 기간 등 정량적 데이터
- 출처/기간 명시 (30점): 신뢰할 수 있는 출처, 측정 기간
- 두괄식 구조 (30점): 핵심 키워드와 결론이 문장 앞에 배치

### 인간 점수 (100점 만점)
- 혜택 대상 특정 (30점): 누구에게 도움이 되는지 명확히 명시
- 변화/가치 서술 (40점): 독자가 얻을 구체적 변화와 혜택
- 상황적 공감 묘사 (30점): 독자가 처한 상황에 대한 공감과 스토리

${categoryName ? `## 카테고리: ${categoryName}\n${categoryTone}\n` : ''}
${userTone ? `## 사용자 지정 어조: ${userTone}\n` : ''}

## 출력 형식 (반드시 아래 JSON 형식으로만 출력)
{
  "revised_text": "교정된 이중 글쓰기 문장 (원본의 의미를 유지하면서 성·기·대·변 요소를 보강)",
  "analysis": {
    "ai_score": 0~100 사이 정수,
    "human_score": 0~100 사이 정수,
    "ai_details": {
      "numbers": 0~40 사이 정수,
      "source": 0~30 사이 정수,
      "structure": 0~30 사이 정수
    },
    "human_details": {
      "target": 0~30 사이 정수,
      "value": 0~40 사이 정수,
      "empathy": 0~30 사이 정수
    },
    "feedback": ["피드백1", "피드백2", "피드백3"]
  },
  "checklist": {
    "has_numbers": true/false,
    "has_source": true/false,
    "has_target": true/false,
    "has_benefit": true/false,
    "is_head_heavy": true/false
  }
}

중요: 반드시 유효한 JSON만 출력하세요. 다른 텍스트 없이 JSON만 출력합니다.`
}

async function callGemini(apiKey: string, systemPrompt: string, userPrompt: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [{
        parts: [{ text: userPrompt }]
      }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json'
      }
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Gemini API 오류 (${response.status}): ${errText}`)
  }

  const data = await response.json() as any
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text

  if (!text) {
    throw new Error('AI 응답이 비어있습니다.')
  }

  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    return JSON.parse(cleaned)
  } catch {
    throw new Error('AI 응답 파싱 실패: ' + text.substring(0, 200))
  }
}

// ==================== Frontend ====================

app.get('/', (c) => {
  return c.html(getMainHTML())
})

function getMainHTML(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WriteScope - 이중 글쓰기 어시스턴트</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
    <script>
      tailwind.config = {
        theme: {
          extend: {
            colors: {
              navy: { 50:'#f0f3f8', 100:'#d9e0ed', 200:'#b3c1db', 300:'#8da2c9', 400:'#6783b7', 500:'#4164a5', 600:'#345084', 700:'#273c63', 800:'#1E293B', 900:'#131a27' },
              accent: { 50:'#fff7ed', 100:'#ffedd5', 200:'#fed7aa', 300:'#fdba74', 400:'#fb923c', 500:'#F97316', 600:'#ea580c', 700:'#c2410c', 800:'#9a3412', 900:'#7c2d12' }
            }
          }
        }
      }
    </script>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
      * { font-family: 'Noto Sans KR', sans-serif; }
      body { background: #0f172a; }
      .glass { background: rgba(30, 41, 59, 0.8); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); }
      .tab-active { background: linear-gradient(135deg, #F97316, #ea580c); color: white; box-shadow: 0 4px 15px rgba(249,115,22,0.4); }
      .tab-inactive { background: rgba(30, 41, 59, 0.6); color: #94a3b8; }
      .tab-inactive:hover { background: rgba(51, 65, 85, 0.8); color: #e2e8f0; }
      .glow-orange { box-shadow: 0 0 20px rgba(249,115,22,0.3); }
      .score-ring { transition: stroke-dashoffset 1s ease-in-out; }
      textarea:focus { outline: none; box-shadow: 0 0 0 2px rgba(249,115,22,0.5); }
      .checklist-pass { color: #22c55e; }
      .checklist-fail { color: #ef4444; }
      .fade-in { animation: fadeIn 0.3s ease-in; }
      @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      .pulse-loading { animation: pulse 1.5s ease-in-out infinite; }
      @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: #1e293b; }
      ::-webkit-scrollbar-thumb { background: #475569; border-radius: 3px; }
    </style>
</head>
<body class="min-h-screen text-gray-200">

<!-- 닉네임 입력 모달 -->
<div id="loginModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
  <div class="glass rounded-2xl p-8 w-full max-w-md mx-4 text-center">
    <div class="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-accent-500 to-accent-600 rounded-2xl flex items-center justify-center">
      <i class="fas fa-pen-nib text-2xl text-white"></i>
    </div>
    <h2 class="text-2xl font-bold text-white mb-2">WriteScope</h2>
    <p class="text-gray-400 mb-6 text-sm">AI와 인간, 두 시선으로 글을 완성하다</p>
    <input id="nicknameInput" type="text" maxlength="20" placeholder="닉네임을 입력하세요"
           class="w-full px-4 py-3 bg-navy-900 border border-gray-700 rounded-xl text-white placeholder-gray-500 text-center text-lg mb-4 focus:border-accent-500 transition-colors"
           onkeypress="if(event.key==='Enter') enterApp()">
    <button onclick="enterApp()" class="w-full py-3 bg-gradient-to-r from-accent-500 to-accent-600 text-white font-semibold rounded-xl hover:from-accent-600 hover:to-accent-700 transition-all glow-orange">
      <i class="fas fa-arrow-right mr-2"></i>시작하기
    </button>
  </div>
</div>

<!-- 메인 앱 -->
<div id="mainApp" class="hidden">
  <!-- 헤더 -->
  <header class="glass sticky top-0 z-40 border-b border-gray-800">
    <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 bg-gradient-to-br from-accent-500 to-accent-600 rounded-lg flex items-center justify-center">
          <i class="fas fa-pen-nib text-white text-sm"></i>
        </div>
        <div>
          <h1 class="text-lg font-bold text-white leading-tight">WriteScope</h1>
          <p class="text-[10px] text-gray-500 leading-tight">Dual Writing Assistant</p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span id="userBadge" class="text-sm text-gray-400"><i class="fas fa-user mr-1"></i><span id="displayNickname"></span></span>
        <button onclick="logout()" class="text-xs text-gray-500 hover:text-gray-300 transition-colors"><i class="fas fa-sign-out-alt"></i></button>
      </div>
    </div>
  </header>

  <!-- 탭 네비게이션 -->
  <div class="max-w-7xl mx-auto px-4 mt-4">
    <div class="flex gap-2 overflow-x-auto pb-2">
      <button onclick="switchTab('write')" id="tab-write" class="tab-active px-5 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all">
        <i class="fas fa-edit mr-1.5"></i>글쓰기 분석
      </button>
      <button onclick="switchTab('history')" id="tab-history" class="tab-inactive px-5 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all">
        <i class="fas fa-history mr-1.5"></i>교정 이력
      </button>
      <button onclick="switchTab('stats')" id="tab-stats" class="tab-inactive px-5 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all">
        <i class="fas fa-chart-bar mr-1.5"></i>통계 대시보드
      </button>
    </div>
  </div>

  <!-- 탭 콘텐츠 영역 -->
  <main class="max-w-7xl mx-auto px-4 py-4">

    <!-- ===== 탭1: 글쓰기 분석 ===== -->
    <div id="panel-write" class="fade-in">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- 좌: 입력 영역 -->
        <div class="glass rounded-2xl p-5">
          <h3 class="text-white font-semibold mb-3"><i class="fas fa-keyboard mr-2 text-accent-500"></i>원문 입력</h3>
          <!-- 카테고리 & 어조 -->
          <div class="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label class="text-xs text-gray-400 mb-1 block">카테고리</label>
              <select id="categorySelect" class="w-full px-3 py-2 bg-navy-900 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-accent-500 transition-colors">
                <option value="">선택 안함</option>
              </select>
            </div>
            <div>
              <label class="text-xs text-gray-400 mb-1 block">어조</label>
              <select id="toneSelect" class="w-full px-3 py-2 bg-navy-900 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-accent-500 transition-colors">
                <option value="">자동</option>
                <option value="전문적">전문적</option>
                <option value="친근한">친근한</option>
                <option value="설득적">설득적</option>
                <option value="감성적">감성적</option>
                <option value="유머러스">유머러스</option>
              </select>
            </div>
          </div>
          <div class="relative">
            <textarea id="inputText" rows="14" maxlength="3000" placeholder="분석할 글을 입력하세요... (최대 3,000자)"
                      class="w-full px-4 py-3 bg-navy-900 border border-gray-700 rounded-xl text-gray-200 text-sm leading-relaxed resize-none transition-colors"></textarea>
            <div class="absolute bottom-3 right-3 text-xs text-gray-500"><span id="charCount">0</span>/3,000</div>
          </div>
          <button onclick="analyzeText()" id="analyzeBtn"
                  class="w-full mt-3 py-3 bg-gradient-to-r from-accent-500 to-accent-600 text-white font-semibold rounded-xl hover:from-accent-600 hover:to-accent-700 transition-all glow-orange disabled:opacity-50 disabled:cursor-not-allowed">
            <i class="fas fa-magic mr-2"></i>이중 글쓰기 분석 시작
          </button>
        </div>

        <!-- 우: 결과 영역 -->
        <div class="glass rounded-2xl p-5">
          <h3 class="text-white font-semibold mb-3"><i class="fas fa-chart-radar mr-2 text-accent-500"></i>분석 결과</h3>
          <!-- 결과 없을 때 -->
          <div id="resultPlaceholder" class="flex flex-col items-center justify-center h-[420px] text-gray-500">
            <i class="fas fa-search-plus text-4xl mb-4 text-gray-600"></i>
            <p class="text-sm">왼쪽에 글을 입력하고 분석을 시작하세요</p>
            <p class="text-xs mt-1 text-gray-600">성·기·대·변 공식으로 AI + 인간 점수를 진단합니다</p>
          </div>
          <!-- 로딩 -->
          <div id="resultLoading" class="hidden flex flex-col items-center justify-center h-[420px]">
            <div class="w-16 h-16 border-4 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mb-4"></div>
            <p class="text-sm text-gray-400 pulse-loading">AI가 글을 분석하고 있습니다...</p>
          </div>
          <!-- 결과 표시 -->
          <div id="resultContent" class="hidden fade-in">
            <!-- 점수 서클 -->
            <div class="grid grid-cols-2 gap-4 mb-4">
              <div class="text-center">
                <div class="relative w-28 h-28 mx-auto">
                  <svg class="w-28 h-28 -rotate-90" viewBox="0 0 120 120">
                    <circle cx="60" cy="60" r="52" stroke="#1e293b" stroke-width="10" fill="none"/>
                    <circle id="aiScoreRing" cx="60" cy="60" r="52" stroke="#3b82f6" stroke-width="10" fill="none"
                            stroke-dasharray="326.73" stroke-dashoffset="326.73" stroke-linecap="round" class="score-ring"/>
                  </svg>
                  <div class="absolute inset-0 flex flex-col items-center justify-center">
                    <span id="aiScoreNum" class="text-2xl font-bold text-blue-400">0</span>
                    <span class="text-[10px] text-gray-500">AI 점수</span>
                  </div>
                </div>
                <div class="mt-2 space-y-1 text-xs">
                  <div class="flex justify-between text-gray-400"><span>수치 데이터</span><span id="detailNumbers" class="text-blue-400">0/40</span></div>
                  <div class="flex justify-between text-gray-400"><span>출처/기간</span><span id="detailSource" class="text-blue-400">0/30</span></div>
                  <div class="flex justify-between text-gray-400"><span>두괄식 구조</span><span id="detailStructure" class="text-blue-400">0/30</span></div>
                </div>
              </div>
              <div class="text-center">
                <div class="relative w-28 h-28 mx-auto">
                  <svg class="w-28 h-28 -rotate-90" viewBox="0 0 120 120">
                    <circle cx="60" cy="60" r="52" stroke="#1e293b" stroke-width="10" fill="none"/>
                    <circle id="humanScoreRing" cx="60" cy="60" r="52" stroke="#F97316" stroke-width="10" fill="none"
                            stroke-dasharray="326.73" stroke-dashoffset="326.73" stroke-linecap="round" class="score-ring"/>
                  </svg>
                  <div class="absolute inset-0 flex flex-col items-center justify-center">
                    <span id="humanScoreNum" class="text-2xl font-bold text-accent-400">0</span>
                    <span class="text-[10px] text-gray-500">인간 점수</span>
                  </div>
                </div>
                <div class="mt-2 space-y-1 text-xs">
                  <div class="flex justify-between text-gray-400"><span>대상 특정</span><span id="detailTarget" class="text-accent-400">0/30</span></div>
                  <div class="flex justify-between text-gray-400"><span>변화/가치</span><span id="detailValue" class="text-accent-400">0/40</span></div>
                  <div class="flex justify-between text-gray-400"><span>공감 묘사</span><span id="detailEmpathy" class="text-accent-400">0/30</span></div>
                </div>
              </div>
            </div>
            <!-- 방사형 차트 -->
            <div class="bg-navy-900/50 rounded-xl p-3 mb-4">
              <canvas id="radarChart" height="180"></canvas>
            </div>
            <!-- 체크리스트 -->
            <div class="bg-navy-900/50 rounded-xl p-3 mb-4">
              <h4 class="text-xs font-semibold text-gray-400 mb-2"><i class="fas fa-clipboard-check mr-1"></i>성·기·대·변 체크리스트</h4>
              <div class="grid grid-cols-1 gap-1.5 text-sm" id="checklistArea"></div>
            </div>
            <!-- 피드백 -->
            <div class="bg-navy-900/50 rounded-xl p-3 mb-4">
              <h4 class="text-xs font-semibold text-gray-400 mb-2"><i class="fas fa-comment-dots mr-1"></i>AI 피드백</h4>
              <ul id="feedbackList" class="space-y-1 text-sm text-gray-300"></ul>
            </div>
            <!-- 교정문 -->
            <div class="bg-navy-900/50 rounded-xl p-3">
              <div class="flex items-center justify-between mb-2">
                <h4 class="text-xs font-semibold text-gray-400"><i class="fas fa-magic mr-1"></i>교정된 글</h4>
                <button onclick="copyRevised()" class="text-xs text-accent-500 hover:text-accent-400 transition-colors"><i class="fas fa-copy mr-1"></i>복사</button>
              </div>
              <div id="revisedText" class="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 탭2: 교정 이력 ===== -->
    <div id="panel-history" class="hidden fade-in">
      <div class="glass rounded-2xl p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-white font-semibold"><i class="fas fa-history mr-2 text-accent-500"></i>교정 이력</h3>
          <select id="historyFilter" onchange="loadHistory()" class="px-3 py-1.5 bg-navy-900 border border-gray-700 rounded-lg text-sm text-gray-300">
            <option value="">전체 카테고리</option>
          </select>
        </div>
        <div id="historyList" class="space-y-3">
          <p class="text-center text-gray-500 py-10"><i class="fas fa-inbox text-3xl mb-3 block text-gray-600"></i>교정 이력이 없습니다</p>
        </div>
        <div id="loadMoreArea" class="hidden text-center mt-4">
          <button onclick="loadMoreHistory()" class="px-6 py-2 bg-navy-700 text-gray-300 rounded-lg text-sm hover:bg-navy-600 transition-colors">더 보기</button>
        </div>
      </div>
    </div>

    <!-- ===== 탭3: 통계 대시보드 ===== -->
    <div id="panel-stats" class="hidden fade-in">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div class="glass rounded-2xl p-5 text-center">
          <div class="text-3xl font-bold text-accent-500" id="statTotal">0</div>
          <div class="text-xs text-gray-400 mt-1">총 분석 횟수</div>
        </div>
        <div class="glass rounded-2xl p-5 text-center">
          <div class="text-3xl font-bold text-blue-400" id="statAvgAI">0</div>
          <div class="text-xs text-gray-400 mt-1">평균 AI 점수</div>
        </div>
        <div class="glass rounded-2xl p-5 text-center">
          <div class="text-3xl font-bold text-accent-400" id="statAvgHuman">0</div>
          <div class="text-xs text-gray-400 mt-1">평균 인간 점수</div>
        </div>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="glass rounded-2xl p-5">
          <h3 class="text-white font-semibold mb-3"><i class="fas fa-chart-line mr-2 text-accent-500"></i>점수 추이 (최근 10건)</h3>
          <canvas id="trendChart" height="200"></canvas>
        </div>
        <div class="glass rounded-2xl p-5">
          <h3 class="text-white font-semibold mb-3"><i class="fas fa-chart-pie mr-2 text-accent-500"></i>카테고리별 평균</h3>
          <canvas id="categoryChart" height="200"></canvas>
        </div>
      </div>
    </div>

  </main>
</div>

<script>
// ==================== App State ====================
let currentUser = null;
let categories = [];
let radarChart = null;
let trendChart = null;
let categoryChart = null;
let historyOffset = 0;

const API = '';

// ==================== Auth ====================
function enterApp() {
  const nickname = document.getElementById('nicknameInput').value.trim();
  if (!nickname) { alert('닉네임을 입력해주세요.'); return; }

  fetch(API + '/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) { alert(data.error); return; }
    currentUser = data.user;
    document.getElementById('displayNickname').textContent = currentUser.nickname;
    document.getElementById('loginModal').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    loadCategories();
  })
  .catch(e => alert('연결 오류: ' + e.message));
}

function logout() {
  currentUser = null;
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('loginModal').classList.remove('hidden');
  document.getElementById('nicknameInput').value = '';
}

// ==================== Tabs ====================
function switchTab(tab) {
  ['write','history','stats'].forEach(t => {
    document.getElementById('panel-' + t).classList.toggle('hidden', t !== tab);
    document.getElementById('tab-' + t).className = t === tab ? 'tab-active px-5 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all' : 'tab-inactive px-5 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all';
  });
  if (tab === 'history') { historyOffset = 0; loadHistory(); }
  if (tab === 'stats') loadStats();
}

// ==================== Categories ====================
function loadCategories() {
  fetch(API + '/api/categories')
  .then(r => r.json())
  .then(data => {
    categories = data.categories || [];
    const sel = document.getElementById('categorySelect');
    const filter = document.getElementById('historyFilter');
    sel.innerHTML = '<option value="">선택 안함</option>';
    filter.innerHTML = '<option value="">전체 카테고리</option>';
    categories.forEach(c => {
      sel.innerHTML += '<option value="' + c.id + '">' + c.name + '</option>';
      filter.innerHTML += '<option value="' + c.id + '">' + c.name + '</option>';
    });
  });
}

// ==================== Analysis ====================
document.getElementById('inputText').addEventListener('input', function() {
  document.getElementById('charCount').textContent = this.value.length;
});

function analyzeText() {
  const text = document.getElementById('inputText').value.trim();
  if (!text) { alert('글을 입력해주세요.'); return; }
  if (!currentUser) { alert('로그인이 필요합니다.'); return; }

  const categoryId = document.getElementById('categorySelect').value;
  const tone = document.getElementById('toneSelect').value;

  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>AI 분석 중...';

  document.getElementById('resultPlaceholder').classList.add('hidden');
  document.getElementById('resultContent').classList.add('hidden');
  document.getElementById('resultLoading').classList.remove('hidden');

  fetch(API + '/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      category_id: categoryId ? parseInt(categoryId) : null,
      user_id: currentUser.id,
      tone: tone || null
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) { alert(data.error); return; }
    displayResult(data.result);
  })
  .catch(e => alert('분석 오류: ' + e.message))
  .finally(() => {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-magic mr-2"></i>이중 글쓰기 분석 시작';
    document.getElementById('resultLoading').classList.add('hidden');
  });
}

function displayResult(result) {
  document.getElementById('resultContent').classList.remove('hidden');

  const aiScore = result.analysis.ai_score;
  const humanScore = result.analysis.human_score;
  const circumference = 326.73;

  // Animate score rings
  animateScore('aiScoreNum', aiScore);
  animateScore('humanScoreNum', humanScore);
  document.getElementById('aiScoreRing').style.strokeDashoffset = circumference - (circumference * aiScore / 100);
  document.getElementById('humanScoreRing').style.strokeDashoffset = circumference - (circumference * humanScore / 100);

  // Details
  const ad = result.analysis.ai_details || {};
  const hd = result.analysis.human_details || {};
  document.getElementById('detailNumbers').textContent = (ad.numbers||0) + '/40';
  document.getElementById('detailSource').textContent = (ad.source||0) + '/30';
  document.getElementById('detailStructure').textContent = (ad.structure||0) + '/30';
  document.getElementById('detailTarget').textContent = (hd.target||0) + '/30';
  document.getElementById('detailValue').textContent = (hd.value||0) + '/40';
  document.getElementById('detailEmpathy').textContent = (hd.empathy||0) + '/30';

  // Radar Chart
  updateRadarChart(ad, hd);

  // Checklist
  const cl = result.checklist || {};
  const checklistHTML = [
    { key: 'has_numbers', label: '수치(%) 데이터 포함', icon: 'fa-hashtag' },
    { key: 'has_source', label: '출처/측정 기간 명시', icon: 'fa-quote-right' },
    { key: 'has_target', label: '혜택 대상(누구에게) 특정', icon: 'fa-user-check' },
    { key: 'has_benefit', label: '변화(Benefit) 서술', icon: 'fa-arrow-up' },
    { key: 'is_head_heavy', label: '핵심 키워드 두괄식 배치', icon: 'fa-heading' }
  ].map(item => {
    const pass = cl[item.key];
    return '<div class="flex items-center gap-2 ' + (pass ? 'checklist-pass' : 'checklist-fail') + '">'
      + '<i class="fas ' + (pass ? 'fa-check-circle' : 'fa-times-circle') + '"></i>'
      + '<i class="fas ' + item.icon + ' text-xs opacity-50"></i>'
      + '<span>' + item.label + '</span></div>';
  }).join('');
  document.getElementById('checklistArea').innerHTML = checklistHTML;

  // Feedback
  const feedbacks = result.analysis.feedback || [];
  document.getElementById('feedbackList').innerHTML = feedbacks.map(f =>
    '<li class="flex items-start gap-2"><i class="fas fa-lightbulb text-accent-500 mt-0.5 text-xs"></i><span>' + f + '</span></li>'
  ).join('');

  // Revised text
  document.getElementById('revisedText').textContent = result.revised_text || '';
}

function animateScore(elId, target) {
  const el = document.getElementById(elId);
  let current = 0;
  const step = Math.max(1, Math.floor(target / 30));
  const timer = setInterval(() => {
    current = Math.min(current + step, target);
    el.textContent = current;
    if (current >= target) clearInterval(timer);
  }, 20);
}

function updateRadarChart(ai, human) {
  const ctx = document.getElementById('radarChart').getContext('2d');
  if (radarChart) radarChart.destroy();

  radarChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: ['수치 데이터', '출처/기간', '두괄식 구조', '대상 특정', '변화/가치', '공감 묘사'],
      datasets: [{
        label: 'AI 점수 요소',
        data: [
          ((ai.numbers||0)/40)*100,
          ((ai.source||0)/30)*100,
          ((ai.structure||0)/30)*100,
          0, 0, 0
        ],
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.15)',
        borderWidth: 2,
        pointBackgroundColor: '#3b82f6'
      }, {
        label: '인간 점수 요소',
        data: [
          0, 0, 0,
          ((human.target||0)/30)*100,
          ((human.value||0)/40)*100,
          ((human.empathy||0)/30)*100
        ],
        borderColor: '#F97316',
        backgroundColor: 'rgba(249,115,22,0.15)',
        borderWidth: 2,
        pointBackgroundColor: '#F97316'
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: '#94a3b8', font: { size: 10 } } }
      },
      scales: {
        r: {
          beginAtZero: true, max: 100,
          grid: { color: 'rgba(148,163,184,0.1)' },
          angleLines: { color: 'rgba(148,163,184,0.1)' },
          pointLabels: { color: '#94a3b8', font: { size: 10 } },
          ticks: { display: false }
        }
      }
    }
  });
}

function copyRevised() {
  const text = document.getElementById('revisedText').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target.closest('button');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-check mr-1"></i>복사됨!';
    setTimeout(() => btn.innerHTML = orig, 1500);
  });
}

// ==================== History ====================
function loadHistory() {
  if (!currentUser) return;
  historyOffset = 0;
  const catId = document.getElementById('historyFilter').value;
  let url = API + '/api/logs?user_id=' + currentUser.id + '&limit=10&offset=0';
  if (catId) url += '&category_id=' + catId;

  fetch(url).then(r => r.json()).then(data => {
    const logs = data.logs || [];
    const container = document.getElementById('historyList');
    if (logs.length === 0) {
      container.innerHTML = '<p class="text-center text-gray-500 py-10"><i class="fas fa-inbox text-3xl mb-3 block text-gray-600"></i>교정 이력이 없습니다</p>';
      document.getElementById('loadMoreArea').classList.add('hidden');
      return;
    }
    container.innerHTML = logs.map(renderHistoryItem).join('');
    document.getElementById('loadMoreArea').classList.toggle('hidden', logs.length < 10);
    historyOffset = logs.length;
  });
}

function loadMoreHistory() {
  const catId = document.getElementById('historyFilter').value;
  let url = API + '/api/logs?user_id=' + currentUser.id + '&limit=10&offset=' + historyOffset;
  if (catId) url += '&category_id=' + catId;

  fetch(url).then(r => r.json()).then(data => {
    const logs = data.logs || [];
    const container = document.getElementById('historyList');
    container.innerHTML += logs.map(renderHistoryItem).join('');
    document.getElementById('loadMoreArea').classList.toggle('hidden', logs.length < 10);
    historyOffset += logs.length;
  });
}

function renderHistoryItem(log) {
  const aiColor = log.ai_score >= 70 ? 'text-green-400' : log.ai_score >= 40 ? 'text-yellow-400' : 'text-red-400';
  const humanColor = log.human_score >= 70 ? 'text-green-400' : log.human_score >= 40 ? 'text-yellow-400' : 'text-red-400';
  return '<div class="bg-navy-900/50 rounded-xl p-4 border border-gray-800 hover:border-gray-700 transition-colors">'
    + '<div class="flex items-center justify-between mb-2">'
    + '<div class="flex items-center gap-2">'
    + (log.category_name ? '<span class="px-2 py-0.5 bg-accent-500/20 text-accent-400 text-xs rounded-full">' + log.category_name + '</span>' : '')
    + '<span class="text-xs text-gray-500">' + (log.created_at || '') + '</span>'
    + '</div>'
    + '<div class="flex gap-3 text-sm">'
    + '<span class="' + aiColor + '"><i class="fas fa-robot mr-1"></i>' + log.ai_score + '</span>'
    + '<span class="' + humanColor + '"><i class="fas fa-heart mr-1"></i>' + log.human_score + '</span>'
    + '</div></div>'
    + '<p class="text-xs text-gray-400 line-clamp-2">' + (log.original_text || '').substring(0, 150) + '...</p>'
    + '</div>';
}

// ==================== Stats ====================
function loadStats() {
  if (!currentUser) return;

  fetch(API + '/api/stats?user_id=' + currentUser.id)
  .then(r => r.json())
  .then(data => {
    const s = data.stats || {};
    document.getElementById('statTotal').textContent = s.total_writes || 0;
    document.getElementById('statAvgAI').textContent = s.avg_ai_score || 0;
    document.getElementById('statAvgHuman').textContent = s.avg_human_score || 0;

    // Trend chart
    const trend = (data.recentTrend || []).reverse();
    updateTrendChart(trend);

    // Category chart
    updateCategoryChart(data.categoryStats || []);
  });
}

function updateTrendChart(trend) {
  const ctx = document.getElementById('trendChart').getContext('2d');
  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: trend.map((_, i) => '#' + (i + 1)),
      datasets: [{
        label: 'AI 점수',
        data: trend.map(t => t.ai_score),
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.1)',
        tension: 0.4, fill: true, pointRadius: 4
      }, {
        label: '인간 점수',
        data: trend.map(t => t.human_score),
        borderColor: '#F97316',
        backgroundColor: 'rgba(249,115,22,0.1)',
        tension: 0.4, fill: true, pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#94a3b8' } } },
      scales: {
        x: { ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.08)' } },
        y: { min: 0, max: 100, ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.08)' } }
      }
    }
  });
}

function updateCategoryChart(catStats) {
  const ctx = document.getElementById('categoryChart').getContext('2d');
  if (categoryChart) categoryChart.destroy();

  if (catStats.length === 0) {
    ctx.font = '14px Noto Sans KR';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText('아직 데이터가 없습니다', ctx.canvas.width / 2, ctx.canvas.height / 2);
    return;
  }

  categoryChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: catStats.map(c => c.name),
      datasets: [{
        label: '평균 AI',
        data: catStats.map(c => c.avg_ai),
        backgroundColor: 'rgba(59,130,246,0.7)',
        borderRadius: 4
      }, {
        label: '평균 인간',
        data: catStats.map(c => c.avg_human),
        backgroundColor: 'rgba(249,115,22,0.7)',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#94a3b8' } } },
      scales: {
        x: { ticks: { color: '#64748b' }, grid: { display: false } },
        y: { min: 0, max: 100, ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.08)' } }
      }
    }
  });
}
</script>
</body>
</html>`
}

export default app
