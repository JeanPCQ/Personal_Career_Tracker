import datetime as dt
import sqlite3
import tempfile
import unittest
from pathlib import Path

import app as tracker


class LogTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.saved_state = {
            name: getattr(tracker, name)
            for name in ("DATA_DIR", "FILES_DIR", "DB_PATH", "STORAGE_CONFIGURED",
                         "STORAGE_ERROR", "STORAGE_INITIALIZED")
        }
        self.data_dir = Path(self.temporary_directory.name) / "job-data"
        tracker.DATA_DIR = self.data_dir
        tracker.FILES_DIR = self.data_dir / "files"
        tracker.DB_PATH = self.data_dir / "jobs.db"
        tracker.STORAGE_CONFIGURED = True
        tracker.STORAGE_ERROR = None
        tracker.STORAGE_INITIALIZED = False
        tracker.init_db(self.data_dir)
        tracker.STORAGE_INITIALIZED = True
        self.addCleanup(self.restore_storage_state)
        self.client = tracker.app.test_client()

    def restore_storage_state(self):
        for name, value in self.saved_state.items():
            setattr(tracker, name, value)

    def create_application(self, **extra):
        response = self.client.post("/api/applications", json={
            "company": "Example Co",
            "title": "Analyst",
            "status": "Interviewing",
            **extra,
        })
        self.assertEqual(response.status_code, 201)
        return response.get_json()

    def test_application_creation_can_create_initial_log_with_status_and_today(self):
        application = self.create_application(initial_log="Recruiter reached out")

        self.assertEqual(len(application["logs"]), 1)
        self.assertEqual(application["logs"][0]["status"], "Interviewing")
        self.assertEqual(application["logs"][0]["log_date"], dt.date.today().isoformat())
        self.assertEqual(application["logs"][0]["notes"], "Recruiter reached out")

    def test_log_can_be_added_edited_and_deleted(self):
        application = self.create_application()
        response = self.client.post(
            f"/api/applications/{application['id']}/logs",
            json={"log_date": "2026-11-14", "status": "Interviewing", "notes": "Phone screen"},
        )
        self.assertEqual(response.status_code, 201)
        log = response.get_json()["logs"][0]

        response = self.client.patch(f"/api/logs/{log['id']}", json={
            "log_date": "2026-11-15",
            "status": "Offer",
            "notes": "Received an offer",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["logs"][0]["status"], "Offer")
        self.assertEqual(response.get_json()["logs"][0]["log_date"], "2026-11-15")
        self.assertEqual(response.get_json()["logs"][0]["notes"], "Received an offer")

        response = self.client.delete(f"/api/logs/{log['id']}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["logs"], [])

    def test_existing_application_notes_migrate_to_one_log(self):
        with sqlite3.connect(self.data_dir / "jobs.db") as conn:
            cur = conn.execute(
                """INSERT INTO applications
                   (company, title, status, notes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                ("Example Co", "Analyst", "Applied", "Submitted application", "2026-11-10", "2026-11-10"),
            )
            application_id = cur.lastrowid

        tracker.init_db(self.data_dir)
        tracker.init_db(self.data_dir)
        response = self.client.get(f"/api/applications/{application_id}")
        application = response.get_json()

        self.assertEqual(len(application["logs"]), 1)
        self.assertEqual(application["logs"][0]["notes"], "Submitted application")
        self.assertEqual(application["logs"][0]["status"], "Applied")
        self.assertEqual(application["logs"][0]["log_date"], dt.date.today().isoformat())
        self.assertEqual(application["notes"], "")


if __name__ == "__main__":
    unittest.main()
