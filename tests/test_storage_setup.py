import json
import tempfile
import unittest
from pathlib import Path

import app as tracker


class StorageSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        root = Path(self.temporary_directory.name)
        self.saved_state = {
            name: getattr(tracker, name)
            for name in (
                "CONFIG_DIR", "CONFIG_PATH", "DEFAULT_DATA_DIR", "DATA_DIR", "FILES_DIR", "DB_PATH",
                "STORAGE_CONFIGURED", "STORAGE_ERROR", "STORAGE_INITIALIZED",
            )
        }
        tracker.CONFIG_DIR = root / "settings"
        tracker.CONFIG_PATH = tracker.CONFIG_DIR / "config.json"
        tracker.DEFAULT_DATA_DIR = root / "JobTrackerData"
        tracker.DATA_DIR = tracker.DEFAULT_DATA_DIR
        tracker.FILES_DIR = tracker.DATA_DIR / "files"
        tracker.DB_PATH = tracker.DATA_DIR / "jobs.db"
        tracker.STORAGE_CONFIGURED = False
        tracker.STORAGE_ERROR = None
        tracker.STORAGE_INITIALIZED = False
        self.addCleanup(self.restore_storage_state)
        self.client = tracker.app.test_client()

    def restore_storage_state(self):
        for name, value in self.saved_state.items():
            setattr(tracker, name, value)

    def test_first_run_prompts_for_external_folder_without_creating_it(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Choose where Job Tracker saves data", response.data)
        self.assertIn(str(tracker.DEFAULT_DATA_DIR).encode(), response.data)
        self.assertFalse(tracker.DEFAULT_DATA_DIR.exists())

    def test_setup_creates_database_and_persists_folder_path(self):
        data_dir = Path(self.temporary_directory.name) / "private jobs"
        response = self.client.post(
            "/setup/storage",
            data={"data_dir": str(data_dir)},
            follow_redirects=True,
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue((data_dir / "jobs.db").is_file())
        self.assertTrue((data_dir / "files").is_dir())
        self.assertEqual(
            json.loads(tracker.CONFIG_PATH.read_text(encoding="utf-8"))["data_dir"],
            str(data_dir.resolve()),
        )
        self.assertEqual(self.client.get("/api/applications").get_json(), [])

    def test_setup_rejects_a_folder_inside_the_project(self):
        response = self.client.post(
            "/setup/storage",
            data={"data_dir": str(tracker.BASE_DIR / "data")},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn(b"Choose a folder outside the Job Tracker project", response.data)
        self.assertFalse(tracker.CONFIG_PATH.exists())

    def test_missing_saved_folder_recommends_a_new_location(self):
        missing_dir = Path(self.temporary_directory.name) / "missing"
        tracker.DATA_DIR = missing_dir
        tracker.FILES_DIR = missing_dir / "files"
        tracker.DB_PATH = missing_dir / "jobs.db"
        tracker.STORAGE_CONFIGURED = True

        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Saved folder not found", response.data)
        self.assertIn(str(tracker.DEFAULT_DATA_DIR).encode(), response.data)


if __name__ == "__main__":
    unittest.main()
