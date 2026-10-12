import concurrent.futures
import os
import ssl
import threading
import urllib.request

from .logger import logger

try:
    import certifi
except ImportError:
    certifi = None

try:
    from PySide2 import QtCore, QtGui, QtSvg
except ImportError:
    from PySide6 import QtCore, QtGui, QtSvg


class LogoWorker(QtCore.QThread):
    logo_downloaded = QtCore.Signal(str)  # studio_id

    MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
    MAX_IMAGE_DIMENSION = 1024

    @staticmethod
    def _create_ssl_context():
        """Use a reliable CA bundle in embedded Python runtimes such as Maya."""
        if certifi is not None:
            return ssl.create_default_context(cafile=certifi.where())
        return ssl.create_default_context()

    def __init__(self, studios, logos_dir, parent=None):
        super(LogoWorker, self).__init__(parent)
        self._studios = list(studios)
        self._logos_dir = logos_dir
        self._stop_event = threading.Event()

    def _render_svg(self, data):
        """Renders SVG data (bytes) to a QImage."""
        renderer = QtSvg.QSvgRenderer(data)
        if not renderer.isValid():
            return QtGui.QImage()

        size = renderer.defaultSize()
        if size.isEmpty():
            size = QtCore.QSize(200, 200)
        size.scale(
            self.MAX_IMAGE_DIMENSION,
            self.MAX_IMAGE_DIMENSION,
            QtCore.Qt.KeepAspectRatio,
        )

        image = QtGui.QImage(size, QtGui.QImage.Format_ARGB32)
        image.fill(QtCore.Qt.transparent)

        painter = QtGui.QPainter(image)
        try:
            renderer.render(painter)
        finally:
            painter.end()

        return image

    def _process_logo(self, studio, ssl_context):
        """Download and atomically cache one logo; return its studio id on success."""
        logo_url = studio.get("logo_url")
        studio_id = studio.get("id")

        if not logo_url or not studio_id:
            return

        filename = f"{studio_id}.png"
        filepath = os.path.join(self._logos_dir, filename)

        try:
            req = urllib.request.Request(
                logo_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": "https://www.google.com/",
                },
            )
            with urllib.request.urlopen(req, context=ssl_context, timeout=10) as response:
                content_type = response.headers.get_content_type()
                data = response.read(self.MAX_DOWNLOAD_BYTES + 1)

            if len(data) > self.MAX_DOWNLOAD_BYTES:
                raise ValueError("logo exceeds 20 MB download limit")

            if self._stop_event.is_set():
                return

            is_svg = content_type == "image/svg+xml" or data.lstrip().startswith((b"<svg", b"<?xml"))
            if is_svg:
                img = self._render_svg(data)
            else:
                img = QtGui.QImage.fromData(data)

            if img.isNull() or self._stop_event.is_set():
                return

            # Bound CPU and memory use before processing unusually large source images.
            if max(img.width(), img.height()) > self.MAX_IMAGE_DIMENSION:
                img = img.scaled(
                    self.MAX_IMAGE_DIMENSION,
                    self.MAX_IMAGE_DIMENSION,
                    QtCore.Qt.KeepAspectRatio,
                    QtCore.Qt.SmoothTransformation,
                )

            image = img.convertToFormat(QtGui.QImage.Format_ARGB32)
            if self._stop_event.is_set():
                return
            image = self._prepare_image(image)

            # Save to a unique temporary file and atomically publish it so the UI
            # can never read a partially-written PNG.
            temp_path = "{}.{}.tmp".format(filepath, threading.get_ident())
            try:
                if not image.save(temp_path, "PNG"):
                    raise ValueError("Qt could not encode logo as PNG")
                if self._stop_event.is_set():
                    return
                os.replace(temp_path, filepath)
                return studio_id
            finally:
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass

        except Exception as exc:
            if not self._stop_event.is_set():
                logger.error("Failed to process logo for %s: %s", studio_id, exc)
        return None

    def run(self):
        if not self._studios:
            return

        ssl_context = self._create_ssl_context()
        max_workers = min(len(self._studios), 10)
        executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="JobUI-logo",
        )
        future_to_studio = {
            executor.submit(self._process_logo, studio, ssl_context): studio
            for studio in self._studios
        }
        pending = set(future_to_studio)

        try:
            while pending and not self._stop_event.is_set():
                done, pending = concurrent.futures.wait(
                    pending,
                    timeout=0.2,
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )
                for future in done:
                    studio = future_to_studio[future]
                    try:
                        studio_id = future.result()
                        # Emit from this QThread, never from an executor thread.
                        if studio_id and not self._stop_event.is_set():
                            self.logo_downloaded.emit(studio_id)
                    except Exception as exc:
                        if not self._stop_event.is_set():
                            logger.error(
                                "Error processing logo for %s: %s",
                                studio.get("id", "Unknown"),
                                exc,
                            )
        finally:
            if self._stop_event.is_set():
                for future in pending:
                    future.cancel()
            # Never let the QThread die while executor tasks still use its state.
            executor.shutdown(wait=True)

    def _prepare_image(self, image):
        """Normalize transparent logos to white and trim transparent padding."""
        width = image.width()
        height = image.height()

        min_x = width
        min_y = height
        max_x = 0
        max_y = 0

        found = False
        has_transparency = False

        # Check alpha channel for content boundaries
        for y in range(height):
            for x in range(width):
                pixel = image.pixel(x, y)
                alpha = (pixel >> 24) & 0xFF
                if alpha < 255:
                    has_transparency = True

                if alpha > 0:
                    found = True
                    if x < min_x:
                        min_x = x
                    if x > max_x:
                        max_x = x
                    if y < min_y:
                        min_y = y
                    if y > max_y:
                        max_y = y

        if not found:
            return image

        # Only recolor images that actually have transparent background pixels.
        # Whitening a fully opaque raster would create a featureless white box.
        if not has_transparency:
            return image

        painter = QtGui.QPainter(image)
        try:
            painter.setCompositionMode(QtGui.QPainter.CompositionMode_SourceIn)
            painter.fillRect(image.rect(), QtGui.QColor(255, 255, 255, 255))
        finally:
            painter.end()

        rect = QtCore.QRect(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
        return image.copy(rect)

    def stop(self):
        self._stop_event.set()
