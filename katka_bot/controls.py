"""Поиск кнопок на экране и управление очередью Deadlock."""
import time

import pyautogui

from .config import (BUTTON_TIMEOUT, CANCEL_IMG, GAME_MODES, IGRAT_IMG,
                     IMAGE_CONFIDENCE, MODE_IMAGE_CONFIDENCE, PLAY_IMG)
from .screen import CANCEL_EVENT, is_watching_black_screen

pyautogui.FAILSAFE = True

def ensure_file_exists(path_obj):
    if not path_obj.exists():
        raise FileNotFoundError(f"Файл не найден: {path_obj}")


def click_image(path_obj, confidence=IMAGE_CONFIDENCE, timeout=BUTTON_TIMEOUT):
    ensure_file_exists(path_obj)

    start = time.time()

    while time.time() - start < timeout:
        try:
            pos = pyautogui.locateCenterOnScreen(str(path_obj), confidence=confidence)
        except Exception as e:
            print(f"Ошибка поиска картинки {path_obj.name}: {e}")
            pos = None

        if pos:
            pyautogui.moveTo(pos.x, pos.y, duration=0.2)
            pyautogui.click()
            print(f"Нажал на {path_obj.name}")
            return True

        time.sleep(0.5)

    return False


def run_deadlock_queue(mode_key):
    mode = GAME_MODES.get(mode_key)
    if mode is None:
        return f"Неизвестный режим: {mode_key}"

    print(f"Запускаю последовательность нажатий: {mode['title']}...")
    pyautogui.press("esc")
    time.sleep(1.5)

    if not click_image(PLAY_IMG):
        return "Не найдена кнопка PLAY"

    time.sleep(1.5)

    if not click_image(mode["image"], confidence=MODE_IMAGE_CONFIDENCE):
        return f"Не найдена карточка «{mode['title']}»"

    time.sleep(1.5)

    if not click_image(IGRAT_IMG):
        return "Не найдена кнопка ИГРАТ"

    return f"Режим «{mode['title']}»: очередь запущена, слежу за матчем..."


def cancel_search():
    was_watching = is_watching_black_screen()
    CANCEL_EVENT.set()

    if click_image(CANCEL_IMG, confidence=MODE_IMAGE_CONFIDENCE, timeout=5):
        return "Поиск матча и наблюдение отменены."

    if was_watching:
        return "Наблюдение остановлено, но кнопка «ОТМЕНИТЬ ПОИСК» на экране не найдена."

    return "Активный поиск матча не найден."
