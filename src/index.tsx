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
    const existing = await c.env.DB.prepare(
      'SELECT id, nickname FROM users WHERE nickname = ?'
    ).bind(trimmed).first()

    if (existing) {
      await c.env.DB.prepare(
        "UPDATE users SET last_active_at = DATETIME('now','localtime') WHERE id = ?"
      ).bind(existing.id).run()
      return c.json({ user: existing })
    }

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

app.post('/api/keys/verify', async (c) => {
  const { user_id, provider } = await c.req.json<{ user_id: number; provider: string }>()

  const keyRow = await c.env.DB.prepare(
    'SELECT api_key_encrypted FROM api_keys WHERE user_id = ? AND provider = ?'
  ).bind(user_id, provider).first<{ api_key_encrypted: string }>()

  if (!keyRow) return c.json({ valid: false, error: 'API 키가 등록되지 않았습니다.' })

  const apiKey = atob(keyRow.api_key_encrypted)

  try {
    if (provider === 'gemini') {
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

// --- ★ 샘플 데모 API (API 키 불필요) ---
app.get('/api/demo', async (c) => {
  return c.json({ result: SAMPLE_DEMO_RESULT })
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

  const keyRow = await c.env.DB.prepare(
    'SELECT api_key_encrypted, provider FROM api_keys WHERE user_id = ? AND provider = ? AND is_valid = 1'
  ).bind(user_id, 'gemini').first<{ api_key_encrypted: string; provider: string }>()

  if (!keyRow) {
    return c.json({ error: 'API 키가 설정되지 않았습니다. 설정 탭에서 Gemini API 키를 등록해주세요.' }, 400)
  }

  const apiKey = atob(keyRow.api_key_encrypted)

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

    // ★ ai_details_json, human_details_json도 함께 저장
    await c.env.DB.prepare(
      `INSERT INTO writing_logs (user_id, category_id, original_text, revised_text, ai_score, human_score, feedback, checklist_json, model_used, tone, ai_details_json, human_details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      tone || '',
      JSON.stringify(aiResult.analysis.ai_details || {}),
      JSON.stringify(aiResult.analysis.human_details || {})
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

// --- 개별 로그 조회 (상세) ---
app.get('/api/logs/:id', async (c) => {
  const id = c.req.param('id')
  const log = await c.env.DB.prepare(
    `SELECT wl.*, c.name as category_name FROM writing_logs wl
     LEFT JOIN categories c ON wl.category_id = c.id WHERE wl.id = ?`
  ).bind(parseInt(id)).first()

  if (!log) return c.json({ error: '이력을 찾을 수 없습니다.' }, 404)
  return c.json({ log })
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

  // ★ 성장 트래커: 첫 분석과 최근 분석 비교
  const firstWrite = await c.env.DB.prepare(`
    SELECT ai_score, human_score, created_at
    FROM writing_logs WHERE user_id = ?
    ORDER BY created_at ASC LIMIT 1
  `).bind(parseInt(userId)).first()

  const lastWrite = await c.env.DB.prepare(`
    SELECT ai_score, human_score, created_at
    FROM writing_logs WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(parseInt(userId)).first()

  return c.json({
    stats,
    recentTrend: recentTrend.results,
    categoryStats: categoryStats.results,
    growth: { first: firstWrite, last: lastWrite }
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

중요: 실제 글의 품질에 맞게 엄격하게 채점하세요. 모든 항목을 만점으로 주지 마세요.
- 수치 데이터가 전혀 없으면 numbers는 0~10점
- 수치가 1~2개이면 15~25점
- 3개 이상이고 구체적이면 30~40점
- 다른 항목도 마찬가지로 실제 포함 수준에 비례하여 세밀하게 채점

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

// ==================== 샘플 데모 데이터 ====================
const SAMPLE_DEMO_RESULT = {
  original_text: "요즘 ChatGPT가 인기가 많다. 많은 사람들이 사용하고 있고, 업무에 도움이 된다고 한다. 나도 써봤는데 꽤 괜찮았다. 앞으로 AI가 더 발전할 것 같다.",
  revised_text: "2026년 기준 ChatGPT 월간 활성 사용자 수가 3억 명을 돌파했다(OpenAI, 2026.03 발표). 특히 직장인 78%가 '보고서 작성 시간이 평균 42% 단축됐다'고 응답했으며(한국생산성본부, 2026.02 조사), 마케팅 담당자의 경우 콘텐츠 초안 작성 속도가 3.2배 빨라진 것으로 나타났다.\n\n매일 퇴근 후에도 밀린 보고서와 씨름하던 당신이라면, AI 글쓰기 도구 하나로 오후 6시 칼퇴의 일상을 경험할 수 있다. 실제로 국내 IT 기업 중 62%가 AI 작문 도구를 도입한 뒤, 직원 만족도가 평균 31점(100점 만점) 상승했다(잡코리아, 2026.01).\n\n결론적으로, AI 글쓰기 도구는 단순한 유행이 아니라 '시간을 버는 전략'이다. 지금 시작하면 3개월 후 당신의 업무 생산성은 눈에 띄게 달라져 있을 것이다.",
  result: {
    revised_text: "2026년 기준 ChatGPT 월간 활성 사용자 수가 3억 명을 돌파했다(OpenAI, 2026.03 발표). 특히 직장인 78%가 '보고서 작성 시간이 평균 42% 단축됐다'고 응답했으며(한국생산성본부, 2026.02 조사), 마케팅 담당자의 경우 콘텐츠 초안 작성 속도가 3.2배 빨라진 것으로 나타났다.\n\n매일 퇴근 후에도 밀린 보고서와 씨름하던 당신이라면, AI 글쓰기 도구 하나로 오후 6시 칼퇴의 일상을 경험할 수 있다. 실제로 국내 IT 기업 중 62%가 AI 작문 도구를 도입한 뒤, 직원 만족도가 평균 31점(100점 만점) 상승했다(잡코리아, 2026.01).\n\n결론적으로, AI 글쓰기 도구는 단순한 유행이 아니라 '시간을 버는 전략'이다. 지금 시작하면 3개월 후 당신의 업무 생산성은 눈에 띄게 달라져 있을 것이다.",
    analysis: {
      ai_score: 82,
      human_score: 75,
      ai_details: {
        numbers: 35,
        source: 25,
        structure: 22
      },
      human_details: {
        target: 24,
        value: 28,
        empathy: 23
      },
      feedback: [
        "수치 데이터가 풍부합니다. '3억 명', '78%', '42%', '3.2배', '62%', '31점' 등 구체적 숫자가 AI 검색 노출에 매우 유리합니다.",
        "출처 표기가 명확합니다. OpenAI, 한국생산성본부, 잡코리아 등 신뢰도 높은 기관을 인용하여 검색 엔진의 신뢰 점수를 높입니다.",
        "독자 대상('매일 퇴근 후에도 밀린 보고서와 씨름하던 당신')과 기대 변화('오후 6시 칼퇴')가 명확하여 공감도가 높습니다.",
        "개선 포인트: 두괄식 구조를 더 강화하면 좋겠습니다. 첫 문장에 '직장인 업무 효율 42% 향상'처럼 핵심 결론을 먼저 배치하세요.",
        "개선 포인트: 독자별 맞춤 시나리오(예: 마케터, 개발자, 기획자)를 추가하면 타겟 세그먼트별 공감도가 올라갑니다."
      ]
    },
    checklist: {
      has_numbers: true,
      has_source: true,
      has_target: true,
      has_benefit: true,
      is_head_heavy: false
    }
  }
}

// ==================== Frontend (static file serving) ====================
// Cloudflare Pages automatically serves files from public/ directory
// index.html, static/app.js, static/styles.css are all served automatically

export default app
