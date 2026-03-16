"""Cloud SQL connection pool using pg8000."""

import os
import pg8000

_pool = None


def get_connection():
    """Get a pg8000 connection to Cloud SQL."""
    database_url = os.environ.get("DATABASE_URL", "")
    if database_url:
        # Parse DATABASE_URL: postgresql://user:pass@host:port/dbname
        from urllib.parse import urlparse
        parsed = urlparse(database_url)
        return pg8000.connect(
            host=parsed.hostname or "localhost",
            port=parsed.port or 5432,
            user=parsed.username or "postgres",
            password=parsed.password or "",
            database=parsed.path.lstrip("/") or "notetaker",
        )

    # Fallback: individual env vars
    return pg8000.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "5432")),
        user=os.environ.get("DB_USER", "postgres"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", "notetaker"),
    )


def update_meeting_status(meeting_id: str, status: str) -> None:
    """Update transcription_status for a meeting in Cloud SQL."""
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE meetings SET transcription_status = %s, updated_at = NOW() WHERE meeting_id = %s",
            (status, meeting_id),
        )
        conn.commit()
    finally:
        conn.close()
