import { Hono } from 'hono'
import { cors } from 'hono/cors'

// Types
type Bindings = {
  DB: D1Database
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

// --- API 키 관리 ---
app.post('/api/keys', async (c) => {
  const { user_id, provider, api_key } = await c.req.json<{
    user_id: number; provider: string; api_key: string
  }>()
  if (!user_id || !provider || !api_key) {
    return c.json({ error: '필수 값이 누락되었습니다.' }, 400)
  }

  // 간단한 Base64 인코딩 (Cloudflare Workers에서는 Web Crypto 사용 가능하나 MVP에서는 간단히)
  const encoded = btoa(api_key)

  try {
    await c.env.DB.prepare(
      `INSERT INTO api_keys (user_id, provider, api_key_encrypted, updated_at)
       VALUES (?, ?, ?, DATETIME('now','localtime'))
       ON CONFLICT(user_id, provider) DO UPDATE SET
         api_key_encrypted = excluded.api_key_encrypted,
         is_valid = 1,
         updated_at = DATETIME('now','localtime')`
    ).bind(user_id, provider, encoded).run()

    return c.json({ success: true, provider })
  } catch (e: any) {
    return c.json({ error: 'API 키 저장 실패: ' + e.message }, 500)
  }
})

app.get('/api/keys', async (c) => {
  const userId = c.req.query('user_id')
  if (!userId) return c.json({ error: 'user_id 필요' }, 400)

  const results = await c.env.DB.prepare(
    'SELECT provider, is_valid, updated_at FROM api_keys WHERE user_id = ?'
  ).bind(parseInt(userId)).all()

  return c.json({ keys: results.results })
})

app.delete('/api/keys', async (c) => {
  const { user_id, provider } = await c.req.json<{ user_id: number; provider: string }>()
  if (!user_id || !provider) return c.json({ error: '필수 값 누락' }, 400)

  await c.env.DB.prepare(
    'DELETE FROM api_keys WHERE user_id = ? AND provider = ?'
  ).bind(user_id, provider).run()

  return c.json({ success: true })
})

// API 키 검증 (실제 API 호출 테스트)
app.post('/api/keys/verify', async (c) => {
  const { user_id, provider } = await c.req.json<{ user_id: number; provider: string }>()

  const keyRow = await c.env.DB.prepare(
    'SELECT api_key_encrypted FROM api_keys WHERE user_id = ? AND provider = ?'
  ).bind(user_id, provider).first<{ api_key_encrypted: string }>()

  if (!keyRow) return c.json({ valid: false, error: 'API 키가 등록되지 않았습니다.' })

  const apiKey = atob(keyRow.api_key_encrypted)

  try {
    if (provider === 'gemini') {
      // 모델 목록 조회로 키 유효성 검증 (가볍고 안정적)
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { method: 'GET' }
      )
      if (!res.ok) {
        await c.env.DB.prepare(
          'UPDATE api_keys SET is_valid = 0 WHERE user_id = ? AND provider = ?'
        ).bind(user_id, provider).run()
        return c.json({ valid: false, error: `API 키가 유효하지 않습니다. (${res.status})` })
      }
    }

    await c.env.DB.prepare(
      'UPDATE api_keys SET is_valid = 1 WHERE user_id = ? AND provider = ?'
    ).bind(user_id, provider).run()
    return c.json({ valid: true })
  } catch (e: any) {
    return c.json({ valid: false, error: '검증 실패: ' + e.message })
  }
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

  // 사용자의 API 키 가져오기
  const keyRow = await c.env.DB.prepare(
    'SELECT api_key_encrypted, provider FROM api_keys WHERE user_id = ? AND provider = ? AND is_valid = 1'
  ).bind(user_id, 'gemini').first<{ api_key_encrypted: string; provider: string }>()

  if (!keyRow) {
    return c.json({ error: 'API 키가 설정되지 않았습니다. 설정 탭에서 Gemini API 키를 등록해주세요.' }, 400)
  }

  const apiKey = atob(keyRow.api_key_encrypted)

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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`

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
<title>DualWrite Pro - AI + Human 이중 글쓰기</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Noto+Sans+KR:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<script>
tailwind.config={theme:{extend:{colors:{
  navy:{50:'#f0f3f8',100:'#d9e0ed',200:'#b3c1db',300:'#8da2c9',400:'#6783b7',500:'#4164a5',600:'#345084',700:'#273c63',800:'#1E293B',900:'#131a27',950:'#0c1018'},
  accent:{50:'#fff7ed',100:'#ffedd5',200:'#fed7aa',300:'#fdba74',400:'#fb923c',500:'#F97316',600:'#ea580c',700:'#c2410c',800:'#9a3412',900:'#7c2d12'}
}}}}
</script>
<style>
*{font-family:'Noto Sans KR','Inter',system-ui,sans-serif;margin:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0a0f1e 0%,#111827 50%,#0f172a 100%);min-height:100vh}
/* Glassmorphism */
.glass{background:rgba(15,23,42,0.6);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.06)}
.glass-light{background:rgba(30,41,59,0.5);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.08)}
.glass-card{background:linear-gradient(135deg,rgba(15,23,42,0.8),rgba(30,41,59,0.4));backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.06);transition:all .3s ease}
.glass-card:hover{border-color:rgba(249,115,22,0.2);box-shadow:0 8px 32px rgba(0,0,0,0.3)}
/* Tabs */
.tab-btn{position:relative;padding:10px 24px;border-radius:12px;font-size:14px;font-weight:500;color:#94a3b8;background:transparent;transition:all .3s ease;cursor:pointer;border:none;white-space:nowrap}
.tab-btn:hover{color:#e2e8f0;background:rgba(51,65,85,0.4)}
.tab-btn.active{color:#fff;background:linear-gradient(135deg,#F97316,#ea580c);box-shadow:0 4px 20px rgba(249,115,22,0.4)}
/* Buttons */
.btn-primary{background:linear-gradient(135deg,#F97316,#ea580c);color:#fff;font-weight:600;border:none;border-radius:14px;cursor:pointer;transition:all .3s ease;position:relative;overflow:hidden}
.btn-primary:hover{box-shadow:0 6px 25px rgba(249,115,22,0.5);transform:translateY(-1px)}
.btn-primary:active{transform:translateY(0)}
.btn-primary:disabled{opacity:0.5;cursor:not-allowed;transform:none;box-shadow:none}
.btn-primary::after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,0.1),transparent);opacity:0;transition:opacity .3s}
.btn-primary:hover::after{opacity:1}
/* Score gauge */
.gauge-ring{transition:stroke-dashoffset 1.5s cubic-bezier(0.4,0,0.2,1)}
.gauge-glow{filter:drop-shadow(0 0 8px var(--glow-color))}
/* Inputs */
.input-field{background:rgba(15,23,42,0.8);border:1px solid rgba(100,116,139,0.3);border-radius:12px;color:#e2e8f0;transition:all .3s ease}
.input-field:focus{outline:none;border-color:#F97316;box-shadow:0 0 0 3px rgba(249,115,22,0.15)}
.input-field::placeholder{color:#475569}
/* Animations */
.fade-up{animation:fadeUp .5s ease forwards;opacity:0}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.slide-in{animation:slideIn .4s ease forwards}
@keyframes slideIn{from{opacity:0;transform:translateX(-15px)}to{opacity:1;transform:translateX(0)}}
.pulse-glow{animation:pulseGlow 2s ease-in-out infinite}
@keyframes pulseGlow{0%,100%{box-shadow:0 0 5px rgba(249,115,22,0.2)}50%{box-shadow:0 0 20px rgba(249,115,22,0.4)}}
.shimmer{background:linear-gradient(90deg,rgba(30,41,59,0.4) 25%,rgba(51,65,85,0.4) 50%,rgba(30,41,59,0.4) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
/* Score colors */
.score-excellent{color:#22c55e}.score-good{color:#84cc16}.score-average{color:#eab308}.score-poor{color:#ef4444}
/* Checklist card */
.check-card{background:rgba(15,23,42,0.5);border:1px solid rgba(100,116,139,0.15);border-radius:12px;padding:12px 16px;transition:all .3s ease}
.check-card.pass{border-color:rgba(34,197,94,0.3);background:rgba(34,197,94,0.05)}
.check-card.fail{border-color:rgba(239,68,68,0.3);background:rgba(239,68,68,0.05)}
/* Scrollbar */
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#334155;border-radius:10px}::-webkit-scrollbar-thumb:hover{background:#475569}
/* Diff view */
.diff-add{background:rgba(34,197,94,0.15);border-left:3px solid #22c55e;padding:2px 8px;border-radius:0 4px 4px 0;margin:1px 0;display:inline}
.diff-remove{background:rgba(239,68,68,0.15);text-decoration:line-through;color:#f87171;padding:2px 8px;border-radius:4px;margin:1px 0;display:inline}
/* Toast */
.toast{position:fixed;bottom:24px;right:24px;z-index:9999;padding:14px 24px;border-radius:14px;font-size:14px;font-weight:500;transform:translateY(100px);opacity:0;transition:all .4s ease;backdrop-filter:blur(12px)}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);color:#86efac}
.toast.error{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5}
.toast.info{background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);color:#93c5fd}
/* Progress bar */
.progress-track{height:6px;background:rgba(51,65,85,0.5);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;border-radius:3px;transition:width 1s ease}
/* Stat card counter */
.stat-num{font-family:'Inter','Noto Sans KR',sans-serif;font-weight:800;letter-spacing:-0.02em}
</style>
</head>
<body class="text-gray-200">

<!-- ========== LOGIN MODAL ========== -->
<div id="loginModal" class="fixed inset-0 z-50 flex items-center justify-center" style="background:radial-gradient(ellipse at center,rgba(249,115,22,0.08) 0%,rgba(10,15,30,0.95) 70%)">
  <div class="fade-up glass rounded-3xl p-10 w-full max-w-md mx-4 text-center relative overflow-hidden">
    <div class="absolute -top-20 -right-20 w-40 h-40 bg-accent-500/10 rounded-full blur-3xl"></div>
    <div class="absolute -bottom-16 -left-16 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl"></div>
    <div class="relative z-10">
      <div class="w-20 h-20 mx-auto mb-5 relative">
        <div class="absolute inset-0 bg-gradient-to-br from-accent-500 to-accent-700 rounded-2xl rotate-6 opacity-60"></div>
        <div class="absolute inset-0 bg-gradient-to-br from-accent-500 to-accent-600 rounded-2xl flex items-center justify-center">
          <i class="fas fa-pen-fancy text-2xl text-white"></i>
        </div>
      </div>
      <h1 class="text-3xl font-extrabold text-white mb-1 tracking-tight">DualWrite<span class="text-accent-500"> Pro</span></h1>
      <p class="text-gray-400 mb-1 text-sm font-medium">AI + Human Dual Writing Assistant</p>
      <p class="text-gray-500 text-xs mb-8">AI 검색 최적화와 인간 공감, 두 시선으로 글을 완성합니다</p>
      <div class="relative mb-4">
        <i class="fas fa-user-astronaut absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"></i>
        <input id="nicknameInput" type="text" maxlength="20" placeholder="닉네임을 입력하세요"
          class="input-field w-full pl-11 pr-4 py-3.5 text-center text-lg font-medium"
          onkeypress="if(event.key==='Enter')enterApp()">
      </div>
      <button onclick="enterApp()" class="btn-primary w-full py-3.5 text-lg">
        <i class="fas fa-rocket mr-2"></i>시작하기
      </button>
      <p class="text-[11px] text-gray-600 mt-4">성(성과) · 기(기준) · 대(대상) · 변(변화) 공식 기반 분석</p>
    </div>
  </div>
</div>

<!-- ========== MAIN APP ========== -->
<div id="mainApp" class="hidden">

<!-- HEADER -->
<header class="glass sticky top-0 z-40" style="border-bottom:1px solid rgba(255,255,255,0.04)">
  <div class="max-w-[1400px] mx-auto px-5 py-3 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-9 h-9 bg-gradient-to-br from-accent-500 to-accent-600 rounded-xl flex items-center justify-center shadow-lg shadow-accent-500/20">
        <i class="fas fa-pen-fancy text-white text-sm"></i>
      </div>
      <div>
        <h1 class="text-base font-bold text-white leading-tight tracking-tight">DualWrite <span class="text-accent-500">Pro</span></h1>
        <p class="text-[10px] text-gray-500 font-medium">AI + Human Dual Writing</p>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-navy-800/50">
        <div class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
        <span id="displayNickname" class="text-sm text-gray-300 font-medium"></span>
      </div>
      <button onclick="logout()" class="w-8 h-8 rounded-lg bg-navy-800/50 flex items-center justify-center text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-all" title="로그아웃">
        <i class="fas fa-sign-out-alt text-xs"></i>
      </button>
    </div>
  </div>
</header>

<!-- TAB NAV -->
<div class="max-w-[1400px] mx-auto px-5 pt-4">
  <div class="flex gap-2 overflow-x-auto pb-1">
    <button onclick="switchTab('write')" id="tab-write" class="tab-btn active"><i class="fas fa-pen-nib mr-2"></i>글쓰기 분석</button>
    <button onclick="switchTab('history')" id="tab-history" class="tab-btn"><i class="fas fa-clock-rotate-left mr-2"></i>교정 이력</button>
    <button onclick="switchTab('stats')" id="tab-stats" class="tab-btn"><i class="fas fa-chart-column mr-2"></i>통계</button>
    <button onclick="switchTab('settings')" id="tab-settings" class="tab-btn"><i class="fas fa-sliders mr-2"></i>설정</button>
  </div>
</div>

<!-- TAB CONTENT -->
<main class="max-w-[1400px] mx-auto px-5 py-4 pb-20">

<!-- ===== TAB: WRITE ===== -->
<div id="panel-write" class="fade-up">
  <!-- API Key Warning Banner -->
  <div id="apiKeyBanner" class="hidden mb-4 p-4 rounded-2xl border border-yellow-500/20 bg-yellow-500/5 flex items-center justify-between gap-4">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
        <i class="fas fa-key text-yellow-400"></i>
      </div>
      <div>
        <p class="text-sm font-semibold text-yellow-300">API 키를 먼저 등록해주세요</p>
        <p class="text-xs text-yellow-500/80">설정 탭에서 Gemini API 키를 등록하면 분석을 시작할 수 있습니다</p>
      </div>
    </div>
    <button onclick="switchTab('settings')" class="btn-primary px-5 py-2 text-sm flex-shrink-0">설정 이동 <i class="fas fa-arrow-right ml-1"></i></button>
  </div>

  <div class="grid grid-cols-1 xl:grid-cols-5 gap-5">
    <!-- LEFT: Input (3 cols) -->
    <div class="xl:col-span-2 space-y-4">
      <div class="glass-card rounded-2xl p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-white font-bold text-base"><i class="fas fa-feather-pointed mr-2 text-accent-500"></i>원문 입력</h3>
          <span class="text-[11px] text-gray-500 bg-navy-800/50 px-2.5 py-1 rounded-full"><i class="fas fa-info-circle mr-1"></i>최대 3,000자</span>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label class="text-[11px] text-gray-500 font-medium mb-1.5 block uppercase tracking-wider">카테고리</label>
            <select id="categorySelect" class="input-field w-full px-3 py-2.5 text-sm">
              <option value="">선택 안함</option>
            </select>
          </div>
          <div>
            <label class="text-[11px] text-gray-500 font-medium mb-1.5 block uppercase tracking-wider">어조</label>
            <select id="toneSelect" class="input-field w-full px-3 py-2.5 text-sm">
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
          <textarea id="inputText" rows="16" maxlength="3000" placeholder="분석할 블로그 글을 입력하세요...&#10;&#10;AI 검색 노출(GEO)과 인간 공감을 동시에 만족하는&#10;이중 글쓰기로 교정해 드립니다."
            class="input-field w-full px-4 py-3.5 text-sm leading-relaxed resize-none"></textarea>
          <div class="absolute bottom-3 right-3 flex items-center gap-2">
            <div class="h-1.5 w-24 rounded-full bg-navy-700 overflow-hidden">
              <div id="charBar" class="h-full bg-accent-500 rounded-full transition-all duration-300" style="width:0%"></div>
            </div>
            <span class="text-[11px] text-gray-500 font-mono"><span id="charCount">0</span>/3,000</span>
          </div>
        </div>
        <button onclick="analyzeText()" id="analyzeBtn" class="btn-primary w-full mt-4 py-3.5 text-base tracking-wide">
          <i class="fas fa-wand-magic-sparkles mr-2"></i>이중 글쓰기 분석
        </button>
      </div>
    </div>

    <!-- RIGHT: Results (3 cols) -->
    <div class="xl:col-span-3 space-y-4">
      <!-- Placeholder -->
      <div id="resultPlaceholder" class="glass-card rounded-2xl p-8 flex flex-col items-center justify-center min-h-[500px]">
        <div class="w-24 h-24 rounded-3xl bg-gradient-to-br from-navy-700 to-navy-800 flex items-center justify-center mb-6 relative">
          <i class="fas fa-pen-ruler text-3xl text-gray-600"></i>
          <div class="absolute -top-1 -right-1 w-6 h-6 bg-accent-500/20 rounded-full flex items-center justify-center">
            <i class="fas fa-sparkle text-accent-500 text-[10px]"></i>
          </div>
        </div>
        <p class="text-gray-400 font-semibold text-lg mb-2">글을 입력하고 분석을 시작하세요</p>
        <p class="text-gray-600 text-sm text-center max-w-sm">성·기·대·변 공식으로 AI 검색 최적화 점수와<br>인간 공감 점수를 동시에 진단합니다</p>
        <div class="flex gap-6 mt-8">
          <div class="text-center"><div class="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center mb-2"><i class="fas fa-robot text-blue-400"></i></div><span class="text-[11px] text-gray-500">AI 점수</span></div>
          <div class="text-center"><div class="w-12 h-12 rounded-xl bg-accent-500/10 flex items-center justify-center mb-2"><i class="fas fa-heart text-accent-400"></i></div><span class="text-[11px] text-gray-500">인간 점수</span></div>
          <div class="text-center"><div class="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center mb-2"><i class="fas fa-chart-radar text-purple-400"></i></div><span class="text-[11px] text-gray-500">레이더 차트</span></div>
        </div>
      </div>

      <!-- Loading -->
      <div id="resultLoading" class="hidden glass-card rounded-2xl p-8 flex flex-col items-center justify-center min-h-[500px]">
        <div class="relative w-24 h-24 mb-6">
          <div class="absolute inset-0 border-4 border-accent-500/20 rounded-full"></div>
          <div class="absolute inset-0 border-4 border-transparent border-t-accent-500 rounded-full animate-spin"></div>
          <div class="absolute inset-3 border-4 border-transparent border-b-blue-400 rounded-full animate-spin" style="animation-direction:reverse;animation-duration:1.5s"></div>
          <div class="absolute inset-0 flex items-center justify-center">
            <i class="fas fa-wand-magic-sparkles text-accent-500 animate-pulse"></i>
          </div>
        </div>
        <p class="text-gray-300 font-semibold mb-1">AI가 글을 분석하고 있습니다</p>
        <p class="text-gray-500 text-sm">성·기·대·변 요소를 검토 중...</p>
        <div class="flex gap-1 mt-4">
          <div class="w-2 h-2 bg-accent-500 rounded-full animate-bounce" style="animation-delay:0s"></div>
          <div class="w-2 h-2 bg-accent-500 rounded-full animate-bounce" style="animation-delay:0.15s"></div>
          <div class="w-2 h-2 bg-accent-500 rounded-full animate-bounce" style="animation-delay:0.3s"></div>
        </div>
      </div>

      <!-- Result -->
      <div id="resultContent" class="hidden space-y-4">
        <!-- Score Overview -->
        <div class="glass-card rounded-2xl p-6">
          <div class="flex items-center justify-between mb-5">
            <h3 class="text-white font-bold text-base"><i class="fas fa-bullseye mr-2 text-accent-500"></i>점수 분석</h3>
            <div id="gradeLabel" class="px-3 py-1 rounded-full text-xs font-bold"></div>
          </div>
          <div class="grid grid-cols-2 lg:grid-cols-3 gap-5">
            <!-- AI Score Gauge -->
            <div class="text-center">
              <div class="relative w-36 h-36 mx-auto">
                <svg class="w-36 h-36 -rotate-90" viewBox="0 0 140 140">
                  <defs>
                    <linearGradient id="aiGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stop-color="#3b82f6"/>
                      <stop offset="100%" stop-color="#06b6d4"/>
                    </linearGradient>
                  </defs>
                  <circle cx="70" cy="70" r="60" stroke="rgba(51,65,85,0.4)" stroke-width="12" fill="none"/>
                  <circle id="aiScoreRing" cx="70" cy="70" r="60" stroke="url(#aiGrad)" stroke-width="12" fill="none"
                    stroke-dasharray="376.99" stroke-dashoffset="376.99" stroke-linecap="round" class="gauge-ring gauge-glow" style="--glow-color:rgba(59,130,246,0.4)"/>
                </svg>
                <div class="absolute inset-0 flex flex-col items-center justify-center">
                  <span id="aiScoreNum" class="stat-num text-4xl text-blue-400">0</span>
                  <span class="text-[11px] text-gray-500 font-medium mt-0.5">AI 점수</span>
                </div>
              </div>
              <div class="mt-3 space-y-2 max-w-[160px] mx-auto">
                <div><div class="flex justify-between text-[11px] mb-1"><span class="text-gray-500">수치 데이터</span><span id="detailNumbers" class="text-blue-400 font-semibold">0/40</span></div><div class="progress-track"><div id="barNumbers" class="progress-fill bg-gradient-to-r from-blue-500 to-cyan-400" style="width:0%"></div></div></div>
                <div><div class="flex justify-between text-[11px] mb-1"><span class="text-gray-500">출처/기간</span><span id="detailSource" class="text-blue-400 font-semibold">0/30</span></div><div class="progress-track"><div id="barSource" class="progress-fill bg-gradient-to-r from-blue-500 to-cyan-400" style="width:0%"></div></div></div>
                <div><div class="flex justify-between text-[11px] mb-1"><span class="text-gray-500">두괄식 구조</span><span id="detailStructure" class="text-blue-400 font-semibold">0/30</span></div><div class="progress-track"><div id="barStructure" class="progress-fill bg-gradient-to-r from-blue-500 to-cyan-400" style="width:0%"></div></div></div>
              </div>
            </div>
            <!-- Human Score Gauge -->
            <div class="text-center">
              <div class="relative w-36 h-36 mx-auto">
                <svg class="w-36 h-36 -rotate-90" viewBox="0 0 140 140">
                  <defs>
                    <linearGradient id="humanGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stop-color="#F97316"/>
                      <stop offset="100%" stop-color="#f59e0b"/>
                    </linearGradient>
                  </defs>
                  <circle cx="70" cy="70" r="60" stroke="rgba(51,65,85,0.4)" stroke-width="12" fill="none"/>
                  <circle id="humanScoreRing" cx="70" cy="70" r="60" stroke="url(#humanGrad)" stroke-width="12" fill="none"
                    stroke-dasharray="376.99" stroke-dashoffset="376.99" stroke-linecap="round" class="gauge-ring gauge-glow" style="--glow-color:rgba(249,115,22,0.4)"/>
                </svg>
                <div class="absolute inset-0 flex flex-col items-center justify-center">
                  <span id="humanScoreNum" class="stat-num text-4xl text-accent-400">0</span>
                  <span class="text-[11px] text-gray-500 font-medium mt-0.5">인간 점수</span>
                </div>
              </div>
              <div class="mt-3 space-y-2 max-w-[160px] mx-auto">
                <div><div class="flex justify-between text-[11px] mb-1"><span class="text-gray-500">대상 특정</span><span id="detailTarget" class="text-accent-400 font-semibold">0/30</span></div><div class="progress-track"><div id="barTarget" class="progress-fill bg-gradient-to-r from-accent-500 to-yellow-400" style="width:0%"></div></div></div>
                <div><div class="flex justify-between text-[11px] mb-1"><span class="text-gray-500">변화/가치</span><span id="detailValue" class="text-accent-400 font-semibold">0/40</span></div><div class="progress-track"><div id="barValue" class="progress-fill bg-gradient-to-r from-accent-500 to-yellow-400" style="width:0%"></div></div></div>
                <div><div class="flex justify-between text-[11px] mb-1"><span class="text-gray-500">공감 묘사</span><span id="detailEmpathy" class="text-accent-400 font-semibold">0/30</span></div><div class="progress-track"><div id="barEmpathy" class="progress-fill bg-gradient-to-r from-accent-500 to-yellow-400" style="width:0%"></div></div></div>
              </div>
            </div>
            <!-- Radar -->
            <div class="col-span-2 lg:col-span-1">
              <div class="bg-navy-900/40 rounded-2xl p-4 h-full flex flex-col">
                <h4 class="text-xs font-semibold text-gray-400 mb-2 text-center"><i class="fas fa-chart-radar mr-1 text-purple-400"></i>6축 역량 레이더</h4>
                <div class="flex-1 flex items-center justify-center">
                  <canvas id="radarChart" style="max-height:220px"></canvas>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Checklist -->
        <div class="glass-card rounded-2xl p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-white font-bold text-base"><i class="fas fa-clipboard-check mr-2 text-accent-500"></i>성·기·대·변 체크리스트</h3>
            <span id="checkScore" class="text-sm font-bold text-gray-400"></span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3" id="checklistArea"></div>
        </div>

        <!-- Feedback -->
        <div class="glass-card rounded-2xl p-5">
          <h3 class="text-white font-bold text-base mb-4"><i class="fas fa-lightbulb mr-2 text-yellow-400"></i>AI 개선 피드백</h3>
          <div id="feedbackList" class="space-y-2"></div>
        </div>

        <!-- Before/After Comparison -->
        <div class="glass-card rounded-2xl p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-white font-bold text-base"><i class="fas fa-right-left mr-2 text-accent-500"></i>원문 vs 교정문 비교</h3>
            <button onclick="copyRevised()" id="copyBtn" class="flex items-center gap-1.5 px-4 py-2 bg-accent-500/10 text-accent-400 rounded-xl text-sm font-medium hover:bg-accent-500/20 transition-all">
              <i class="fas fa-copy"></i>교정문 복사
            </button>
          </div>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div class="flex items-center gap-2 mb-2">
                <span class="w-2 h-2 bg-red-400 rounded-full"></span>
                <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">원문 (Before)</span>
              </div>
              <div id="beforeText" class="bg-navy-950/50 rounded-xl p-4 text-sm text-gray-400 leading-relaxed whitespace-pre-wrap border border-gray-800/50 max-h-[300px] overflow-y-auto"></div>
            </div>
            <div>
              <div class="flex items-center gap-2 mb-2">
                <span class="w-2 h-2 bg-green-400 rounded-full"></span>
                <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">교정문 (After)</span>
              </div>
              <div id="revisedText" class="bg-navy-950/50 rounded-xl p-4 text-sm text-gray-200 leading-relaxed whitespace-pre-wrap border border-green-500/10 max-h-[300px] overflow-y-auto"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ===== TAB: HISTORY ===== -->
<div id="panel-history" class="hidden">
  <div class="glass-card rounded-2xl p-6">
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-5 gap-3">
      <h3 class="text-white font-bold text-lg"><i class="fas fa-clock-rotate-left mr-2 text-accent-500"></i>교정 이력</h3>
      <select id="historyFilter" onchange="loadHistory()" class="input-field px-4 py-2 text-sm min-w-[160px]">
        <option value="">전체 카테고리</option>
      </select>
    </div>
    <div id="historyList" class="space-y-3">
      <div class="flex flex-col items-center justify-center py-16 text-gray-500">
        <div class="w-16 h-16 rounded-2xl bg-navy-800/50 flex items-center justify-center mb-4"><i class="fas fa-inbox text-2xl text-gray-600"></i></div>
        <p class="font-medium">교정 이력이 없습니다</p>
        <p class="text-xs text-gray-600 mt-1">글쓰기 분석을 시작하면 이력이 쌓입니다</p>
      </div>
    </div>
    <div id="loadMoreArea" class="hidden text-center mt-5">
      <button onclick="loadMoreHistory()" class="px-8 py-2.5 rounded-xl bg-navy-700/50 text-gray-300 text-sm font-medium hover:bg-navy-600/50 transition-all border border-gray-700/50">
        <i class="fas fa-chevron-down mr-2"></i>더 보기
      </button>
    </div>
  </div>
</div>

<!-- ===== TAB: STATS ===== -->
<div id="panel-stats" class="hidden">
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
    <div class="glass-card rounded-2xl p-5 text-center relative overflow-hidden">
      <div class="absolute top-0 right-0 w-20 h-20 bg-accent-500/5 rounded-full -translate-y-1/2 translate-x-1/2"></div>
      <div class="relative">
        <div class="w-12 h-12 mx-auto mb-3 rounded-xl bg-accent-500/10 flex items-center justify-center"><i class="fas fa-pen-to-square text-accent-500 text-lg"></i></div>
        <div class="stat-num text-4xl text-accent-500 mb-1" id="statTotal">0</div>
        <div class="text-xs text-gray-500 font-medium">총 분석 횟수</div>
      </div>
    </div>
    <div class="glass-card rounded-2xl p-5 text-center relative overflow-hidden">
      <div class="absolute top-0 right-0 w-20 h-20 bg-blue-500/5 rounded-full -translate-y-1/2 translate-x-1/2"></div>
      <div class="relative">
        <div class="w-12 h-12 mx-auto mb-3 rounded-xl bg-blue-500/10 flex items-center justify-center"><i class="fas fa-robot text-blue-400 text-lg"></i></div>
        <div class="stat-num text-4xl text-blue-400 mb-1" id="statAvgAI">0</div>
        <div class="text-xs text-gray-500 font-medium">평균 AI 점수</div>
      </div>
    </div>
    <div class="glass-card rounded-2xl p-5 text-center relative overflow-hidden">
      <div class="absolute top-0 right-0 w-20 h-20 bg-orange-500/5 rounded-full -translate-y-1/2 translate-x-1/2"></div>
      <div class="relative">
        <div class="w-12 h-12 mx-auto mb-3 rounded-xl bg-accent-500/10 flex items-center justify-center"><i class="fas fa-heart text-accent-400 text-lg"></i></div>
        <div class="stat-num text-4xl text-accent-400 mb-1" id="statAvgHuman">0</div>
        <div class="text-xs text-gray-500 font-medium">평균 인간 점수</div>
      </div>
    </div>
  </div>
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
    <div class="glass-card rounded-2xl p-5">
      <h3 class="text-white font-bold text-base mb-4"><i class="fas fa-chart-line mr-2 text-accent-500"></i>점수 추이 (최근 10건)</h3>
      <canvas id="trendChart" height="220"></canvas>
    </div>
    <div class="glass-card rounded-2xl p-5">
      <h3 class="text-white font-bold text-base mb-4"><i class="fas fa-chart-bar mr-2 text-accent-500"></i>카테고리별 평균</h3>
      <canvas id="categoryChart" height="220"></canvas>
    </div>
  </div>
</div>

<!-- ===== TAB: SETTINGS ===== -->
<div id="panel-settings" class="hidden">
  <div class="max-w-2xl mx-auto space-y-5">
    <div class="glass-card rounded-2xl p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-12 h-12 bg-gradient-to-br from-accent-500 to-accent-600 rounded-xl flex items-center justify-center shadow-lg shadow-accent-500/20">
          <i class="fas fa-key text-white text-lg"></i>
        </div>
        <div>
          <h3 class="text-white font-bold text-lg">AI API 키 설정</h3>
          <p class="text-xs text-gray-400">API 키를 등록하여 AI 분석 기능을 활성화합니다</p>
        </div>
      </div>
      <div id="apiKeyAlert" class="hidden mb-4 px-4 py-3 rounded-xl text-sm"></div>
      <!-- Gemini -->
      <div class="bg-navy-900/40 rounded-2xl p-5 mb-3 border border-gray-800/50">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center">
              <i class="fas fa-gem text-blue-400"></i>
            </div>
            <div>
              <span class="text-sm font-semibold text-white">Google Gemini 2.5 Flash</span>
              <span id="geminiStatus" class="ml-2 text-[11px] px-2.5 py-0.5 rounded-full bg-gray-700/50 text-gray-400">미등록</span>
              <p class="text-[11px] text-gray-500 mt-0.5">가장 빠르고 효율적인 AI 엔진</p>
            </div>
          </div>
          <button onclick="toggleKeyInput('gemini')" class="w-9 h-9 rounded-lg bg-navy-700/50 flex items-center justify-center text-gray-400 hover:text-accent-500 hover:bg-accent-500/10 transition-all">
            <i class="fas fa-chevron-down text-xs"></i>
          </button>
        </div>
        <div id="geminiKeyInput" class="hidden mt-4 space-y-3">
          <div class="relative">
            <input id="geminiKeyField" type="password" placeholder="AIza... 형식의 Gemini API 키 입력"
              class="input-field w-full px-4 py-3 pr-10 text-sm">
            <button onclick="toggleKeyVisibility('geminiKeyField')" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors">
              <i class="fas fa-eye text-sm"></i>
            </button>
          </div>
          <div class="flex gap-2">
            <button onclick="saveApiKey('gemini')" class="flex-1 py-2.5 bg-accent-500 hover:bg-accent-600 text-white text-sm font-medium rounded-xl transition-all"><i class="fas fa-save mr-1.5"></i>저장</button>
            <button onclick="verifyApiKey('gemini')" class="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-xl transition-all"><i class="fas fa-check-double mr-1.5"></i>검증</button>
            <button onclick="deleteApiKey('gemini')" class="py-2.5 px-4 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm font-medium rounded-xl transition-all"><i class="fas fa-trash"></i></button>
          </div>
          <p class="text-[11px] text-gray-500"><i class="fas fa-circle-info mr-1 text-blue-400"></i><a href="https://aistudio.google.com/apikey" target="_blank" class="text-accent-500 hover:underline">Google AI Studio</a>에서 무료로 발급받을 수 있습니다.</p>
        </div>
      </div>
      <!-- OpenAI -->
      <div class="bg-navy-900/40 rounded-2xl p-5 mb-3 border border-gray-800/50 opacity-50">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 bg-green-500/10 rounded-xl flex items-center justify-center"><i class="fas fa-brain text-green-400"></i></div>
            <div><span class="text-sm font-semibold text-white">OpenAI GPT</span><span class="ml-2 text-[11px] px-2.5 py-0.5 rounded-full bg-gray-700/50 text-gray-500">Phase 2</span></div>
          </div>
          <i class="fas fa-lock text-gray-600"></i>
        </div>
      </div>
      <!-- Claude -->
      <div class="bg-navy-900/40 rounded-2xl p-5 border border-gray-800/50 opacity-50">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 bg-purple-500/10 rounded-xl flex items-center justify-center"><i class="fas fa-robot text-purple-400"></i></div>
            <div><span class="text-sm font-semibold text-white">Anthropic Claude</span><span class="ml-2 text-[11px] px-2.5 py-0.5 rounded-full bg-gray-700/50 text-gray-500">Phase 2</span></div>
          </div>
          <i class="fas fa-lock text-gray-600"></i>
        </div>
      </div>
    </div>
    <div class="glass-card rounded-2xl p-5">
      <h4 class="text-sm font-bold text-white mb-3"><i class="fas fa-shield-halved mr-2 text-green-400"></i>보안 안내</h4>
      <ul class="space-y-2 text-xs text-gray-400">
        <li class="flex items-start gap-2.5"><i class="fas fa-lock text-green-400 mt-0.5"></i>API 키는 암호화되어 서버에 안전하게 저장됩니다</li>
        <li class="flex items-start gap-2.5"><i class="fas fa-user-shield text-green-400 mt-0.5"></i>다른 사용자에게 절대 노출되지 않습니다</li>
        <li class="flex items-start gap-2.5"><i class="fas fa-rotate text-green-400 mt-0.5"></i>언제든지 변경하거나 삭제할 수 있습니다</li>
        <li class="flex items-start gap-2.5"><i class="fas fa-coins text-yellow-400 mt-0.5"></i>API 사용량에 따라 비용이 발생할 수 있습니다</li>
      </ul>
    </div>
  </div>
</div>

</main>
</div>

<!-- Toast notification -->
<div id="toast" class="toast"></div>

<script>
// ==================== STATE ====================
let currentUser=null,categories=[],radarChart=null,trendChart=null,categoryChart=null,historyOffset=0,hasValidApiKey=false,lastOriginalText='';
const API='';

// ==================== TOAST ====================
function showToast(msg,type='info'){
  const t=document.getElementById('toast');
  t.className='toast '+type;
  t.innerHTML='<i class="fas fa-'+(type==='success'?'check-circle':type==='error'?'circle-xmark':'circle-info')+' mr-2"></i>'+msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),3500);
}

// ==================== AUTH ====================
function enterApp(){
  const nickname=document.getElementById('nicknameInput').value.trim();
  if(!nickname){showToast('닉네임을 입력해주세요.','error');return}
  fetch(API+'/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname})})
  .then(r=>r.json()).then(data=>{
    if(data.error){showToast(data.error,'error');return}
    currentUser=data.user;
    document.getElementById('displayNickname').textContent=currentUser.nickname;
    document.getElementById('loginModal').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    loadCategories();
    checkApiKeyOnLogin();
  }).catch(e=>showToast('연결 오류: '+e.message,'error'));
}
function logout(){
  currentUser=null;
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('loginModal').classList.remove('hidden');
  document.getElementById('nicknameInput').value='';
}

// ==================== TABS ====================
function switchTab(tab){
  ['write','history','stats','settings'].forEach(t=>{
    const panel=document.getElementById('panel-'+t);
    const btn=document.getElementById('tab-'+t);
    panel.classList.toggle('hidden',t!==tab);
    if(t===tab){panel.classList.add('fade-up');btn.classList.add('active')}
    else{btn.classList.remove('active')}
  });
  if(tab==='history'){historyOffset=0;loadHistory()}
  if(tab==='stats')loadStats();
  if(tab==='settings')loadApiKeyStatus();
}

// ==================== CATEGORIES ====================
function loadCategories(){
  fetch(API+'/api/categories').then(r=>r.json()).then(data=>{
    categories=data.categories||[];
    const sel=document.getElementById('categorySelect');
    const filter=document.getElementById('historyFilter');
    sel.innerHTML='<option value="">선택 안함</option>';
    filter.innerHTML='<option value="">전체 카테고리</option>';
    categories.forEach(c=>{
      sel.innerHTML+='<option value="'+c.id+'">'+c.name+'</option>';
      filter.innerHTML+='<option value="'+c.id+'">'+c.name+'</option>';
    });
  });
}

// ==================== ANALYSIS ====================
document.getElementById('inputText').addEventListener('input',function(){
  const len=this.value.length;
  document.getElementById('charCount').textContent=len;
  document.getElementById('charBar').style.width=(len/3000*100)+'%';
  if(len>2700)document.getElementById('charBar').classList.add('bg-red-500');
  else document.getElementById('charBar').classList.remove('bg-red-500');
});

function analyzeText(){
  const text=document.getElementById('inputText').value.trim();
  if(!text){showToast('글을 입력해주세요.','error');return}
  if(!currentUser){showToast('로그인이 필요합니다.','error');return}
  if(!hasValidApiKey){showToast('설정 탭에서 API 키를 먼저 등록해주세요.','error');switchTab('settings');return}
  lastOriginalText=text;
  const categoryId=document.getElementById('categorySelect').value;
  const tone=document.getElementById('toneSelect').value;
  const btn=document.getElementById('analyzeBtn');
  btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin mr-2"></i>AI 분석 중...';
  document.getElementById('resultPlaceholder').classList.add('hidden');
  document.getElementById('resultContent').classList.add('hidden');
  document.getElementById('resultLoading').classList.remove('hidden');
  fetch(API+'/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,category_id:categoryId?parseInt(categoryId):null,user_id:currentUser.id,tone:tone||null})})
  .then(r=>r.json()).then(data=>{
    if(data.error){showToast(data.error,'error');document.getElementById('resultPlaceholder').classList.remove('hidden');document.getElementById('resultLoading').classList.add('hidden');return}
    displayResult(data.result);
    showToast('분석이 완료되었습니다!','success');
  }).catch(e=>{showToast('분석 오류: '+e.message,'error');document.getElementById('resultPlaceholder').classList.remove('hidden')})
  .finally(()=>{btn.disabled=false;btn.innerHTML='<i class="fas fa-wand-magic-sparkles mr-2"></i>이중 글쓰기 분석';document.getElementById('resultLoading').classList.add('hidden')});
}

function getGrade(score){
  if(score>=90)return{label:'S',cls:'bg-green-500/20 text-green-300',text:'score-excellent'};
  if(score>=75)return{label:'A',cls:'bg-lime-500/20 text-lime-300',text:'score-good'};
  if(score>=60)return{label:'B',cls:'bg-yellow-500/20 text-yellow-300',text:'score-average'};
  if(score>=40)return{label:'C',cls:'bg-orange-500/20 text-orange-300',text:'score-average'};
  return{label:'D',cls:'bg-red-500/20 text-red-300',text:'score-poor'};
}

function displayResult(result){
  document.getElementById('resultContent').classList.remove('hidden');
  const ai=result.analysis.ai_score,hu=result.analysis.human_score;
  const avg=Math.round((ai+hu)/2);
  const grade=getGrade(avg);
  document.getElementById('gradeLabel').className='px-3 py-1 rounded-full text-xs font-bold '+grade.cls;
  document.getElementById('gradeLabel').textContent='종합 '+grade.label+'등급 ('+avg+'점)';
  const circumference=376.99;
  animateScore('aiScoreNum',ai);animateScore('humanScoreNum',hu);
  setTimeout(()=>{
    document.getElementById('aiScoreRing').style.strokeDashoffset=circumference-(circumference*ai/100);
    document.getElementById('humanScoreRing').style.strokeDashoffset=circumference-(circumference*hu/100);
  },100);
  const ad=result.analysis.ai_details||{},hd=result.analysis.human_details||{};
  document.getElementById('detailNumbers').textContent=(ad.numbers||0)+'/40';
  document.getElementById('detailSource').textContent=(ad.source||0)+'/30';
  document.getElementById('detailStructure').textContent=(ad.structure||0)+'/30';
  document.getElementById('detailTarget').textContent=(hd.target||0)+'/30';
  document.getElementById('detailValue').textContent=(hd.value||0)+'/40';
  document.getElementById('detailEmpathy').textContent=(hd.empathy||0)+'/30';
  setTimeout(()=>{
    document.getElementById('barNumbers').style.width=((ad.numbers||0)/40*100)+'%';
    document.getElementById('barSource').style.width=((ad.source||0)/30*100)+'%';
    document.getElementById('barStructure').style.width=((ad.structure||0)/30*100)+'%';
    document.getElementById('barTarget').style.width=((hd.target||0)/30*100)+'%';
    document.getElementById('barValue').style.width=((hd.value||0)/40*100)+'%';
    document.getElementById('barEmpathy').style.width=((hd.empathy||0)/30*100)+'%';
  },200);
  updateRadarChart(ad,hd);
  // Checklist
  const cl=result.checklist||{};
  const items=[
    {key:'has_numbers',label:'수치 데이터',desc:'%, 금액, 기간 등',icon:'fa-hashtag'},
    {key:'has_source',label:'출처 명시',desc:'신뢰 출처, 측정 기간',icon:'fa-quote-right'},
    {key:'has_target',label:'대상 특정',desc:'누구에게 도움?',icon:'fa-user-check'},
    {key:'has_benefit',label:'변화 서술',desc:'어떤 변화/혜택?',icon:'fa-arrow-trend-up'},
    {key:'is_head_heavy',label:'두괄식 배치',desc:'핵심 키워드 전면',icon:'fa-heading'}
  ];
  let passCount=0;
  const checkHTML=items.map(item=>{
    const pass=cl[item.key];if(pass)passCount++;
    return '<div class="check-card '+(pass?'pass':'fail')+' flex items-center gap-3">'
      +'<div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 '+(pass?'bg-green-500/20':'bg-red-500/20')+'">'
      +'<i class="fas '+(pass?'fa-check':'fa-xmark')+' '+(pass?'text-green-400':'text-red-400')+'"></i></div>'
      +'<div><div class="text-sm font-medium '+(pass?'text-green-300':'text-red-300')+'">'+item.label+'</div>'
      +'<div class="text-[10px] text-gray-500">'+item.desc+'</div></div></div>';
  }).join('');
  document.getElementById('checklistArea').innerHTML=checkHTML;
  document.getElementById('checkScore').textContent=passCount+'/'+items.length+' 통과';
  document.getElementById('checkScore').className='text-sm font-bold '+(passCount>=4?'text-green-400':passCount>=2?'text-yellow-400':'text-red-400');
  // Feedback
  const feedbacks=result.analysis.feedback||[];
  document.getElementById('feedbackList').innerHTML=feedbacks.map((f,i)=>
    '<div class="slide-in flex items-start gap-3 p-3 rounded-xl bg-navy-900/30 border border-gray-800/30" style="animation-delay:'+(i*0.1)+'s">'
    +'<div class="w-7 h-7 rounded-lg bg-yellow-500/10 flex items-center justify-center flex-shrink-0 mt-0.5"><i class="fas fa-lightbulb text-yellow-400 text-xs"></i></div>'
    +'<p class="text-sm text-gray-300 leading-relaxed">'+f+'</p></div>'
  ).join('');
  // Before/After
  document.getElementById('beforeText').textContent=lastOriginalText;
  document.getElementById('revisedText').textContent=result.revised_text||'';
}

function animateScore(elId,target){
  const el=document.getElementById(elId);let current=0;
  const duration=1200,startTime=performance.now();
  function update(time){
    const elapsed=time-startTime;const progress=Math.min(elapsed/duration,1);
    const eased=1-Math.pow(1-progress,3);
    current=Math.round(eased*target);el.textContent=current;
    if(progress<1)requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

function updateRadarChart(ai,human){
  const ctx=document.getElementById('radarChart').getContext('2d');
  if(radarChart)radarChart.destroy();
  radarChart=new Chart(ctx,{type:'radar',data:{
    labels:['수치 데이터','출처/기간','두괄식 구조','대상 특정','변화/가치','공감 묘사'],
    datasets:[{
      label:'종합',
      data:[((ai.numbers||0)/40)*100,((ai.source||0)/30)*100,((ai.structure||0)/30)*100,((human.target||0)/30)*100,((human.value||0)/40)*100,((human.empathy||0)/30)*100],
      borderColor:'#a855f7',backgroundColor:'rgba(168,85,247,0.1)',borderWidth:2,
      pointBackgroundColor:function(ctx){return ctx.dataIndex<3?'#3b82f6':'#F97316'},
      pointBorderColor:function(ctx){return ctx.dataIndex<3?'rgba(59,130,246,0.3)':'rgba(249,115,22,0.3)'},
      pointRadius:5,pointHoverRadius:8,pointBorderWidth:3
    }]
  },options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{
    backgroundColor:'rgba(15,23,42,0.9)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,titleFont:{family:'Noto Sans KR'},bodyFont:{family:'Noto Sans KR'},
    callbacks:{label:function(ctx){const l=['수치(AI)','출처(AI)','구조(AI)','대상(Human)','가치(Human)','공감(Human)'];return l[ctx.dataIndex]+': '+Math.round(ctx.raw)+'%'}}
  }},scales:{r:{beginAtZero:true,max:100,grid:{color:'rgba(148,163,184,0.08)'},angleLines:{color:'rgba(148,163,184,0.08)'},
    pointLabels:{color:function(ctx){return ctx.index<3?'#60a5fa':'#fb923c'},font:{size:11,weight:'600',family:'Noto Sans KR'}},
    ticks:{display:false,stepSize:25}}}}});
}

function copyRevised(){
  const text=document.getElementById('revisedText').textContent;
  navigator.clipboard.writeText(text).then(()=>{
    const btn=document.getElementById('copyBtn');
    btn.innerHTML='<i class="fas fa-check"></i>복사 완료!';btn.classList.add('bg-green-500/20','text-green-400');
    setTimeout(()=>{btn.innerHTML='<i class="fas fa-copy"></i>교정문 복사';btn.classList.remove('bg-green-500/20','text-green-400')},2000);
    showToast('교정문이 클립보드에 복사되었습니다','success');
  });
}

// ==================== HISTORY ====================
function loadHistory(){
  if(!currentUser)return;historyOffset=0;
  const catId=document.getElementById('historyFilter').value;
  let url=API+'/api/logs?user_id='+currentUser.id+'&limit=10&offset=0';
  if(catId)url+='&category_id='+catId;
  fetch(url).then(r=>r.json()).then(data=>{
    const logs=data.logs||[];const container=document.getElementById('historyList');
    if(logs.length===0){
      container.innerHTML='<div class="flex flex-col items-center justify-center py-16 text-gray-500"><div class="w-16 h-16 rounded-2xl bg-navy-800/50 flex items-center justify-center mb-4"><i class="fas fa-inbox text-2xl text-gray-600"></i></div><p class="font-medium">교정 이력이 없습니다</p><p class="text-xs text-gray-600 mt-1">글쓰기 분석을 시작하면 이력이 쌓입니다</p></div>';
      document.getElementById('loadMoreArea').classList.add('hidden');return;
    }
    container.innerHTML=logs.map(renderHistoryItem).join('');
    document.getElementById('loadMoreArea').classList.toggle('hidden',logs.length<10);historyOffset=logs.length;
  });
}
function loadMoreHistory(){
  const catId=document.getElementById('historyFilter').value;
  let url=API+'/api/logs?user_id='+currentUser.id+'&limit=10&offset='+historyOffset;
  if(catId)url+='&category_id='+catId;
  fetch(url).then(r=>r.json()).then(data=>{
    const logs=data.logs||[];
    document.getElementById('historyList').innerHTML+=logs.map(renderHistoryItem).join('');
    document.getElementById('loadMoreArea').classList.toggle('hidden',logs.length<10);historyOffset+=logs.length;
  });
}
function renderHistoryItem(log){
  const aiG=getGrade(log.ai_score),huG=getGrade(log.human_score);
  return '<div class="glass-card rounded-2xl p-4 fade-up">'
    +'<div class="flex items-center justify-between mb-3">'
    +'<div class="flex items-center gap-2 flex-wrap">'
    +(log.category_name?'<span class="px-2.5 py-1 bg-accent-500/10 text-accent-400 text-[11px] rounded-lg font-medium">'+log.category_name+'</span>':'')
    +'<span class="text-[11px] text-gray-500">'+formatDate(log.created_at)+'</span></div>'
    +'<div class="flex gap-2">'
    +'<span class="px-2.5 py-1 rounded-lg text-[11px] font-bold '+aiG.cls+'"><i class="fas fa-robot mr-1"></i>'+log.ai_score+'</span>'
    +'<span class="px-2.5 py-1 rounded-lg text-[11px] font-bold '+huG.cls+'"><i class="fas fa-heart mr-1"></i>'+log.human_score+'</span>'
    +'</div></div>'
    +'<p class="text-xs text-gray-400 leading-relaxed line-clamp-2">'+(log.original_text||'').substring(0,200)+'</p>'
    +(log.revised_text?'<div class="mt-2 pt-2 border-t border-gray-800/50"><p class="text-xs text-gray-300 leading-relaxed line-clamp-2"><i class="fas fa-wand-magic-sparkles text-accent-500 mr-1"></i>'+(log.revised_text||'').substring(0,200)+'</p></div>':'')
    +'</div>';
}
function formatDate(d){if(!d)return'';try{return d.replace('T',' ').substring(0,16)}catch(e){return d}}

// ==================== STATS ====================
function loadStats(){
  if(!currentUser)return;
  fetch(API+'/api/stats?user_id='+currentUser.id).then(r=>r.json()).then(data=>{
    const s=data.stats||{};
    animateCounter('statTotal',s.total_writes||0);
    animateCounter('statAvgAI',s.avg_ai_score||0);
    animateCounter('statAvgHuman',s.avg_human_score||0);
    updateTrendChart((data.recentTrend||[]).reverse());
    updateCategoryChart(data.categoryStats||[]);
  });
}
function animateCounter(id,target){
  const el=document.getElementById(id);let c=0;
  const dur=800,start=performance.now();
  function upd(t){const p=Math.min((t-start)/dur,1);const e=1-Math.pow(1-p,3);c=Math.round(e*target);el.textContent=c;if(p<1)requestAnimationFrame(upd)}
  requestAnimationFrame(upd);
}
function updateTrendChart(trend){
  const ctx=document.getElementById('trendChart').getContext('2d');
  if(trendChart)trendChart.destroy();
  trendChart=new Chart(ctx,{type:'line',data:{
    labels:trend.map((_,i)=>'#'+(i+1)),
    datasets:[{label:'AI 점수',data:trend.map(t=>t.ai_score),borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,0.08)',tension:0.4,fill:true,pointRadius:5,pointBackgroundColor:'#3b82f6',pointBorderColor:'#0f172a',pointBorderWidth:2},
    {label:'인간 점수',data:trend.map(t=>t.human_score),borderColor:'#F97316',backgroundColor:'rgba(249,115,22,0.08)',tension:0.4,fill:true,pointRadius:5,pointBackgroundColor:'#F97316',pointBorderColor:'#0f172a',pointBorderWidth:2}]
  },options:{responsive:true,plugins:{legend:{labels:{color:'#94a3b8',usePointStyle:true,pointStyle:'circle',padding:20,font:{family:'Noto Sans KR'}}}},
    scales:{x:{ticks:{color:'#475569'},grid:{color:'rgba(148,163,184,0.06)'}},y:{min:0,max:100,ticks:{color:'#475569',stepSize:25},grid:{color:'rgba(148,163,184,0.06)'}}}}});
}
function updateCategoryChart(catStats){
  const ctx=document.getElementById('categoryChart').getContext('2d');
  if(categoryChart)categoryChart.destroy();
  if(!catStats.length){ctx.font='500 14px Noto Sans KR';ctx.fillStyle='#475569';ctx.textAlign='center';ctx.fillText('아직 데이터가 없습니다',ctx.canvas.width/2,ctx.canvas.height/2);return}
  categoryChart=new Chart(ctx,{type:'bar',data:{
    labels:catStats.map(c=>c.name),
    datasets:[{label:'AI',data:catStats.map(c=>c.avg_ai),backgroundColor:'rgba(59,130,246,0.6)',borderColor:'#3b82f6',borderWidth:1,borderRadius:6,borderSkipped:false},
    {label:'인간',data:catStats.map(c=>c.avg_human),backgroundColor:'rgba(249,115,22,0.6)',borderColor:'#F97316',borderWidth:1,borderRadius:6,borderSkipped:false}]
  },options:{responsive:true,plugins:{legend:{labels:{color:'#94a3b8',usePointStyle:true,pointStyle:'circle',padding:20,font:{family:'Noto Sans KR'}}}},
    scales:{x:{ticks:{color:'#475569'},grid:{display:false}},y:{min:0,max:100,ticks:{color:'#475569',stepSize:25},grid:{color:'rgba(148,163,184,0.06)'}}}}});
}

// ==================== API KEYS ====================
function checkApiKeyOnLogin(){
  fetch(API+'/api/keys?user_id='+currentUser.id).then(r=>r.json()).then(data=>{
    const keys=data.keys||[];const gemini=keys.find(k=>k.provider==='gemini');
    if(gemini&&gemini.is_valid){hasValidApiKey=true;document.getElementById('apiKeyBanner').classList.add('hidden')}
    else{hasValidApiKey=false;document.getElementById('apiKeyBanner').classList.remove('hidden')}
  });
}
function loadApiKeyStatus(){
  if(!currentUser)return;
  fetch(API+'/api/keys?user_id='+currentUser.id).then(r=>r.json()).then(data=>{
    const keys=data.keys||[];const gemini=keys.find(k=>k.provider==='gemini');const el=document.getElementById('geminiStatus');
    if(gemini){
      if(gemini.is_valid){el.className='ml-2 text-[11px] px-2.5 py-0.5 rounded-full bg-green-500/15 text-green-400 font-medium';el.textContent='활성';hasValidApiKey=true;document.getElementById('apiKeyBanner').classList.add('hidden')}
      else{el.className='ml-2 text-[11px] px-2.5 py-0.5 rounded-full bg-red-500/15 text-red-400 font-medium';el.textContent='유효하지 않음';hasValidApiKey=false}
    }else{el.className='ml-2 text-[11px] px-2.5 py-0.5 rounded-full bg-gray-700/50 text-gray-400';el.textContent='미등록';hasValidApiKey=false}
  });
}
function toggleKeyInput(p){document.getElementById(p+'KeyInput').classList.toggle('hidden')}
function toggleKeyVisibility(id){const f=document.getElementById(id);const b=f.nextElementSibling;if(f.type==='password'){f.type='text';b.innerHTML='<i class="fas fa-eye-slash text-sm"></i>'}else{f.type='password';b.innerHTML='<i class="fas fa-eye text-sm"></i>'}}
function showAlert(msg,type){const el=document.getElementById('apiKeyAlert');el.classList.remove('hidden');el.className='mb-4 px-4 py-3 rounded-xl text-sm flex items-center gap-2 '+(type==='success'?'bg-green-500/10 border border-green-500/20 text-green-300':type==='error'?'bg-red-500/10 border border-red-500/20 text-red-300':'bg-blue-500/10 border border-blue-500/20 text-blue-300');el.innerHTML='<i class="fas fa-'+(type==='success'?'check-circle':type==='error'?'circle-xmark':'circle-info')+'"></i>'+msg;setTimeout(()=>el.classList.add('hidden'),5000)}
function saveApiKey(p){
  const f=document.getElementById(p+'KeyField');const key=f.value.trim();
  if(!key){showAlert('API 키를 입력해주세요.','error');return}
  fetch(API+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:currentUser.id,provider:p,api_key:key})})
  .then(r=>r.json()).then(data=>{if(data.error){showAlert(data.error,'error');return}showAlert('API 키가 저장되었습니다. 검증 버튼을 눌러주세요.','success');f.value='';loadApiKeyStatus()}).catch(e=>showAlert('저장 오류: '+e.message,'error'));
}
function verifyApiKey(p){
  showAlert('API 키를 검증하고 있습니다...','info');
  fetch(API+'/api/keys/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:currentUser.id,provider:p})})
  .then(r=>r.json()).then(data=>{if(data.valid){showAlert('API 키가 정상 작동합니다!','success');showToast('API 키 검증 성공!','success')}else{showAlert('검증 실패: '+(data.error||'알 수 없는 오류'),'error')}loadApiKeyStatus()}).catch(e=>showAlert('검증 오류: '+e.message,'error'));
}
function deleteApiKey(p){
  if(!confirm('이 API 키를 삭제하시겠습니까?'))return;
  fetch(API+'/api/keys',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:currentUser.id,provider:p})})
  .then(r=>r.json()).then(data=>{if(data.error){showAlert(data.error,'error');return}showAlert('API 키가 삭제되었습니다.','success');hasValidApiKey=false;loadApiKeyStatus();document.getElementById('apiKeyBanner').classList.remove('hidden')}).catch(e=>showAlert('삭제 오류: '+e.message,'error'));
}
</script>
</body>
</html>`
}

export default app
