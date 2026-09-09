"""HTML -> PDF through headless Chromium (Playwright). One browser for the
whole run; each invoice is a page.set_content + page.pdf."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from playwright.sync_api import sync_playwright

TEMPLATES = Path(__file__).parent / "templates"
_env = Environment(loader=FileSystemLoader(str(TEMPLATES)), autoescape=select_autoescape(["html"]))

PAGE = {  # per template: Chromium pdf() kwargs
    "uk_service.html": {"format": "A4"},
    "us_letter.html": {"format": "Letter"},
    "minimal_freelancer.html": {"format": "A4"},
    "grid_einvoice.html": {"format": "A4"},
    "statement.html": {"format": "A4"},
    "thermal_receipt.html": {"width": "80mm", "height": "190mm"},
}


class Renderer:
    def __init__(self):
        self._pw = None
        self._browser = None

    def __enter__(self):
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch()
        self._page = self._browser.new_page()
        return self

    def __exit__(self, *exc):
        self._browser.close()
        self._pw.stop()

    def render(self, template: str, context: dict, out: Path) -> None:
        html = _env.get_template(template).render(**context)
        self._page.set_content(html, wait_until="load")
        self._page.pdf(path=str(out), print_background=True, prefer_css_page_size=True, **PAGE[template])
