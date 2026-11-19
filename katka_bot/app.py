"""Обработка Telegram-команд и запуск бота."""
import time

from .config import (BOT_TOKEN, CHAT_ID, COMMAND_TO_MODE, GAME_MODES,
                     IMAGE_DIR, PLAY_IMG, IGRAT_IMG, CANCEL_IMG)
from .controls import cancel_search, run_deadlock_queue
from .screen import is_watching_black_screen, start_black_screen_watch
from .telegram import get_updates, send_message

LAST_UPDATE_ID = None

def skip_old_updates():
    global LAST_UPDATE_ID

    updates = get_updates(timeout=1)
    if updates:
        LAST_UPDATE_ID = updates[-1]["update_id"] + 1
        print(f"Старые команды пропущены. Новый offset: {LAST_UPDATE_ID}")
    else:
        LAST_UPDATE_ID = None
        print("Старых команд нет.")


# =========================
# ПРОЦЕСС / ОКНО
# =========================

def commands_help():
    return (
        "Команды:\n"
        "/play_normal - Обычный режим\n"
        "/play_ranked - Ранговый режим\n"
        "/play_street - Уличная стычка\n"
        "/cancel - отменить поиск матча\n"
        "/watch_black - только следить за чёрным экраном"
    )


# =========================
# ОСНОВНОЙ ЦИКЛ
# =========================
def main():
    global LAST_UPDATE_ID

    if not BOT_TOKEN or not CHAT_ID:
        raise SystemExit("Укажите TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env.")

    print("Папка с картинками:", IMAGE_DIR)
    print("play.png существует:", PLAY_IMG.exists())
    print("igrat.png существует:", IGRAT_IMG.exists())
    print("cancel.png существует:", CANCEL_IMG.exists())
    for mode in GAME_MODES.values():
        print(f"{mode['image'].name} существует:", mode["image"].exists())

    skip_old_updates()
    send_message("Бот запущен.\n" + commands_help(), show_keyboard=True)

    while True:
        try:
            updates = get_updates(LAST_UPDATE_ID)

            for update in updates:
                LAST_UPDATE_ID = update["update_id"] + 1

                message = update.get("message")
                if not message:
                    continue

                text = message.get("text", "").strip()
                chat_id = str(message["chat"]["id"]).strip()

                if chat_id != CHAT_ID.strip():
                    continue

                command = text.split(maxsplit=1)[0].lower() if text else ""

                if command == "/start":
                    send_message(commands_help(), show_keyboard=True)

                elif command in COMMAND_TO_MODE:
                    if is_watching_black_screen():
                        send_message("Поиск уже запущен. Сначала отправьте /cancel.")
                        continue

                    mode_key = COMMAND_TO_MODE[command]
                    mode_title = GAME_MODES[mode_key]["title"]
                    send_message(f"Запускаю Deadlock: {mode_title}...")
                    result = run_deadlock_queue(mode_key)
                    send_message(result)

                    if "очередь запущена" in result:
                        start_black_screen_watch()

                elif command == "/cancel":
                    send_message(cancel_search())

                elif command == "/watch_black":
                    if start_black_screen_watch():
                        send_message("Начинаю следить только за чёрным экраном...")
                    else:
                        send_message("Наблюдение уже запущено. Для остановки отправьте /cancel.")

        except Exception as e:
            print("Ошибка:", str(e).replace(BOT_TOKEN, "<redacted>"))
            try:
                send_message("Ошибка: " + str(e).replace(BOT_TOKEN, "<redacted>"))
            except Exception:
                pass
            time.sleep(5)
