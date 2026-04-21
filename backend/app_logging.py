import logging
import os
from logging.handlers import RotatingFileHandler
from typing import Any

LOG_DIR = os.getenv("LOG_DIR", "/app/logs")
LOG_FILE = os.path.join(LOG_DIR, "app.log")

_FORMAT = "%(asctime)s %(levelname)-5s %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"

logger = logging.getLogger("bandroom")


def setup_logging() -> None:
    if logger.handlers:
        return  # already configured

    os.makedirs(LOG_DIR, exist_ok=True)
    formatter = logging.Formatter(_FORMAT, datefmt=_DATEFMT)

    logger.setLevel(logging.INFO)
    logger.propagate = False  # avoid duplicate via root/uvicorn

    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    logger.addHandler(stream)

    try:
        fh = RotatingFileHandler(
            LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        fh.setFormatter(formatter)
        logger.addHandler(fh)
    except OSError as e:
        logger.warning("file logging disabled: %s", e)


def _render(value: Any) -> str:
    s = str(value)
    if not s:
        return '""'
    if any(c.isspace() for c in s) or "=" in s or '"' in s:
        return '"' + s.replace('"', '\\"') + '"'
    return s


def log_event(event: str, level: int = logging.INFO, **fields: Any) -> None:
    parts = [f"event={event}"]
    for k, v in fields.items():
        if v is None:
            continue
        parts.append(f"{k}={_render(v)}")
    logger.log(level, " ".join(parts))
