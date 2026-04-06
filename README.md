# DualWrite Pro

## Project Overview
- **Name**: DualWrite Pro (이중 글쓰기 어시스턴트)
- **Goal**: AI 검색 최적화(GEO)와 인간 공감을 동시에 만족하는 블로그 글쓰기 교정 도구
- **Formula**: 성(성과) · 기(기준) · 대(대상) · 변(변화) 공식 기반

## Features
### Completed (Phase 1 MVP)
- **Gemini 2.5 Flash** AI 엔진 기반 글 분석 및 교정
- **이중 점수 시스템**: AI 점수(수치/출처/구조) + 인간 점수(대상/가치/공감)
- **사용자별 API 키 관리**: 설정 탭에서 Gemini API 키 등록/검증/삭제
- **닉네임 로그인** (추후 정식 로그인 시스템으로 전환 대비)
- **8개 카테고리**: 맛집, IT/테크, 경제/재테크, 건강/운동, 여행, 자기계발, 육아/교육, 마케팅
- **대형 원형 게이지**: SVG 기반 그라데이션 애니메이션 + S/A/B/C/D 등급
- **6축 레이더 차트**: AI(블루) vs 인간(오렌지) 색상 구분
- **카드형 체크리스트**: 5항목 통과/실패 시각화 + 프로그레스 바
- **원문 vs 교정문 비교**: 좌우 Before/After 비교 뷰
- **교정 이력**: 카드형 UI + 카테고리 필터 + 페이지네이션
- **통계 대시보드**: 점수 추이 차트 + 카테고리별 평균 차트
- **프리미엄 UI**: 다크 네이비 + 오렌지, 글래스모피즘, 애니메이션

### Planned (Phase 2)
- OpenAI GPT / Claude 멀티 엔진 지원
- 정식 로그인 시스템 (이메일/소셜)
- GEO 리포트 생성
- 모바일 최적화

## Tech Stack
- **Backend**: Hono + TypeScript + Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: Tailwind CSS (CDN) + Chart.js + FontAwesome
- **AI Engine**: Google Gemini 2.5 Flash

## Data Architecture
- **users**: 닉네임 기반 사용자 (추후 이메일/패스워드 확장)
- **categories**: 가변적 카테고리 (동적 추가 가능)
- **api_keys**: 사용자별 AI API 키 (Base64 인코딩 저장)
- **writing_logs**: 원문/교정문/AI점수/인간점수/피드백/체크리스트

## Scoring System
### AI Score (100점)
| 항목 | 배점 | 설명 |
|------|------|------|
| 수치 데이터 | 40 | %, 금액, 기간 등 정량적 데이터 |
| 출처/기간 | 30 | 신뢰 출처, 측정 기간 명시 |
| 두괄식 구조 | 30 | 핵심 키워드 전면 배치 |

### Human Score (100점)
| 항목 | 배점 | 설명 |
|------|------|------|
| 대상 특정 | 30 | 누구에게 도움되는지 명확히 |
| 변화/가치 | 40 | 독자가 얻을 구체적 변화 |
| 공감 묘사 | 30 | 독자 상황 공감 + 스토리 |

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/users | 닉네임 로그인/생성 |
| GET | /api/categories | 카테고리 목록 |
| POST | /api/categories | 카테고리 추가 |
| POST | /api/keys | API 키 저장 |
| GET | /api/keys | API 키 상태 조회 |
| DELETE | /api/keys | API 키 삭제 |
| POST | /api/keys/verify | API 키 검증 |
| POST | /api/analyze | 글 분석 (Gemini AI) |
| GET | /api/logs | 교정 이력 조회 |
| GET | /api/stats | 통계 데이터 |

## Deployment
- **Platform**: Cloudflare Pages
- **Status**: Development (Local)
- **Design**: Dark Navy (#0a0f1e) + Orange (#F97316)
- **Last Updated**: 2026-04-06
