import json
import os
import sqlite3
import hashlib
from .logger import logger
from datetime import datetime

from .logo_worker import LogoWorker

try:
    from PySide2 import QtCore
except ImportError:
    from PySide6 import QtCore


class ConfigManager(QtCore.QObject):
    logos_updated = QtCore.Signal()  # Emitted when any logo is downloaded (general update)
    logo_downloaded = QtCore.Signal(str)  # Emitted when a specific logo is ready
    logo_cleared = QtCore.Signal(str)  # Emitted when a logo is removed (to show text placeholder)

    jobs_updated = QtCore.Signal(str, list)  # studio_id, date
    jobs_failed = QtCore.Signal(str, str)  # studio_id, error_message
    jobs_started = QtCore.Signal(str)  # studio_id
    studio_visibility_changed = QtCore.Signal(str, bool)  # studio_id, enabled
    studios_visibility_changed = QtCore.Signal()  # For bulk changes
    studios_refreshed = QtCore.Signal()  # Emitted when studios are added/edited/removed

    def __init__(self, parent=None):
        super(ConfigManager, self).__init__(parent)
        # Root dir is up one level from 'core'
        self.root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.config_path = os.path.join(self.root_dir, "config", "studios.json")
        self.logos_dir = os.path.join(self.root_dir, "resources", "_logos")

        if not os.path.exists(self.logos_dir):
            os.makedirs(self.logos_dir)

        # Settings for local preferences (enabled/disabled studios)
        self.settings = QtCore.QSettings("JobUI", "ConfigManager")
        self.disabled_studios = self.settings.value("disabled_studios", []) or []
        if not isinstance(self.disabled_studios, list):
            self.disabled_studios = []

        self.studios = []
        self.jobs_cache = {}  # {studio_id: [jobs]}

        self.logo_worker = None
        self._pending_logo_studios = {}
        self._refresh_all_logos_pending = False
        self._shutting_down = False
        self.job_worker = None

        from .job_scraper import JobScraper

        self.scraper = JobScraper()

        # Job History (SQLite)
        self.db_path = os.path.join(self.root_dir, "config", "jobs.db")
        self._init_db()

        self._config_hash = None
        self.load_config()
        self._load_jobs_from_db()
        self.download_missing_logos()

    def _get_db_connection(self):
        """Creates a new database connection."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        """Initializes the database schema."""
        try:
            with self._get_db_connection() as conn:
                # Enable WAL mode for better concurrency
                conn.execute("PRAGMA journal_mode=WAL;")

                conn.execute("""
                    CREATE TABLE IF NOT EXISTS jobs (
                        job_hash TEXT PRIMARY KEY,
                        studio_id TEXT,
                        title TEXT,
                        link TEXT,
                        location TEXT,
                        extra_link TEXT,
                        first_seen REAL,
                        last_seen REAL
                    )
                """)

                # Migration: Add new columns if they don't exist
                cursor = conn.cursor()
                cursor.execute("PRAGMA table_info(jobs)")
                columns = [row["name"] for row in cursor.fetchall()]

                needed_columns = {"title": "TEXT", "link": "TEXT", "location": "TEXT", "extra_link": "TEXT"}

                for col, col_type in needed_columns.items():
                    if col not in columns:
                        logger.info(f"Migrating DB: Adding {col} column to 'jobs' table.")
                        conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} {col_type}")

                conn.execute("CREATE INDEX IF NOT EXISTS idx_studio_id ON jobs (studio_id)")
                conn.commit()
        except sqlite3.Error as e:
            logger.error(f"Database initialization failed: {e}")

    def _load_jobs_from_db(self):
        """Populates the jobs cache from the database on startup."""
        try:
            with self._get_db_connection() as conn:
                # Cleanup jobs older than 7 days on startup
                day_7_threshold = datetime.now().timestamp() - (7 * 86400)
                conn.execute("DELETE FROM jobs WHERE last_seen < ?", (day_7_threshold,))
                conn.commit()

                cursor = conn.cursor()
                cursor.execute("""
                    SELECT studio_id, title, link, location, extra_link, first_seen 
                    FROM jobs 
                    ORDER BY first_seen DESC
                """)
                rows = cursor.fetchall()

                for row in rows:
                    sid = row["studio_id"]
                    if sid not in self.jobs_cache:
                        self.jobs_cache[sid] = []

                    self.jobs_cache[sid].append(
                        {
                            "title": row["title"] or "",
                            "link": row["link"] or "",
                            "location": row["location"] or "",
                            "extra_link": row["extra_link"] or "",
                            "first_seen": row["first_seen"],
                        }
                    )
                logger.info(f"Loaded {len(rows)} jobs from database cache.")
        except sqlite3.Error as e:
            logger.error(f"Failed to load jobs from DB: {e}")

    def _get_file_hash(self, path):
        """Calculates the MD5 hash of a file."""
        if not path or not os.path.exists(path):
            return None
        try:
            hasher = hashlib.md5()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(4096), b""):
                    hasher.update(chunk)
            return hasher.hexdigest()
        except Exception as e:
            logger.error(f"Error calculating hash for {path}: {e}")
            return None

    def load_config(self):
        # Check local config first
        if os.path.exists(self.config_path):
            pass
        else:
            # Fallback to mac resources
            # self.root_dir is .../pyside
            project_root = os.path.dirname(self.root_dir)
            mac_config = os.path.join(project_root, "mac", "Resources", "studios.json")
            if os.path.exists(mac_config):
                logger.info(f"Using shared config from {mac_config}")
                self.config_path = mac_config
            else:
                logger.error(f"Config file not found at {self.config_path} or {mac_config}")

        if os.path.exists(self.config_path):
            with open(self.config_path, "r", encoding="utf-8") as f:
                try:
                    raw_studios = json.load(f)
                    studios_map = {}
                    for s in raw_studios:
                        if "id" in s and not s.get("disabled", False):
                            studios_map[s["id"]] = s
                    self.studios = list(studios_map.values())

                    # Update hash after successful read
                    self._config_hash = self._get_file_hash(self.config_path)

                    if len(self.studios) != len(raw_studios):
                        self.save_config()

                    self.studios_refreshed.emit()

                except json.JSONDecodeError:
                    logger.error(f"Error decoding {self.config_path}")
                    self.studios = []
        else:
            self.studios = []

    def save_config(self):
        with open(self.config_path, "w", encoding="utf-8") as f:
            json.dump(self.studios, f, indent=4, ensure_ascii=False)
        # Update hash after saving
        self._config_hash = self._get_file_hash(self.config_path)

    def get_studios(self):
        return self.studios

    def get_studio_jobs(self, studio_id):
        return self.jobs_cache.get(studio_id, [])

    def is_studio_enabled(self, studio_id):
        return studio_id not in self.disabled_studios

    def set_studio_enabled(self, studio_id, enabled):
        if enabled:
            if studio_id in self.disabled_studios:
                self.disabled_studios.remove(studio_id)
        else:
            if studio_id not in self.disabled_studios:
                self.disabled_studios.append(studio_id)

        self.settings.setValue("disabled_studios", self.disabled_studios)
        self.studio_visibility_changed.emit(studio_id, enabled)

    def enable_all_studios(self):
        """Enables all studios."""
        for studio in self.studios:
            sid = studio.get("id")
            if sid in self.disabled_studios:
                self.disabled_studios.remove(sid)

        self.settings.setValue("disabled_studios", self.disabled_studios)
        self.studios_visibility_changed.emit()

    def disable_all_studios(self):
        """Disables all studios."""
        for studio in self.studios:
            sid = studio.get("id")
            if sid not in self.disabled_studios:
                self.disabled_studios.append(sid)

        self.settings.setValue("disabled_studios", self.disabled_studios)
        self.studios_visibility_changed.emit()

    def add_studio(self, studio_data):
        # Check if exists and remove first
        check_id = studio_data.get("id")
        existing_index = -1
        for i, s in enumerate(self.studios):
            if s.get("id") == check_id:
                existing_index = i
                break

        if existing_index != -1:
            self.studios.pop(existing_index)

        self.studios.append(studio_data)
        self.save_config()
        # Auto download logo for new studio
        self.download_logos([studio_data])
        self.studios_refreshed.emit()

    def update_studio(self, studio_data):
        """Updates an existing studio's data."""
        updated = False
        for i, studio in enumerate(self.studios):
            if studio.get("id") == studio_data.get("id"):
                self.studios[i] = studio_data
                updated = True
                break

        if updated:
            self.save_config()
            self.refresh_studio_logo(studio_data)
            self.studios_refreshed.emit()

    def download_missing_logos(self):
        """Checks for missing logos and downloads them in a thread."""
        missing = []
        for studio in self.studios:
            sid = studio.get("id")
            if not self.get_logo_path(sid):
                missing.append(studio)

        if missing:
            self.download_logos(missing)

    def refresh_logos(self):
        """Queue a safe full logo refresh without blocking Maya's UI thread."""
        self._pending_logo_studios.clear()
        self._refresh_all_logos_pending = True
        if self.logo_worker is not None:
            if self.logo_worker.isRunning():
                self.logo_worker.stop()
            return
        self._perform_full_logo_refresh()

    def _perform_full_logo_refresh(self):
        """Refresh every cache entry without discarding known-good fallbacks."""
        self._refresh_all_logos_pending = False
        # Each successful download atomically replaces its old cache file. A
        # transient network/certificate failure therefore cannot erase a logo.
        self.download_logos(self.studios)

    def refresh_studio_logo(self, studio_data):
        """Queue a logo replacement; the old cached file stays valid until then."""
        sid = studio_data.get("id")
        if not sid:
            return
        self.download_logos([studio_data])

    def download_logos(self, studios_to_download):
        if self._shutting_down:
            return

        # Deduplicate queued work by studio id and retain the newest config.
        for studio in studios_to_download:
            sid = studio.get("id")
            if sid and studio.get("logo_url"):
                self._pending_logo_studios[sid] = dict(studio)

        # Keep one authoritative QThread until Qt delivers its finished signal.
        # isRunning() may already be false while that signal is still queued.
        if self.logo_worker is not None:
            return
        self._start_pending_logo_worker()

    def _start_pending_logo_worker(self):
        if self._shutting_down or self.logo_worker is not None or not self._pending_logo_studios:
            return

        batch = list(self._pending_logo_studios.values())
        self._pending_logo_studios.clear()

        worker = LogoWorker(batch, self.logos_dir)
        self.logo_worker = worker
        worker.logo_downloaded.connect(self._on_logo_downloaded)
        worker.finished.connect(lambda: self._on_logo_worker_finished(worker))
        worker.start()

    def _on_logo_downloaded(self, studio_id):
        self.logo_downloaded.emit(studio_id)
        self.logos_updated.emit()

    def _on_logo_worker_finished(self, worker):
        if worker is not self.logo_worker:
            return
        self.logo_worker = None
        worker.deleteLater()
        if self._shutting_down:
            return
        if self._refresh_all_logos_pending:
            self._perform_full_logo_refresh()
        else:
            self._start_pending_logo_worker()

    def get_logo_path(self, studio_id):
        if not studio_id:
            return None
        path = os.path.join(self.logos_dir, f"{studio_id}.png")
        try:
            return path if os.path.getsize(path) > 0 else None
        except OSError:
            return None

    # --- Job Fetching ---

    def fetch_all_jobs(self):
        # Check for config updates before refetching everything
        current_hash = self._get_file_hash(self.config_path)
        if current_hash != self._config_hash:
            logger.info("Config file change detected via MD5. Reloading studios...")
            self.load_config()
            self.download_missing_logos()

        active_studios = [s for s in self.studios if not s.get("disabled", False)]
        self.start_job_worker(active_studios)

    def fetch_studio_jobs(self, studio_data):
        # Check for config updates before refetching
        current_hash = self._get_file_hash(self.config_path)
        if current_hash != self._config_hash:
            logger.info("Config file change detected via MD5. Reloading studios...")
            self.load_config()
            self.download_missing_logos()

        self.start_job_worker([studio_data])

    def start_job_worker(self, studios):
        if self.job_worker and self.job_worker.isRunning():
            # Ensure previous worker is stopped before starting new one
            self.job_worker.stop()
            self.job_worker.wait()

        # Emit started signal for all involved
        for s in studios:
            self.jobs_started.emit(s.get("id"))

        self.job_worker = JobWorker(studios, self.scraper)
        self.job_worker.jobs_ready.connect(self._on_jobs_ready)
        self.job_worker.jobs_failed.connect(self.jobs_failed.emit)
        self.job_worker.start()

    def _on_jobs_ready(self, studio_id, jobs):
        try:
            # 1. Fetch existing history to determine 'first_seen' status
            existing_history = self._fetch_studio_history(studio_id)

            # 2. Sync results to DB (Upsert new, update existing, remove stale)
            processed_jobs = self._sync_studio_jobs(studio_id, jobs, existing_history)

            # 3. Sort by newness and update UI
            processed_jobs.sort(key=lambda x: float(x.get("first_seen", 0)), reverse=True)

            self.jobs_cache[studio_id] = processed_jobs
            self.jobs_updated.emit(studio_id, processed_jobs)

        except Exception as e:
            logger.error(f"Error processing jobs for {studio_id}: {e}")
            self.jobs_failed.emit(studio_id, str(e))

    def _fetch_studio_history(self, studio_id):
        """Fetches existing persistence data (job_hash -> first_seen) for a studio."""
        try:
            with self._get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT job_hash, first_seen FROM jobs WHERE studio_id = ?", (studio_id,))
                return {row["job_hash"]: row["first_seen"] for row in cursor.fetchall()}
        except sqlite3.Error as e:
            logger.error(f"Failed to fetch history for {studio_id}: {e}")
            return {}

    def _sync_studio_jobs(self, studio_id, jobs, existing_history):
        """
        Updates the database with the current scrape results and cleanup stale ones.
        Returns the full list of active jobs (seen in last 7 days) for the studio.
        """
        now_ts = datetime.now().timestamp()
        day_7_threshold = now_ts - (7 * 86400)
        jobs_to_upsert = []

        for job in jobs:
            # Generate deterministic hash
            j_link = job.get("link", "")
            j_title = job.get("title", "")
            raw_key = f"{j_link}|{j_title}"
            job_hash = hashlib.md5(raw_key.encode("utf-8")).hexdigest()

            # Preserve original first_seen if exists, otherwise mark as new
            first_seen = existing_history.get(job_hash, now_ts)

            # Prepare for DB batch update (Upsert signature)
            jobs_to_upsert.append(
                (
                    job_hash,
                    studio_id,
                    job.get("title", ""),
                    job.get("link", ""),
                    job.get("location", ""),
                    job.get("extra_link", ""),
                    first_seen,
                    now_ts,
                )
            )

        try:
            with self._get_db_connection() as conn:
                cursor = conn.cursor()

                # 1. Upsert: Insert new jobs or update last_seen/data for existing ones
                if jobs_to_upsert:
                    cursor.executemany(
                        """
                        INSERT INTO jobs (job_hash, studio_id, title, link, location, extra_link, first_seen, last_seen)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(job_hash) DO UPDATE SET
                            title = excluded.title,
                            link = excluded.link,
                            location = excluded.location,
                            extra_link = excluded.extra_link,
                            last_seen = excluded.last_seen
                    """,
                        jobs_to_upsert,
                    )

                # 2. Cleanup: Remove jobs older than 7 days
                cursor.execute(
                    "DELETE FROM jobs WHERE studio_id = ? AND last_seen < ?", (studio_id, day_7_threshold)
                )

                # 3. Fetch current state (all jobs seen in last 7 days)
                cursor.execute(
                    """
                    SELECT title, link, location, extra_link, first_seen 
                    FROM jobs 
                    WHERE studio_id = ?
                    ORDER BY first_seen DESC
                """,
                    (studio_id,),
                )

                rows = cursor.fetchall()
                conn.commit()

                processed_jobs = []
                for row in rows:
                    processed_jobs.append(
                        {
                            "title": row["title"] or "",
                            "link": row["link"] or "",
                            "location": row["location"] or "",
                            "extra_link": row["extra_link"] or "",
                            "first_seen": row["first_seen"],
                        }
                    )
                return processed_jobs

        except sqlite3.Error as e:
            logger.error(f"DB Sync failed for {studio_id}: {e}")
            return []

    def _clear_studio_history(self, studio_id):
        try:
            with self._get_db_connection() as conn:
                conn.execute("DELETE FROM jobs WHERE studio_id = ?", (studio_id,))
                conn.commit()
        except sqlite3.Error:
            pass

    def cleanup(self):
        """Stops any running workers and prevents further updates."""
        self._shutting_down = True
        self._pending_logo_studios.clear()
        # Stop this object from sending any more signals to the UI
        self.blockSignals(True)

        if self.logo_worker:
            try:
                self.logo_worker.logo_downloaded.disconnect()
            except (RuntimeError, TypeError):
                pass
            if self.logo_worker.isRunning():
                self.logo_worker.stop()
                # Shutdown may briefly wait for in-flight network timeouts, but
                # returning with live executor tasks can crash Maya during unload.
                self.logo_worker.wait()

        if self.job_worker:
            try:
                self.job_worker.jobs_ready.disconnect()
            except (RuntimeError, TypeError):
                pass
            if self.job_worker.isRunning():
                self.job_worker.stop()
                self.job_worker.wait()

        logger.info("ConfigManager cleanup complete: Workers signaled to stop and signals disconnected.")


class JobWorker(QtCore.QThread):
    jobs_ready = QtCore.Signal(str, list)  # studio_id, list of job dicts
    jobs_failed = QtCore.Signal(str, str)  # studio_id, error_message
    def __init__(self, studios, scraper, parent=None):
        super(JobWorker, self).__init__(parent)
        self.studios = studios
        self.scraper = scraper
        self._is_running = True

    def run(self):
        import concurrent.futures

        # Determine max workers based on list size, but cap it (e.g. 10 or 20) to avoid too many threads
        max_workers = min(len(self.studios), 20)
        if max_workers < 1:
            max_workers = 1

        executor = concurrent.futures.ThreadPoolExecutor(max_workers=max_workers)
        future_to_studio = {
            executor.submit(self.scraper.fetch_jobs, studio): studio for studio in self.studios
        }
        pending = set(future_to_studio.keys())

        while pending and self._is_running:
            try:
                done, _ = concurrent.futures.wait(
                    pending, timeout=0.2, return_when=concurrent.futures.FIRST_COMPLETED
                )

                for future in done:
                    pending.remove(future)
                    studio = future_to_studio[future]
                    try:
                        jobs = future.result()
                        if self._is_running:
                            self.jobs_ready.emit(studio.get("id"), jobs)
                    except Exception as e:
                        if self._is_running:
                            logger.error(f"Error processing jobs for {studio.get('name', 'Unknown')}: {e}")
                            self.jobs_failed.emit(studio.get("id"), str(e))
            except Exception:
                pass

        if not self._is_running:
            for f in pending:
                f.cancel()

        # Do not outlive scraper calls that still reference this worker/scraper.
        executor.shutdown(wait=True)

    def stop(self):
        self._is_running = False
