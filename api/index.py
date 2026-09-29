"""Vercel entry point.

Vercel turns every ``api/*.py`` file into a serverless function and looks
for an ASGI ``app`` in it. The real application lives in the ``app``
package next to this file; the path insert makes ``app`` importable
regardless of the working directory the runtime picks.

Local development and Docker never touch this file: they run
``uvicorn app.main:app`` directly.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.main import app  # noqa: E402

__all__ = ["app"]
