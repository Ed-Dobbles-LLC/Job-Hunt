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
        job_id SERIAL PRIMARY KEY,
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
        job_id INTEGER PRIMARY KEY REFERENCES jobs(job_id),
        total_score REAL,
        breakdown_json JSONB,
        match_report JSONB
      );

      ALTER TABLE scores ADD COLUMN IF NOT EXISTS match_report JSONB;

      CREATE TABLE IF NOT EXISTS artifacts (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(job_id),
        resume_docx_path TEXT,
        cover_docx_path TEXT,
        evidence_map_path TEXT,
        verifier_json_path TEXT,
        prompt_version TEXT,
        model_used TEXT,
        created_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        truth_pass BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS evidence_map (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(job_id),
        claim_id TEXT,
        claim_text TEXT,
        evidence_quote TEXT,
        evidence_source_key TEXT,
        confidence REAL
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(job_id),
        person_name TEXT,
        title TEXT,
        linkedin_url TEXT,
        email TEXT,
        rank INTEGER,
        rationale TEXT,
        message_draft TEXT
      );

      CREATE TABLE IF NOT EXISTS profile_sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'parsing',
        raw_resume_text TEXT,
        resume_filename TEXT,
        resume_format TEXT,
        current_draft JSONB,
        gaps JSONB DEFAULT '[]'::jsonb,
        qa_history JSONB DEFAULT '[]'::jsonb,
        interview_round INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finalized_at TIMESTAMPTZ
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
