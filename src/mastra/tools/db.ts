import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        start_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        end_ts TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'running',
        errors_json JSONB
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_id BIGSERIAL PRIMARY KEY,
        source TEXT,
        source_message_id TEXT,
        company TEXT,
        title TEXT,
        location TEXT,
        remote_hybrid TEXT,
        level TEXT DEFAULT 'Unknown',
        posting_url TEXT,
        date_posted TEXT,
        date_ingested TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        jd_raw_text TEXT,
        jd_hash TEXT,
        simhash TEXT,
        keywords JSONB DEFAULT '[]'::jsonb,
        url_canonical TEXT,
        status TEXT NOT NULL DEFAULT 'new'
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_jd_hash ON jobs(jd_hash) WHERE jd_hash IS NOT NULL;

      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS level TEXT DEFAULT 'Unknown';
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS simhash TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS keywords JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS jd_requirements JSONB;

      CREATE TABLE IF NOT EXISTS scores (
        job_id BIGINT PRIMARY KEY REFERENCES jobs(job_id),
        total_score REAL,
        breakdown_json JSONB,
        match_report JSONB
      );

      ALTER TABLE scores ADD COLUMN IF NOT EXISTS match_report JSONB;

      CREATE TABLE IF NOT EXISTS artifacts (
        id SERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES jobs(job_id),
        resume_docx_path TEXT,
        cover_docx_path TEXT,
        evidence_map_path TEXT,
        verifier_json_path TEXT,
        prompt_version TEXT,
        model_used TEXT,
        created_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        truth_pass BOOLEAN DEFAULT FALSE
      );

      -- Store DOCX/JSON blobs in DB so they survive Railway's ephemeral filesystem
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS resume_docx BYTEA;
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS cover_docx BYTEA;
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS evidence_map_json TEXT;
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS verifier_json TEXT;
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS reviewer_json TEXT;

      CREATE TABLE IF NOT EXISTS evidence_map (
        id SERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES jobs(job_id),
        claim_id TEXT,
        claim_text TEXT,
        evidence_quote TEXT,
        evidence_source_key TEXT,
        confidence REAL
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES jobs(job_id),
        person_name TEXT,
        title TEXT,
        linkedin_url TEXT,
        email TEXT,
        rank INTEGER,
        rationale TEXT,
        message_draft TEXT
      );

      -- Migrate existing tables from INTEGER to BIGINT for job_id
      ALTER TABLE jobs ALTER COLUMN job_id SET DATA TYPE BIGINT;
      ALTER TABLE scores ALTER COLUMN job_id SET DATA TYPE BIGINT;
      ALTER TABLE artifacts ALTER COLUMN job_id SET DATA TYPE BIGINT;
      ALTER TABLE evidence_map ALTER COLUMN job_id SET DATA TYPE BIGINT;
      ALTER TABLE contacts ALTER COLUMN job_id SET DATA TYPE BIGINT;

      CREATE TABLE IF NOT EXISTS profile_sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'parsing',
        raw_resume_text TEXT,
        resume_filename TEXT,
        resume_format TEXT,
        target_role TEXT DEFAULT '',
        interview_focus TEXT DEFAULT 'leadership',
        current_draft JSONB,
        gaps JSONB DEFAULT '[]'::jsonb,
        qa_history JSONB DEFAULT '[]'::jsonb,
        interview_round INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finalized_at TIMESTAMPTZ
      );

      ALTER TABLE profile_sessions ADD COLUMN IF NOT EXISTS target_role TEXT DEFAULT '';
      ALTER TABLE profile_sessions ADD COLUMN IF NOT EXISTS interview_focus TEXT DEFAULT '';

      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS compensation TEXT DEFAULT '';
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS user_action TEXT DEFAULT '';

      CREATE TABLE IF NOT EXISTS imported_emails (
        id SERIAL PRIMARY KEY,
        subject TEXT,
        from_address TEXT,
        date_received TIMESTAMPTZ,
        body TEXT,
        processed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS digests (
        digest_id SERIAL PRIMARY KEY,
        run_date DATE NOT NULL DEFAULT CURRENT_DATE,
        jobs_fetched INTEGER NOT NULL DEFAULT 0,
        jobs_scored INTEGER NOT NULL DEFAULT 0,
        jobs_shortlisted INTEGER NOT NULL DEFAULT 0,
        packets_generated INTEGER NOT NULL DEFAULT 0,
        truth_pass_count INTEGER NOT NULL DEFAULT 0,
        truth_fail_count INTEGER NOT NULL DEFAULT 0,
        email_sent BOOLEAN NOT NULL DEFAULT FALSE,
        sent_at TIMESTAMPTZ,
        recipient_email TEXT
      );

      CREATE TABLE IF NOT EXISTS resume_history (
        id SERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES jobs(job_id),
        target_company TEXT,
        target_role TEXT,
        summary_text TEXT,
        competencies JSONB DEFAULT '[]'::jsonb,
        top_bullets_by_role JSONB DEFAULT '[]'::jsonb,
        archetype_primary TEXT,
        key_phrases JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS processed_gmail_ids (
        gmail_id TEXT PRIMARY KEY,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        jobs_found INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS dedup_log (
        id SERIAL PRIMARY KEY,
        company TEXT,
        title TEXT,
        location TEXT,
        posting_url TEXT,
        reason TEXT NOT NULL,
        matched_job_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS llm_usage (
        id SERIAL PRIMARY KEY,
        request_id TEXT,
        job_id BIGINT REFERENCES jobs(job_id),
        run_id TEXT,
        label TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated BOOLEAN NOT NULL DEFAULT false,
        cost_usd DECIMAL(10, 6) NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        attempt INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        error_type TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Add missing columns and indexes to llm_usage (idempotent)
    await client.query(`
      ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS run_id TEXT;
      ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS error_type TEXT;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_llm_usage_job_id ON llm_usage(job_id);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_run_id ON llm_usage(run_id);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage(created_at);
    `);
  } finally {
    client.release();
  }
}

export async function query(text: string, params?: any[]): Promise<any> {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

export { pool };
