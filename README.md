# DualWrite Pro — AI + Human 이중 글쓰기 코치

## Project Overview
- **Name**: DualWrite Pro (WriteScope)
- **Goal**: AI 검색 최적화(GEO)와 인간 공감을 동시에 만족하는 이중 글쓰기 코칭 도구
- **Formula**: 성(성과) · 기(기준) · 대(대상) · 변(변화) 공식 기반 분석

## URLs
- **Production**: https://writescope.pages.dev
- **Sandbox**: https://3000-iv40r4e3e7svj5u7j9ww2-8f57ffe2.sandbox.novita.ai
- **API Base**: /api/*

## Completed Features (v2.0)
1. **샘플 데모 원클릭 체험** — API 키 없이 로그인 화면에서 바로 분석 결과 확인
2. **교정문 Diff 시각화** — 원문 대비 추가/삭제/유지 단어를 색상별 하이라이트
3. **성장 트래커** — 통계 탭에서 첫 분석 대비 점수 변화 + AI 인사이트 제공
4. **체크리스트 개선 예시** — 미통과 항목에 Before→After 구체 예시 표시
5. **모바일 반응형** — iOS 줌 방지, 터치 최적화, 반응형 레이아웃
6. **점수 실제 반영** — 세부 점수(ai_details, human_details) DB 저장 + 이력 복원 시 정확한 점수 표시
7. **AI 분석** — Gemini 2.5 Flash 기반 이중 글쓰기 채점 (AI 100점 + Human 100점)
8. **사용자 인증** — 닉네임 기반 로그인
9. **카테고리 분류** — 맛집, IT/테크, 경제, 건강, 여행, 자기계발, 육아, 마케팅 (8종)
10. **교정 이력** — 이력 조회, 상세 모달, 이력에서 원문+결과 복원
11. **통계 대시보드** — 점수 추이 차트, 카테고리별 평균 차트

## API Endpoints
| Method | Path | Params | Description |
|--------|------|--------|-------------|
| GET | /api/demo | - | 샘플 데모 분석 결과 (API 키 불필요) |
| POST | /api/users | nickname | 사용자 등록/로그인 |
| GET | /api/categories | - | 카테고리 목록 |
| POST | /api/analyze | text, user_id, category_id?, tone? | 이중 글쓰기 분석 |
| GET | /api/logs | user_id, limit?, offset?, category_id? | 교정 이력 조회 |
| GET | /api/logs/:id | - | 개별 이력 상세 |
| GET | /api/stats | user_id | 통계 + 성장 트래커 |
| POST | /api/keys | user_id, provider, api_key | API 키 저장 |
| GET | /api/keys | user_id | API 키 상태 조회 |
| POST | /api/keys/verify | user_id, provider | API 키 검증 |
| DELETE | /api/keys | user_id, provider | API 키 삭제 |

## Data Architecture
- **Database**: Cloudflare D1 (SQLite)
- **Tables**: users, categories, writing_logs, api_keys
- **Key Columns**: writing_logs에 ai_details_json, human_details_json 추가 (v2.0)

## Tech Stack
- **Backend**: Hono + TypeScript + Cloudflare Workers
- **Frontend**: Vanilla JS + TailwindCSS (CDN) + Chart.js
- **AI**: Google Gemini 2.5 Flash
- **Platform**: Cloudflare Pages

## User Guide
1. **빠른 체험**: 로그인 화면 → "샘플 데모 체험하기" 클릭
2. **실제 사용**: 닉네임 입력 → 설정 탭에서 Gemini API 키 등록 → 글쓰기 분석
3. **Diff 비교**: 분석 결과 하단 → "Diff 비교" 버튼으로 변경점 확인
4. **성장 확인**: 통계 탭 → 성장 트래커에서 첫 분석 대비 변화 확인

## Deployment
- **Platform**: Cloudflare Pages
- **Status**: Active (프로덕션 배포 완료)
- **Last Updated**: 2026-04-06
