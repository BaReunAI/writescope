-- WriteScope DB Schema
-- 카테고리 테이블 (가변적 확장 가능)
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    tone_instruction TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
);

-- 사용자 테이블 (닉네임 기반, 추후 로그인 전환 대비)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL UNIQUE,
    email TEXT,
    password_hash TEXT,
    auth_type TEXT DEFAULT 'nickname',
    created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
    last_active_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
);

-- 글쓰기 교정 이력 테이블
CREATE TABLE IF NOT EXISTS writing_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category_id INTEGER,
    original_text TEXT NOT NULL,
    revised_text TEXT,
    ai_score INTEGER DEFAULT 0,
    human_score INTEGER DEFAULT 0,
    feedback TEXT,
    checklist_json TEXT,
    model_used TEXT DEFAULT 'gemini',
    tone TEXT,
    created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_writing_logs_user_id ON writing_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_writing_logs_category_id ON writing_logs(category_id);
CREATE INDEX IF NOT EXISTS idx_writing_logs_created_at ON writing_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);
