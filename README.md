# DualWrite Pro

## Project Overview
- **Name**: DualWrite Pro (WriteScope)
- **Goal**: AI + Human 이중 글쓰기 분석 도구. 블로그 글의 AI 검색 최적화(GEO)와 인간 공감 점수를 동시에 분석/교정
- **핵심 공식**: 성(성과) · 기(기준) · 대(대상) · 변(변화) 기반 분석

## URLs
- **Sandbox**: https://3000-iv40r4e3e7svj5u7j9ww2-8f57ffe2.sandbox.novita.ai

## 완료된 기능
- 닉네임 기반 로그인/로그아웃
- 8개 카테고리 (맛집, IT/테크, 경제/재테크, 건강/운동, 여행, 자기계발, 육아/교육, 마케팅)
- Gemini 2.5 Flash 기반 AI 분석 (성·기·대·변 공식)
- AI 점수 + 인간 점수 이중 채점 (원형 게이지, 세부 프로그레스바)
- 6축 레이더 차트 (수치/출처/구조/대상/가치/공감)
- 5항목 체크리스트 (수치, 출처, 대상, 변화, 두괄식)
- AI 피드백 카드
- **교정문 가독성 대폭 개선**: 밝은 노란 배경, 16px 폰트, line-height 2.0, 문단 자동 구분, 숫자/인용 하이라이트
- **교정 이력 불러오기**: 이력 카드 클릭 → 원문/교정문 복원 + 상세 모달 팝업
- 카테고리 필터링, 더 보기 페이지네이션
- 통계 대시보드 (총 분석수, 평균 점수, 추이 차트, 카테고리별 차트)
- API 키 관리 (저장/검증/삭제)
- 교정문 클립보드 복사

## 아키텍처
```
src/index.tsx          → 백엔드 API만 (Hono)
public/index.html      → 프론트엔드 HTML
public/static/app.js   → 프론트엔드 JavaScript (순수 JS, 이스케이프 문제 없음)
public/static/styles.css → 프론트엔드 CSS
public/_routes.json    → /api/* 만 워커로, 나머지는 정적 파일
```

## API 엔드포인트
| Method | Path | 설명 |
|--------|------|------|
| POST | /api/users | 닉네임 로그인/생성 |
| GET | /api/categories | 카테고리 목록 |
| POST | /api/categories | 카테고리 추가 |
| POST | /api/keys | API 키 저장 |
| GET | /api/keys?user_id= | API 키 상태 조회 |
| DELETE | /api/keys | API 키 삭제 |
| POST | /api/keys/verify | API 키 검증 |
| POST | /api/analyze | 이중 글쓰기 분석 (핵심) |
| GET | /api/logs?user_id= | 교정 이력 조회 |
| GET | /api/logs/:id | 개별 이력 상세 |
| GET | /api/stats?user_id= | 통계 조회 |

## Data Architecture
- **Database**: Cloudflare D1 (SQLite)
- **Tables**: categories, users, writing_logs, api_keys
- **AI Engine**: Google Gemini 2.5 Flash

## User Guide
1. 닉네임 입력 후 시작
2. 설정 탭에서 Gemini API 키 등록 (Google AI Studio에서 무료 발급)
3. 글쓰기 분석 탭에서 블로그 글 입력 → 분석 버튼 클릭
4. AI/인간 점수, 체크리스트, 피드백, 원문/교정문 비교 확인
5. 교정 이력 탭에서 과거 분석 결과 확인 및 불러오기

## Deployment
- **Platform**: Cloudflare Pages
- **Tech Stack**: Hono + TypeScript + Tailwind CSS (CDN) + Chart.js
- **Last Updated**: 2026-04-06

## 미구현/보류
- OpenAI GPT / Claude 연동 (Phase 2)
- Cloudflare Pages 프로덕션 배포
- 사용자별 카테고리 커스텀 추가 UI
