"""Настройки и пути проекта."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
MESSAGE_TEXT = "⚠️МАТЧ НАЙДЕНЬ, ВЕРНИСЬ К КОМПУ!!⚠️"

PROCESS_NAME = "deadlock.exe"
DARK_THRESHOLD = 15
CHECK_INTERVAL = 1.0
IMAGE_CONFIDENCE = 0.8
MODE_IMAGE_CONFIDENCE = 0.75
BUTTON_TIMEOUT = 15

MONITOR = {
    "top": 0,
    "left": 0,
    "width": 1920,
    "height": 1080
}

BASE_DIR = Path(__file__).resolve().parent.parent
IMAGE_DIR = BASE_DIR / "assets" / "images"
PLAY_IMG = IMAGE_DIR / "play.png"
IGRAT_IMG = IMAGE_DIR / "igrat.png"
CANCEL_IMG = IMAGE_DIR / "cancel.png"

GAME_MODES = {
    "normal": {
        "title": "Обычный режим",
        "image": IMAGE_DIR / "mode_normal.png",
    },
    "ranked": {
        "title": "Ранговый режим",
        "image": IMAGE_DIR / "mode_ranked.png",
    },
    "street": {
        "title": "Уличная стычка",
        "image": IMAGE_DIR / "mode_street.png",
    },
}

COMMAND_TO_MODE = {
    "/play_normal": "normal",
    "/play_ranked": "ranked",
    "/play_street": "street",
}

COMMAND_KEYBOARD = {
    "keyboard": [
        ["/play_normal", "/play_ranked"],
        ["/play_street", "/cancel"],
        ["/watch_black"],
    ],
    "resize_keyboard": True,
}
