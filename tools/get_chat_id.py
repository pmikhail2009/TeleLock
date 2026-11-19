"""Показать chat_id из сообщений боту. Запускать при остановленном основном боте."""
import os
from pathlib import Path

import requests
from dotenv import load_dotenv


def main():
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit("Укажите TELEGRAM_BOT_TOKEN в .env.")
    try:
        response = requests.get(
            f"https://api.telegram.org/bot{token}/getUpdates", timeout=15
        )
        response.raise_for_status()
        data = response.json()
        if not data.get("ok"):
            raise SystemExit("Telegram отклонил запрос.")
    except requests.RequestException as error:
        raise SystemExit("Ошибка Telegram: " + str(error).replace(token, "<redacted>")) from None
    for update in data.get("result", []):
        message = update.get("message", {})
        chat = message.get("chat", {})
        if "id" in chat:
            print(chat["id"])


if __name__ == "__main__":
    main()
