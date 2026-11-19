"""Наблюдение за яркостью экрана в отдельном потоке."""
import threading

import cv2
import numpy as np
from mss import mss

from .config import CHECK_INTERVAL, DARK_THRESHOLD, MESSAGE_TEXT, MONITOR, PROCESS_NAME
from .telegram import send_message
from .windows import get_active_window_process_name, is_process_running

CANCEL_EVENT = threading.Event()
WATCH_THREAD = None

def is_black_screen(img_bgr):
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    avg_brightness = np.mean(gray)
    return avg_brightness < DARK_THRESHOLD, avg_brightness


def wait_for_black_screen():
    print("Начинаю следить за чёрным экраном...")

    with mss() as sct:
        while not CANCEL_EVENT.is_set():
            if not is_process_running(PROCESS_NAME):
                print("deadlock.exe не запущен")
                CANCEL_EVENT.wait(3)
                continue

            active_process = get_active_window_process_name()
            if active_process != PROCESS_NAME:
                print(f"Активное окно не deadlock.exe, а {active_process}")
                CANCEL_EVENT.wait(1)
                continue

            screenshot = np.array(sct.grab(MONITOR))
            frame = cv2.cvtColor(screenshot, cv2.COLOR_BGRA2BGR)

            black, avg = is_black_screen(frame)
            print(f"Средняя яркость: {avg:.2f}")

            if black:
                send_message(MESSAGE_TEXT)
                print("Сообщение отправлено в Telegram. Наблюдение завершено.")
                return

            CANCEL_EVENT.wait(CHECK_INTERVAL)

    print("Наблюдение отменено командой /cancel.")


def is_watching_black_screen():
    return WATCH_THREAD is not None and WATCH_THREAD.is_alive()


def start_black_screen_watch():
    global WATCH_THREAD

    if is_watching_black_screen():
        return False

    CANCEL_EVENT.clear()
    WATCH_THREAD = threading.Thread(
        target=wait_for_black_screen,
        name="black-screen-watcher",
        daemon=True,
    )
    WATCH_THREAD.start()
    return True


# =========================
# АВТОКЛИК
# =========================
