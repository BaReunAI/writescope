-- 사용자별 API 키 저장 테이블
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'gemini',
    api_key_encrypted TEXT NOT NULL,
    is_valid INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
    updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_provider ON api_keys(user_id, provider);
