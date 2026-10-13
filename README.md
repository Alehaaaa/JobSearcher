# JobSearcher — Python/Maya application

This is the Python/PySide job browser on the **`main` branch of `Alehaaaa/JobSearcher`**. The Python import package retains its original `JobUI` name for backwards compatibility with existing Maya scenes and scripts.

JobSearcher helps VFX artists find and organize job openings from different studios. For the browser version, see [`web-app`](https://github.com/Alehaaaa/JobSearcher/tree/web-app); for the published website, see https://alehaaaa.github.io/JobSearcher/. The Swift/Xcode app lives on [`mac`](https://github.com/Alehaaaa/JobSearcher/tree/mac).

## Core Component (PySide)

The core application is built using **Python** and **PySide6** and is primarily designed to run as a tool within **Autodesk Maya**, though the core logic can be adapted for standalone use.

The main codebase is located in the root directory.

### Features
- **Studio Scrapers**: Configurable scrapers for **80+ major and boutique VFX, Animation, and Gaming studios** including Disney, ILM, Pixar, DreamWorks, DNEG, Framestore, Wētā FX, WildBrain, Ubisoft, Riot Games, Kojima Productions, CD Projekt RED, and many more.
- **Dynamic Visual Hierarchy**: New jobs are visually emphasized with a color-coded "heat map" (**Green** -> **Orange** -> **Red**) that fades to grey over 5 days. Brand-new jobs (0-24h) feature high-saturation "vibrancy" to grab attention immediately.
- **SQLite Persistence**: High-performance job tracking using a local SQLite database (migrated from JSON), ensuring accurate discovery timestamps and efficient data management.
- **Detailed Discovery Tooltips**: Hover over job age (e.g., "New", "2h ago") to see the exact date and time the job was discovered.
- **Multi-Strategy Scraping**: Support for JSON APIs, HTML parsing, RSS feeds, and embedded JSON extraction with intelligent fallbacks and advanced mapping parameters (regex, split, element exclusion).
- **Fast UI**: Instant-load placeholders, strictly ordered discovery-first sorting, zero-latency responsive grid, and optimized logo caching.
- **Maya Integration**: Fully dockable UI within Maya with custom styling and seamless workflow integration.

## Installation

1.  Clone the repository:
    ```bash
    git clone --branch main https://github.com/Alehaaaa/JobSearcher.git JobUI
    cd JobUI
    ```

2.  Install dependencies:
    ```bash
    pip install -r requirements.txt
    ```

## Usage

### In Maya
Add the repository root to your `PYTHONPATH`.

Run the tool in Maya's python script editor:

```python
import JobUI
JobUI.show()
```

### Standalone (Testing)
You can run the test scraper script to verify studio configurations:

```bash
python test_scraper.py [studio_id]
```

## Mac Native Version

The native macOS application (built with Swift/Xcode) is maintained on a separate branch.

> **Note**: To access the Mac native version, switch to the `mac` branch:
>
> ```bash
> git checkout mac
> ```

## Project Structure

- `main.py`: Main entry point.
- `ui/`: User Interface components.
- `core/`: Scraper logic and configuration managers.
- `config/`: Studio configuration JSONs.
- `utils/`: Utility functions.
- `requirements.txt`: Python dependencies.
