"""
Job Tracker
Track job applications on your own computer: a table with a status
dropdown, a pop-up with job info, job description, contacts, a dated log
and PDF attachments, and charts.

On first run, choose a folder outside this project for the database and
PDFs. The folder location is remembered in your home directory.

The interface lives in templates/index.html and static/.

Run:   python app.py      (or double-click run.bat)
Open:  http://127.0.0.1:5001   (opens automatically)
"""

from __future__ import annotations

import datetime as dt
import json
import re
import sqlite3
import threading
import uuid
import webbrowser
from pathlib import Path
from typing import Optional

from flask import Flask, g, jsonify, redirect, render_template, request, send_file, url_for
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

# ==============================================================================
# SETTINGS
# ==============================================================================

BASE_DIR = Path(__file__).resolve().parent
CONFIG_DIR = Path.home() / ".job-tracker"
CONFIG_PATH = CONFIG_DIR / "config.json"
DEFAULT_DATA_DIR = Path.home() / "JobTrackerData"


def path_is_inside_project(path: Path) -> bool:
    return path == BASE_DIR or BASE_DIR in path.parents


def load_storage_config():
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, None
    except (OSError, json.JSONDecodeError):
        return None, "Could not read the saved data-folder setting. Choose a folder again."

    if not isinstance(config, dict) or not isinstance(config.get("data_dir"), str) or not config["data_dir"].strip():
        return None, "The saved data-folder setting is invalid. Choose a folder again."

    try:
        data_dir = Path(config["data_dir"]).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None, "The saved data-folder setting is invalid. Choose a folder again."
    if path_is_inside_project(data_dir):
        return None, "The saved data folder is inside the project. Choose a folder outside it."
    return data_dir, None


CONFIGURED_DATA_DIR, CONFIG_ERROR = load_storage_config()
STORAGE_CONFIGURED = CONFIGURED_DATA_DIR is not None
DATA_DIR = CONFIGURED_DATA_DIR or DEFAULT_DATA_DIR
FILES_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "jobs.db"
STORAGE_ERROR = CONFIG_ERROR
STORAGE_INITIALIZED = False

HOST, PORT = "127.0.0.1", 5001      # 5001 so it can run next to SQL Explorer (5000)
MAX_PDF_MB = 25

STATUSES = ["Applied", "Interviewing", "Negotiating", "Offer",
            "Accepted", "Rejected", "Ghosted", "Withdrawn"]
CLOSED_STATUSES = ["Accepted", "Rejected", "Ghosted", "Withdrawn"]   # no follow-up reminders
ATTACHMENT_KINDS = {"resume": "Resume", "cover_letter": "Cover letter"}

APP_FIELDS = {
    "company": "Company", "title": "Job title", "status": "Status",
    "location": "Location", "salary": "Salary", "job_url": "Job link",
    "post_date": "Post date", "applied_date": "Applied date", "follow_up_date": "Follow-up date",
    "description": "Job description",
}
DATE_FIELDS = {"post_date", "applied_date", "follow_up_date"}
CONTACT_FIELDS = ["name", "role", "email", "phone", "linkedin", "notes"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS applications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,   -- never reused, so #14 always means the same job
    company         TEXT NOT NULL,
    title           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'Applied',
    location        TEXT NOT NULL DEFAULT '',
    salary          TEXT NOT NULL DEFAULT '',
    job_url         TEXT NOT NULL DEFAULT '',
    post_date       TEXT,
    applied_date    TEXT,
    follow_up_date  TEXT,
    description     TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',             -- migrated to logs on database initialization
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id  INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT '',
    role            TEXT NOT NULL DEFAULT '',
    email           TEXT NOT NULL DEFAULT '',
    phone           TEXT NOT NULL DEFAULT '',
    linkedin        TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id  INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    log_date        TEXT NOT NULL,
    status          TEXT NOT NULL,
    notes           TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id  INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,                       -- 'resume' or 'cover_letter'
    filename        TEXT NOT NULL,                       -- the name you uploaded it as
    stored_name     TEXT NOT NULL,                       -- the name in data/files
    size            INTEGER NOT NULL,
    uploaded_at     TEXT NOT NULL,
    UNIQUE (application_id, kind)                        -- one resume and one cover letter per application
);

CREATE INDEX IF NOT EXISTS idx_contacts_application ON contacts(application_id);
CREATE INDEX IF NOT EXISTS idx_logs_application ON logs(application_id, log_date, id);
"""

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_PDF_MB * 1024 * 1024


# ==============================================================================
# ERRORS
# ==============================================================================

class ApiError(Exception):
    """An error the browser should show to the user."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def handle_api_error(err: ApiError):
    return jsonify({"error": err.message}), err.status


@app.errorhandler(RequestEntityTooLarge)
def handle_too_large(_err):
    return jsonify({"error": f"That file is too big. PDFs can be up to {MAX_PDF_MB} MB."}), 413


@app.errorhandler(Exception)
def handle_unexpected(err: Exception):
    if isinstance(err, HTTPException):
        if request.path.startswith("/api/"):
            return jsonify({"error": err.description}), err.code
        return err
    app.logger.exception(err)
    return jsonify({"error": f"Something went wrong on the server: {err}"}), 500


@app.before_request
def require_storage_for_api():
    if request.path.startswith("/api/") and not storage_ready():
        raise ApiError("Choose or create a data folder before using Job Tracker.", 503)


# ==============================================================================
# DATABASE
# ==============================================================================

def init_db(data_dir: Optional[Path] = None) -> None:
    data_dir = data_dir or DATA_DIR
    (data_dir / "files").mkdir(parents=True, exist_ok=True, mode=0o700)
    with sqlite3.connect(data_dir / "jobs.db") as conn:
        conn.executescript(SCHEMA)
        legacy_notes = conn.execute(
            "SELECT id, status, notes FROM applications WHERE trim(notes) <> ''"
        ).fetchall()
        if legacy_notes:
            stamp = now()
            log_date = dt.date.today().isoformat()
            conn.executemany(
                """INSERT INTO logs
                   (application_id, log_date, status, notes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                [(app_id, log_date, status, notes, stamp, stamp)
                 for app_id, status, notes in legacy_notes],
            )
            conn.executemany(
                "UPDATE applications SET notes = '' WHERE id = ?",
                [(app_id,) for app_id, _, _ in legacy_notes],
            )


def save_storage_config(data_dir: Path) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary_path = CONFIG_PATH.with_name(f"{CONFIG_PATH.name}.tmp")
    temporary_path.write_text(
        json.dumps({"data_dir": str(data_dir)}, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(CONFIG_PATH)


def storage_ready() -> bool:
    global STORAGE_ERROR, STORAGE_INITIALIZED
    if not STORAGE_CONFIGURED:
        return False
    if not DATA_DIR.is_dir():
        STORAGE_INITIALIZED = False
        STORAGE_ERROR = f"The saved data folder was not found: {DATA_DIR}"
        return False
    if STORAGE_INITIALIZED and DB_PATH.is_file() and FILES_DIR.is_dir():
        return True
    try:
        init_db()
    except (OSError, sqlite3.Error) as err:
        app.logger.exception("Could not initialize the data folder %s", DATA_DIR)
        STORAGE_INITIALIZED = False
        STORAGE_ERROR = f"Could not use the saved data folder: {err}"
        return False
    STORAGE_ERROR = None
    STORAGE_INITIALIZED = True
    return True


def db() -> sqlite3.Connection:
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def touch(app_id: int) -> None:
    db().execute("UPDATE applications SET updated_at = ? WHERE id = ?", (now(), app_id))


def get_application_row(app_id: int) -> sqlite3.Row:
    row = db().execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    if row is None:
        raise ApiError(f"Application #{app_id} doesn't exist.", 404)
    return row


# ==============================================================================
# CLEANING INPUT
# ==============================================================================

def clean_application(body: dict, partial: bool) -> dict:
    out = {}
    for field, label in APP_FIELDS.items():
        if field not in body:
            continue
        value = body[field]
        value = "" if value is None else str(value).strip()

        if field in DATE_FIELDS:
            if value:
                try:
                    dt.date.fromisoformat(value)
                except ValueError:
                    raise ApiError(f"{label} must be a date.")
            value = value or None
        elif field == "status":
            if value not in STATUSES:
                raise ApiError(f"Status must be one of: {', '.join(STATUSES)}.")
        elif field in ("company", "title"):
            if not value:
                raise ApiError(f"{label} can't be empty.")
        elif field == "job_url" and value and not re.match(r"^https?://", value, re.I):
            value = "https://" + value
        out[field] = value

    if not partial:
        if not out.get("company") or not out.get("title"):
            raise ApiError("Company and job title are both needed.")
        out.setdefault("status", "Applied")
    return out


def clean_contact(body: dict) -> dict:
    out = {f: str(body.get(f) or "").strip() for f in CONTACT_FIELDS if f in body}
    if "linkedin" in out and out["linkedin"] and not re.match(r"^https?://", out["linkedin"], re.I):
        out["linkedin"] = "https://" + out["linkedin"]
    return out


def clean_log(body: dict, partial: bool) -> dict:
    if not isinstance(body, dict):
        raise ApiError("A log must be an object.")
    out = {}
    for field in ("log_date", "status", "notes"):
        if field not in body:
            continue
        value = str(body[field] or "").strip()
        if field == "log_date":
            if not value:
                raise ApiError("Log date can't be empty.")
            try:
                dt.date.fromisoformat(value)
            except ValueError:
                raise ApiError("Log date must be a date.")
        elif field == "status" and value not in STATUSES:
            raise ApiError(f"Status must be one of: {', '.join(STATUSES)}.")
        elif field == "notes" and not value:
            raise ApiError("Log notes can't be empty.")
        out[field] = value

    if not partial and any(field not in out for field in ("log_date", "status", "notes")):
        raise ApiError("A log needs a date, status, and notes.")
    return out


# ==============================================================================
# SHAPING RESPONSES
# ==============================================================================

def attachment_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "kind": row["kind"], "label": ATTACHMENT_KINDS.get(row["kind"], row["kind"]),
        "filename": row["filename"], "size": row["size"], "uploaded_at": row["uploaded_at"],
        "url": f"/api/attachments/{row['id']}",
    }


def application_detail(app_id: int) -> dict:
    data = dict(get_application_row(app_id))
    data["contacts"] = [dict(r) for r in db().execute(
        "SELECT * FROM contacts WHERE application_id = ? ORDER BY id", (app_id,))]
    data["logs"] = [dict(r) for r in db().execute(
        "SELECT * FROM logs WHERE application_id = ? ORDER BY log_date DESC, id DESC", (app_id,))]
    data["log_text"] = "\n".join(
        f"{row['log_date']} [{row['status']}] {row['notes']}" for row in data["logs"])
    data["attachments"] = [attachment_json(r) for r in db().execute(
        "SELECT * FROM attachments WHERE application_id = ? ORDER BY kind DESC", (app_id,))]
    return data


# ==============================================================================
# ROUTES: page and settings
# ==============================================================================

@app.get("/")
def index():
    if not storage_ready():
        missing_dir = str(DATA_DIR) if STORAGE_CONFIGURED and not DATA_DIR.is_dir() else None
        form_dir = DEFAULT_DATA_DIR if missing_dir else DATA_DIR
        return render_template(
            "setup.html",
            data_dir=str(form_dir),
            error=STORAGE_ERROR,
            missing_dir=missing_dir,
            recommended_dir=str(DEFAULT_DATA_DIR),
        )
    return render_template("index.html")


@app.post("/setup/storage")
def setup_storage():
    global DATA_DIR, FILES_DIR, DB_PATH, STORAGE_CONFIGURED, STORAGE_ERROR, STORAGE_INITIALIZED

    if storage_ready():
        return redirect(url_for("index"))

    raw_dir = request.form.get("data_dir", "").strip()
    if not raw_dir:
        return render_template(
            "setup.html", data_dir="", error="Enter a folder path.",
            missing_dir=None, recommended_dir=str(DEFAULT_DATA_DIR),
        ), 400

    try:
        requested_dir = Path(raw_dir).expanduser()
        if not requested_dir.is_absolute():
            requested_dir = Path.home() / requested_dir
        data_dir = requested_dir.resolve()
    except (OSError, RuntimeError, ValueError) as err:
        return render_template(
            "setup.html", data_dir=raw_dir, error=f"That folder path is not valid: {err}",
            missing_dir=None, recommended_dir=str(DEFAULT_DATA_DIR),
        ), 400

    if path_is_inside_project(data_dir):
        return render_template(
            "setup.html",
            data_dir=raw_dir,
            error="Choose a folder outside the Job Tracker project so personal data cannot be added to GitHub.",
            missing_dir=None,
            recommended_dir=str(DEFAULT_DATA_DIR),
        ), 400

    try:
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        init_db(data_dir)
        save_storage_config(data_dir)
    except (OSError, sqlite3.Error) as err:
        app.logger.exception("Could not set up the data folder %s", data_dir)
        STORAGE_ERROR = f"Could not set up that folder: {err}"
        return render_template(
            "setup.html",
            data_dir=raw_dir,
            error=STORAGE_ERROR,
            missing_dir=None,
            recommended_dir=str(DEFAULT_DATA_DIR),
        ), 400

    DATA_DIR = data_dir
    FILES_DIR = data_dir / "files"
    DB_PATH = data_dir / "jobs.db"
    STORAGE_CONFIGURED = True
    STORAGE_ERROR = None
    STORAGE_INITIALIZED = True
    return redirect(url_for("index"))


@app.get("/api/meta")
def api_meta():
    return jsonify({
        "statuses": STATUSES,
        "closed_statuses": CLOSED_STATUSES,
        "attachment_kinds": ATTACHMENT_KINDS,
        "max_pdf_mb": MAX_PDF_MB,
    })


# ==============================================================================
# ROUTES: applications
# ==============================================================================

@app.get("/api/applications")
def list_applications():
    rows = db().execute("""
        SELECT a.*,
               (SELECT group_concat(c.name, ', ') FROM contacts c WHERE c.application_id = a.id) AS contact_names,
               (SELECT count(*) FROM contacts c WHERE c.application_id = a.id)                   AS contact_count,
               (SELECT group_concat(t.kind) FROM attachments t WHERE t.application_id = a.id)    AS attachment_kinds,
               (SELECT group_concat(l.log_date || ' [' || l.status || '] ' || l.notes, char(10))
                  FROM logs l WHERE l.application_id = a.id)                                     AS log_text
        FROM applications a
        ORDER BY a.id DESC
    """).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/applications")
def create_application():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        body = {}
    fields = clean_application(body, partial=False)
    initial_log = str(body.get("initial_log") or body.get("notes") or "").strip()
    stamp = now()
    fields.update(created_at=stamp, updated_at=stamp)
    cols = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    cur = db().execute(f"INSERT INTO applications ({cols}) VALUES ({marks})", tuple(fields.values()))
    if initial_log:
        db().execute(
            """INSERT INTO logs
               (application_id, log_date, status, notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (cur.lastrowid, dt.date.today().isoformat(), fields["status"], initial_log, stamp, stamp),
        )
    db().commit()
    return jsonify(application_detail(cur.lastrowid)), 201


@app.get("/api/applications/<int:app_id>")
def get_application(app_id: int):
    return jsonify(application_detail(app_id))


@app.patch("/api/applications/<int:app_id>")
def update_application(app_id: int):
    get_application_row(app_id)
    fields = clean_application(request.get_json(silent=True) or {}, partial=True)
    if fields:
        fields["updated_at"] = now()
        sets = ", ".join(f"{k} = ?" for k in fields)
        db().execute(f"UPDATE applications SET {sets} WHERE id = ?", (*fields.values(), app_id))
        db().commit()
    return jsonify(application_detail(app_id))


@app.delete("/api/applications/<int:app_id>")
def delete_application(app_id: int):
    get_application_row(app_id)
    stored = [r["stored_name"] for r in db().execute(
        "SELECT stored_name FROM attachments WHERE application_id = ?", (app_id,))]
    db().execute("DELETE FROM applications WHERE id = ?", (app_id,))   # contacts and attachments go with it
    db().commit()
    for name in stored:
        (FILES_DIR / name).unlink(missing_ok=True)
    return jsonify({"deleted": app_id})


# ==============================================================================
# ROUTES: application logs
# ==============================================================================

@app.post("/api/applications/<int:app_id>/logs")
def add_log(app_id: int):
    get_application_row(app_id)
    fields = clean_log(request.get_json(silent=True) or {}, partial=False)
    stamp = now()
    fields.update(application_id=app_id, created_at=stamp, updated_at=stamp)
    cols = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    db().execute(f"INSERT INTO logs ({cols}) VALUES ({marks})", tuple(fields.values()))
    touch(app_id)
    db().commit()
    return jsonify(application_detail(app_id)), 201


@app.patch("/api/logs/<int:log_id>")
def update_log(log_id: int):
    row = db().execute("SELECT application_id FROM logs WHERE id = ?", (log_id,)).fetchone()
    if row is None:
        raise ApiError("That log doesn't exist.", 404)
    fields = clean_log(request.get_json(silent=True) or {}, partial=True)
    if fields:
        fields["updated_at"] = now()
        sets = ", ".join(f"{key} = ?" for key in fields)
        db().execute(f"UPDATE logs SET {sets} WHERE id = ?", (*fields.values(), log_id))
        touch(row["application_id"])
        db().commit()
    return jsonify(application_detail(row["application_id"]))


@app.delete("/api/logs/<int:log_id>")
def delete_log(log_id: int):
    row = db().execute("SELECT application_id FROM logs WHERE id = ?", (log_id,)).fetchone()
    if row is None:
        raise ApiError("That log doesn't exist.", 404)
    db().execute("DELETE FROM logs WHERE id = ?", (log_id,))
    touch(row["application_id"])
    db().commit()
    return jsonify(application_detail(row["application_id"]))


# ==============================================================================
# ROUTES: contacts
# ==============================================================================

@app.post("/api/applications/<int:app_id>/contacts")
def add_contact(app_id: int):
    get_application_row(app_id)
    fields = clean_contact(request.get_json(silent=True) or {})
    if not fields.get("name"):
        raise ApiError("A contact needs at least a name.")
    fields.update(application_id=app_id, created_at=now())
    cols = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    cur = db().execute(f"INSERT INTO contacts ({cols}) VALUES ({marks})", tuple(fields.values()))
    touch(app_id)
    db().commit()
    return jsonify(dict(db().execute("SELECT * FROM contacts WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.patch("/api/contacts/<int:contact_id>")
def update_contact(contact_id: int):
    row = db().execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()
    if row is None:
        raise ApiError("That contact doesn't exist.", 404)
    fields = clean_contact(request.get_json(silent=True) or {})
    if "name" in fields and not fields["name"]:
        raise ApiError("A contact needs at least a name.")
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        db().execute(f"UPDATE contacts SET {sets} WHERE id = ?", (*fields.values(), contact_id))
        touch(row["application_id"])
        db().commit()
    return jsonify(dict(db().execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()))


@app.delete("/api/contacts/<int:contact_id>")
def delete_contact(contact_id: int):
    row = db().execute("SELECT application_id FROM contacts WHERE id = ?", (contact_id,)).fetchone()
    if row is None:
        raise ApiError("That contact doesn't exist.", 404)
    db().execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
    touch(row["application_id"])
    db().commit()
    return jsonify({"deleted": contact_id})


# ==============================================================================
# ROUTES: PDF attachments
# ==============================================================================

@app.post("/api/applications/<int:app_id>/attachments/<kind>")
def upload_attachment(app_id: int, kind: str):
    if kind not in ATTACHMENT_KINDS:
        raise ApiError("Unknown attachment type.", 404)
    get_application_row(app_id)

    upload = request.files.get("file")
    if upload is None or not upload.filename:
        raise ApiError("No file was sent.")
    head = upload.stream.read(5)
    upload.stream.seek(0)
    if not upload.filename.lower().endswith(".pdf") or head != b"%PDF-":
        raise ApiError("Only PDF files can be attached.")

    original = Path(upload.filename).name
    stored = f"{app_id}_{kind}_{uuid.uuid4().hex[:10]}.pdf"
    dest = FILES_DIR / stored
    upload.save(dest)

    old = db().execute("SELECT stored_name FROM attachments WHERE application_id = ? AND kind = ?",
                       (app_id, kind)).fetchone()
    db().execute("""
        INSERT INTO attachments (application_id, kind, filename, stored_name, size, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (application_id, kind) DO UPDATE SET
            filename = excluded.filename, stored_name = excluded.stored_name,
            size = excluded.size, uploaded_at = excluded.uploaded_at
    """, (app_id, kind, original, stored, dest.stat().st_size, now()))
    touch(app_id)
    db().commit()
    if old:                                   # remove the replaced PDF from the selected storage folder
        (FILES_DIR / old["stored_name"]).unlink(missing_ok=True)

    row = db().execute("SELECT * FROM attachments WHERE application_id = ? AND kind = ?",
                       (app_id, kind)).fetchone()
    return jsonify(attachment_json(row)), 201


@app.get("/api/attachments/<int:att_id>")
def open_attachment(att_id: int):
    row = db().execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if row is None:
        raise ApiError("That file doesn't exist.", 404)
    path = FILES_DIR / row["stored_name"]
    if not path.is_file():
        raise ApiError(f"The file {row['filename']} is missing from the data folder's files directory.", 404)
    return send_file(path, mimetype="application/pdf", download_name=row["filename"],
                     as_attachment=request.args.get("download") == "1")


@app.delete("/api/attachments/<int:att_id>")
def delete_attachment(att_id: int):
    row = db().execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if row is None:
        raise ApiError("That file doesn't exist.", 404)
    db().execute("DELETE FROM attachments WHERE id = ?", (att_id,))
    touch(row["application_id"])
    db().commit()
    (FILES_DIR / row["stored_name"]).unlink(missing_ok=True)
    return jsonify({"deleted": att_id})


# ==============================================================================

def check_layout() -> bool:
    """The page only looks right if the files sit in the expected folders."""
    needed = ["templates/index.html", "templates/setup.html", "static/style.css", "static/app.js",
              "static/tracker.css", "static/charts.js", "static/charts.css", "static/layout.js", "static/chart.umd.min.js"]
    missing = [n for n in needed if not (BASE_DIR / n).is_file()]
    if missing:
        print("\nJob Tracker can't find some of its files:")
        for n in missing:
            print(f"  missing: {BASE_DIR / n}")
        print("\nUnzip job_tracker.zip as a whole rather than copying files one by one.\n")
        return False
    return True


if __name__ == "__main__":
    if not check_layout():
        raise SystemExit(1)
    url = f"http://{HOST}:{PORT}"
    print(f"Job Tracker is running at {url}  (Ctrl+C to stop)")
    if STORAGE_CONFIGURED:
        print(f"Your data folder is {DATA_DIR}")
    else:
        print(f"Choose a data folder when the browser opens (recommended: {DEFAULT_DATA_DIR})")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=HOST, port=PORT, debug=False)
