-- ai_details, human_details JSON 컬럼 추가 (세부 점수 이력 저장)
ALTER TABLE writing_logs ADD COLUMN ai_details_json TEXT DEFAULT '{}';
ALTER TABLE writing_logs ADD COLUMN human_details_json TEXT DEFAULT '{}';
