import os
import re

try:
    from PySide2 import QtWidgets, QtCore, QtGui
except ImportError:
    from PySide6 import QtWidgets, QtCore, QtGui

from .widgets import WaitingSpinner, ClickableLabel
from .job_widget import JobWidget
from .styles import STUDIO_WIDGET_STYLE, ERROR_STYLE, NO_RESULTS_STYLE
from .. import resources


class StudioWidget(QtWidgets.QFrame):
    def __init__(self, studio_data, config_manager, parent=None):
        super(StudioWidget, self).__init__(parent)
        self.studio_data = studio_data
        self.config_manager = config_manager
        self.job_widgets = []
        self.no_match_label = None
        self.is_errored = False

        self.setObjectName("studio_widget")

        # Outline / Style
        self.setStyleSheet(STUDIO_WIDGET_STYLE)

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(5, 5, 5, 5)
        layout.setSpacing(5)

        # -- Header: Centered Logo/Name with balanced spacing --
        header_layout = QtWidgets.QHBoxLayout()
        header_layout.setContentsMargins(5, 5, 5, 0)
        header_layout.setSpacing(0)

        # Balancing spacer on the left (matches controls width)
        header_layout.addSpacing(30)
        header_layout.addStretch()

        # Logo/Name (Centered)
        self.logo_label = ClickableLabel()
        self.logo_label.setStyleSheet("font-weight: bold; border: none;")
        self.logo_label.setAlignment(QtCore.Qt.AlignCenter)
        self.logo_label.setFixedSize(120, 35)
        self.logo_label.setWordWrap(True)
        self.logo_label.clicked.connect(self.open_careers_page)
        self.logo_label.setToolTip("Open %s Careers Page" % studio_data.get("name"))
        self.logo_label.setContextMenuPolicy(QtCore.Qt.CustomContextMenu)
        self.logo_label.customContextMenuRequested.connect(self.show_context_menu)

        header_layout.addWidget(self.logo_label)
        header_layout.addStretch()

        # Controls container (Refresh/Spinner)
        self.controls_container = QtWidgets.QWidget()
        self.controls_container.setFixedSize(30, 30)
        controls_layout = QtWidgets.QStackedLayout(self.controls_container)
        controls_layout.setStackingMode(QtWidgets.QStackedLayout.StackAll)

        self.refresh_btn = QtWidgets.QPushButton()
        self.refresh_btn.setIcon(resources.get_icon("refresh.svg"))
        self.refresh_btn.setIconSize(QtCore.QSize(20, 20))
        self.refresh_btn.setFlat(True)
        self.refresh_btn.setFixedSize(25, 25)
        self.refresh_btn.clicked.connect(self.fetch_jobs)
        self.refresh_btn.setStyleSheet("border: none; margin: 0; padding: 0;")
        self.refresh_btn.setCursor(QtCore.Qt.PointingHandCursor)
        self.refresh_btn.setToolTip("Refresh Jobs")

        self.spinner = WaitingSpinner()
        self.spinner.setFixedSize(25, 25)
        self.spinner.hide()

        controls_layout.addWidget(self.refresh_btn)
        controls_layout.addWidget(self.spinner)

        header_layout.addWidget(self.controls_container)
        layout.addLayout(header_layout)

        # -- Body: Vertical Scroll of Jobs --
        self.scroll_area = QtWidgets.QScrollArea()
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setFrameShape(QtWidgets.QFrame.NoFrame)

        self.scroll_content = QtWidgets.QWidget()
        self.scroll_content.setStyleSheet("background: transparent;")
        self.scroll_layout = QtWidgets.QVBoxLayout(self.scroll_content)
        self.scroll_layout.setContentsMargins(2, 2, 2, 2)
        self.scroll_layout.setSpacing(4)

        # Stretch to push items up if few jobs
        self.scroll_layout.addStretch()

        self.scroll_area.setWidget(self.scroll_content)
        layout.addWidget(self.scroll_area)

        self.load_logo()
        self.update_jobs()

        # Connect signals
        self.config_manager.logo_cleared.connect(self.on_logo_cleared)
        self.config_manager.logo_downloaded.connect(self.on_logo_downloaded)
        self.config_manager.jobs_updated.connect(self.on_jobs_updated)
        self.config_manager.jobs_failed.connect(self.on_jobs_failed)
        self.config_manager.jobs_started.connect(self.on_jobs_started)

    def open_careers_page(self):
        url = self.studio_data.get("website") or self.studio_data.get("careers_url")
        if url:
            QtGui.QDesktopServices.openUrl(QtCore.QUrl(str(url)))

    def show_context_menu(self, pos):
        menu = QtWidgets.QMenu(self)
        menu.addAction("Refresh Jobs", self.fetch_jobs)

        act_open_web = menu.addAction("Open Careers Page")
        act_open_web.triggered.connect(self.open_careers_page)

        act_update_logo = menu.addAction("Force Refresh Logo")
        act_update_logo.triggered.connect(lambda: self.config_manager.refresh_studio_logo(self.studio_data))

        menu.addSeparator()

        act_edit = menu.addAction("Edit Studio...")
        act_edit.setIcon(resources.get_icon("edit.svg"))

        selected_action = menu.exec_(self.logo_label.mapToGlobal(pos))
        if selected_action is act_edit:
            # Let the context menu's nested event loop close before opening another
            # modal loop. Nested menus/dialogs are crash-prone in Maya's Qt host.
            QtCore.QTimer.singleShot(0, self.open_edit_dialog)

    def open_edit_dialog(self):
        from .studio_dialog import StudioDialog

        existing_ids = [s.get("id") for s in self.config_manager.get_studios()]
        stable_parent = self.window()
        dialog = StudioDialog(
            self.studio_data,
            stable_parent,
            existing_ids=existing_ids,
            config_manager=self.config_manager,
        )
        if dialog.exec_():
            # Do not capture this StudioWidget: updating the config rebuilds and
            # schedules all studio cards, including this one, for deletion.
            manager = self.config_manager
            studio_data = dict(dialog.studio_data)
            QtCore.QTimer.singleShot(0, lambda: manager.update_studio(studio_data))

    def load_logo(self):
        sid = self.studio_data.get("id")
        path = self.config_manager.get_logo_path(sid)

        if path and os.path.exists(path):
            pix = QtGui.QPixmap(path)
            if not pix.isNull():
                self.logo_label.setPixmap(
                    pix.scaled(110, 30, QtCore.Qt.KeepAspectRatio, QtCore.Qt.SmoothTransformation)
                )
                return

        # Fallback to name text
        self.logo_label.setText(self.studio_data.get("name") or self.studio_data.get("id"))

    def fetch_jobs(self):
        self.refresh_btn.setToolTip("Refreshing...")
        self.config_manager.fetch_studio_jobs(self.studio_data)

    def on_logo_cleared(self, sid):
        if sid == self.studio_data.get("id"):
            self.load_logo()

    def on_logo_downloaded(self, sid):
        if sid == self.studio_data.get("id"):
            self.load_logo()

    def on_jobs_started(self, sid):
        if sid == self.studio_data.get("id"):
            self.refresh_btn.hide()
            self.spinner.show()
            self.scroll_area.setEnabled(False)

    def on_jobs_updated(self, sid, jobs):
        if sid == self.studio_data.get("id"):
            self.is_errored = False
            self.update_jobs()
            self.spinner.hide()

            # Use different icon if no jobs found
            icon_name = "success.svg" if jobs else "empty.svg"
            self.refresh_btn.setIcon(resources.get_icon(icon_name))

            self.refresh_btn.setToolTip(
                f"Found {len(jobs)} job{'' if len(jobs) == 1 else 's'} for {self.studio_data['name']}"
            )
            self.refresh_btn.show()
            self.scroll_area.setEnabled(True)

    def on_jobs_failed(self, sid, error_message):
        if sid == self.studio_data.get("id"):
            self.spinner.hide()
            self.refresh_btn.setIcon(resources.get_icon("warning.svg"))

            # Clean up complex requests/urllib3 error messages
            # e.g. "Max retries exceeded... (Caused by NameResolutionError(...: Failed to resolve '...'))"
            # Extract the part after the last colon if it's a "Caused by" error
            cleaned_msg = error_message
            if "Caused by" in error_message:
                # Try to find the most specific error message inside the nested exception
                match = re.search(r"[:]\s*([^:]+)\s*['\"]?\)\s*\)\s*$", error_message)
                if match:
                    cleaned_msg = match.group(1).strip()
                else:
                    parts = error_message.split(":")
                    if len(parts) > 1:
                        cleaned_msg = parts[-1].strip().strip("')\" ")

            self.refresh_btn.setToolTip(f"Error: {cleaned_msg}")
            self.is_errored = True
            self.update_jobs()
            self.refresh_btn.show()
            self.scroll_area.setEnabled(True)

    def update_jobs(self):
        # Clear existing
        while self.scroll_layout.count():
            item = self.scroll_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        jobs = self.config_manager.get_studio_jobs(self.studio_data.get("id"))
        self.job_widgets = []

        if self.is_errored:
            err_lbl = QtWidgets.QLabel("⚠️ Website Error")
            err_lbl.setAlignment(QtCore.Qt.AlignCenter)
            err_lbl.setStyleSheet(ERROR_STYLE)
            self.scroll_layout.insertWidget(0, err_lbl)

        if not jobs:
            lbl = QtWidgets.QLabel("No jobs found")
            lbl.setAlignment(QtCore.Qt.AlignCenter)
            lbl.setStyleSheet(NO_RESULTS_STYLE)
            self.scroll_layout.addWidget(lbl)
        else:
            for job in jobs:
                w = JobWidget(job)
                self.scroll_layout.addWidget(w)
                self.job_widgets.append(w)

            # Label for search filtering
            self.no_match_label = QtWidgets.QLabel("No matches found")
            self.no_match_label.setAlignment(QtCore.Qt.AlignCenter)
            self.no_match_label.setStyleSheet(NO_RESULTS_STYLE)
            self.no_match_label.hide()
            self.scroll_layout.addWidget(self.no_match_label)
        self.scroll_layout.addStretch()  # Ensure top alignment

    def filter_jobs(self, pattern_or_regex):
        """
        Filters job widgets based on a string pattern or pre-compiled regex.
        Returns the number of matching jobs.
        """
        match_count = 0
        if isinstance(pattern_or_regex, str):
            try:
                regex = re.compile(pattern_or_regex, re.IGNORECASE)
            except re.error:
                regex = re.compile(re.escape(pattern_or_regex), re.IGNORECASE)
        else:
            regex = pattern_or_regex

        for w in self.job_widgets:
            title = w.job_data.get("title", "")
            if regex.search(title):
                w.show()
                match_count += 1
            else:
                w.hide()

        if self.no_match_label:
            if match_count == 0 and len(self.job_widgets) > 0:
                # Use pattern string for label if available
                display_text = (
                    pattern_or_regex.pattern if not isinstance(pattern_or_regex, str) else pattern_or_regex
                )
                self.no_match_label.setText(f'No jobs matching "{display_text}"')
                self.no_match_label.show()
            else:
                self.no_match_label.hide()

        return match_count
