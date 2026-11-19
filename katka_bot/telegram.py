"""Telegram Bot API: отправка сообщений и получение команд."""
import json

import requests

from .config import BOT_TOKEN, CHAT_ID, COMMAND_KEYBOARD

def send_message(text, show_keyboard=False):
    url = f"https://api.telegram.org/bot{BOT_TOKEN.strip()}/sendMessage"
    data = {
        "chat_id": CHAT_ID.strip(),
        "text": text,
    }
    if show_keyboard:
        data["reply_markup"] = json.dumps(COMMAND_KEYBOARD)

    response = requests.post(
        url,
        data=data,
        timeout=15
    )
    response.raise_for_status()


def get_updates(offset=None, timeout=25):
    url = f"https://api.telegram.org/bot{BOT_TOKEN.strip()}/getUpdates"
    params = {"timeout": timeout}
    if offset is not None:
        params["offset"] = offset

    response = requests.get(url, params=params, timeout=timeout + 5)
    response.raise_for_status()
    return response.json().get("result", [])
