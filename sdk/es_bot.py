"""ES Bot API SDK — Python 3.9+

يتطلب: pip install requests
لا تضع التوكن في الواجهة أو مستودع عام.
"""
from __future__ import annotations
import re
from typing import Any, Dict, Optional
import requests

_TOKEN = re.compile(r"^esb_live_[A-Za-z0-9_-]{20,240}$")

class ESBotError(RuntimeError):
    def __init__(self, description: str, code: int = 0, payload: Optional[dict] = None):
        super().__init__(description)
        self.description, self.code, self.payload = description, code, payload or {}

class ESBot:
    def __init__(self, token: str, base_url: str, timeout: float = 10.0, session: Optional[requests.Session] = None):
        if not _TOKEN.fullmatch(str(token or "")):
            raise ValueError("Invalid ES bot token")
        if not base_url:
            raise ValueError("base_url is required")
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = session or requests.Session()

    def call(self, method: str, **payload: Any) -> Any:
        url = f"{self.base_url}/bot{self.token}/{method}"
        try:
            response = self.session.post(url, json=payload, timeout=self.timeout)
            data = response.json()
        except requests.RequestException as exc:
            raise ESBotError(str(exc)) from exc
        except ValueError as exc:
            raise ESBotError("Invalid ES Bot API response", response.status_code) from exc
        if not response.ok or data.get("ok") is not True:
            raise ESBotError(data.get("description", "ES Bot API error"), data.get("error_code", response.status_code), data)
        return data.get("result")

    def get_me(self): return self.call("getMe")
    def send_message(self, chat_id: str, text: str, **extra): return self.call("sendMessage", chat_id=chat_id, text=text, **extra)
    def send_photo(self, chat_id: str, photo: str, **extra): return self.call("sendPhoto", chat_id=chat_id, photo=photo, **extra)
    def send_document(self, chat_id: str, document: str, **extra): return self.call("sendDocument", chat_id=chat_id, document=document, **extra)
    def send_audio(self, chat_id: str, audio: str, **extra): return self.call("sendAudio", chat_id=chat_id, audio=audio, **extra)
    def send_video(self, chat_id: str, video: str, **extra): return self.call("sendVideo", chat_id=chat_id, video=video, **extra)
    def get_chat(self, chat_id: str): return self.call("getChat", chat_id=chat_id)
    def get_chat_member(self, chat_id: str, user_id: str): return self.call("getChatMember", chat_id=chat_id, user_id=user_id)
    def get_chat_administrators(self, chat_id: str): return self.call("getChatAdministrators", chat_id=chat_id)
    def send_location(self, chat_id: str, latitude: float, longitude: float, **extra): return self.call("sendLocation", chat_id=chat_id, latitude=latitude, longitude=longitude, **extra)
    def send_poll(self, chat_id: str, question: str, options: list, **extra): return self.call("sendPoll", chat_id=chat_id, question=question, options=options, **extra)
    def forward_message(self, chat_id: str, from_chat_id: str, message_id: str): return self.call("forwardMessage", chat_id=chat_id, from_chat_id=from_chat_id, message_id=message_id)
    def copy_message(self, chat_id: str, from_chat_id: str, message_id: str): return self.call("copyMessage", chat_id=chat_id, from_chat_id=from_chat_id, message_id=message_id)
    def upload_file_part(self, **meta): return self.call("uploadFile", **meta)
    def complete_file(self, upload_id: str, access_key: str): return self.call("completeFile", upload_id=upload_id, access_key=access_key)
    def edit_message_text(self, chat_id: str, message_id: str, text: str, **extra): return self.call("editMessageText", chat_id=chat_id, message_id=message_id, text=text, **extra)
    def delete_message(self, chat_id: str, message_id: str): return self.call("deleteMessage", chat_id=chat_id, message_id=message_id)
    def set_webhook(self, url: str): return self.call("setWebhook", url=url)
    def delete_webhook(self): return self.call("deleteWebhook")
    def get_webhook_info(self): return self.call("getWebhookInfo")
    def get_updates(self, offset: int = 0, limit: int = 100): return self.call("getUpdates", offset=offset, limit=limit)
    def answer_callback_query(self, callback_query_id: str, **extra): return self.call("answerCallbackQuery", callback_query_id=callback_query_id, **extra)
