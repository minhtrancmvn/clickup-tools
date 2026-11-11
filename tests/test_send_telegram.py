from __future__ import annotations

import io
import json
import sys
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from clickup_tools import send_telegram  # noqa: E402
from clickup_tools.send_telegram import (  # noqa: E402
    TaskSummary,
    TelegramError,
    build_message,
    extract_chats,
    extract_topics,
    run,
    summarize_task,
    telegram_call,
)


TASK_PAYLOAD = {
    "id": "z94x8ecybd",
    "custom_id": "OOLE-546",
    "name": "[Mobile] [Sign Up] Title <not> enforced & skipped",
    "status": {"status": "to do"},
    "assignees": [{"username": "Khánh Võ"}, {"email": "dev@example.com"}, "bad"],
    "url": "https://app.clickup.com/t/z94x8ecybd",
}


def fake_env(values: dict[str, str]):
    return lambda name: values.get(name, "")


class SummarizeAndBuildTests(unittest.TestCase):
    def test_summarize_task_prefers_custom_id(self) -> None:
        summary = summarize_task(TASK_PAYLOAD)
        self.assertEqual(summary, TaskSummary(
            task_id="OOLE-546",
            name="[Mobile] [Sign Up] Title <not> enforced & skipped",
            url="https://app.clickup.com/t/z94x8ecybd",
        ))

    def test_summarize_task_falls_back_to_internal_id(self) -> None:
        summary = summarize_task({"id": "abc123", "name": "x", "status": "open"})
        self.assertEqual(summary.task_id, "abc123")
        self.assertEqual(summary.url, "")

    def test_build_message_puts_intro_then_one_linked_line_per_task(self) -> None:
        second = TaskSummary(task_id="OOLE-547", name="Second", url="https://app.clickup.com/t/b")
        message = build_message([summarize_task(TASK_PAYLOAD), second], intro="@dev <mới> & cũ")
        self.assertEqual(
            message,
            "@dev &lt;mới&gt; &amp; cũ\n"
            '1. <a href="https://app.clickup.com/t/z94x8ecybd">OOLE-546</a> '
            "[Mobile] [Sign Up] Title &lt;not&gt; enforced &amp; skipped\n"
            '2. <a href="https://app.clickup.com/t/b">OOLE-547</a> Second',
        )

    def test_build_message_without_url_or_intro(self) -> None:
        task = TaskSummary(task_id="OOLE-1", name="n", url="")
        self.assertEqual(build_message([task]), "1. OOLE-1 n")


class ExtractChatsTests(unittest.TestCase):
    def test_extract_chats_dedupes_and_labels(self) -> None:
        updates = [
            {"message": {"chat": {"id": 11, "type": "private", "first_name": "Khánh", "last_name": "Võ", "username": "khanhvo"}}},
            {"message": {"chat": {"id": 11, "type": "private", "first_name": "Khánh"}}},
            {"my_chat_member": {"chat": {"id": -22, "type": "group", "title": "Oole Dev"}}},
            {"message": {"chat": {"id": "not-int"}}},
            "garbage",
        ]
        chats = extract_chats(updates)
        self.assertEqual([(c.chat_id, c.chat_type, c.label) for c in chats], [
            (11, "private", "Khánh Võ (@khanhvo)"),
            (-22, "group", "Oole Dev"),
        ])

    def test_extract_topics_reads_thread_and_name(self) -> None:
        chat = {"id": -100, "type": "supergroup", "title": "Oole"}
        updates = [
            {"message": {"chat": chat, "text": "/start@bot"}},
            {"message": {"chat": chat, "is_topic_message": True, "message_thread_id": 21}},
            {"message": {"chat": chat, "is_topic_message": True, "message_thread_id": 21,
                         "reply_to_message": {"forum_topic_created": {"name": "Bugs"}}}},
            {"message": {"chat": chat, "is_topic_message": True, "message_thread_id": "x"}},
        ]
        topics = extract_topics(updates)
        self.assertEqual([(t.chat_id, t.thread_id, t.name) for t in topics], [(-100, 21, "Bugs")])


class TelegramCallTests(unittest.TestCase):
    def _response(self, body: dict) -> MagicMock:
        response = MagicMock()
        response.read.return_value = json.dumps(body).encode()
        response.__enter__.return_value = response
        return response

    def test_success_returns_result_and_posts_json(self) -> None:
        with patch.object(send_telegram.urllib.request, "urlopen", return_value=self._response({"ok": True, "result": {"message_id": 5}})) as urlopen:
            result = telegram_call("123:SECRET", "sendMessage", {"chat_id": "1", "text": "hi"})
        self.assertEqual(result, {"message_id": 5})
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.telegram.org/bot123:SECRET/sendMessage")
        self.assertEqual(json.loads(request.data), {"chat_id": "1", "text": "hi"})

    def test_http_error_uses_description_and_hides_token(self) -> None:
        error = urllib.error.HTTPError(
            "https://api.telegram.org/bot123:SECRET/sendMessage", 400, "Bad Request", {},
            io.BytesIO(b'{"ok": false, "description": "Bad Request: chat not found"}'),
        )
        with patch.object(send_telegram.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(TelegramError) as ctx:
                telegram_call("123:SECRET", "sendMessage", {})
        self.assertIn("chat not found", str(ctx.exception))
        self.assertNotIn("SECRET", str(ctx.exception))

    def test_not_ok_body_raises(self) -> None:
        with patch.object(send_telegram.urllib.request, "urlopen", return_value=self._response({"ok": False, "description": "nope"})):
            with self.assertRaises(TelegramError) as ctx:
                telegram_call("t", "getUpdates")
        self.assertIn("nope", str(ctx.exception))


class RunTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = {"TELEGRAM_BOT_TOKEN": "123:SECRET", "TELEGRAM_CHAT_ID": "777", "CLICKUP_API_TOKEN": "pk_x", "CLICKUP_TEAM_ID": "9018132214"}
        patches = [
            patch.object(send_telegram, "get_env_value", side_effect=fake_env(self.env)),
            patch.object(send_telegram, "get_api_token", side_effect=lambda: self.env.get("CLICKUP_API_TOKEN", "")),
            patch("clickup_tools.read_task.get_env_value", side_effect=fake_env(self.env)),
            patch.object(send_telegram, "get_task_with_subtasks", return_value=TASK_PAYLOAD),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def test_dry_run_prints_message_and_does_not_call_telegram(self) -> None:
        stdout = io.StringIO()
        with patch.object(send_telegram, "telegram_call") as call, redirect_stdout(stdout):
            code = run(["send", "OOLE-546", "--intro", "Hi", "--dry-run"])
        self.assertEqual(code, 0)
        call.assert_not_called()
        self.assertIn("OOLE-546", stdout.getvalue())
        self.assertNotIn("SECRET", stdout.getvalue())

    def test_send_posts_html_message_to_env_chat(self) -> None:
        with patch.object(send_telegram, "telegram_call", return_value={"message_id": 9}) as call, redirect_stdout(io.StringIO()):
            code = run(["send", "OOLE-546", "OOLE-547"])
        self.assertEqual(code, 0)
        token, method, payload = call.call_args.args
        self.assertEqual((token, method), ("123:SECRET", "sendMessage"))
        self.assertEqual(payload["chat_id"], "777")
        self.assertEqual(payload["parse_mode"], "HTML")
        self.assertEqual(payload["link_preview_options"], {"is_disabled": True})
        self.assertEqual(payload["text"].count("OOLE-546"), 2)
        self.assertNotIn("message_thread_id", payload)

    def test_chat_id_flag_overrides_env(self) -> None:
        with patch.object(send_telegram, "telegram_call", return_value={}) as call, redirect_stdout(io.StringIO()):
            run(["send", "OOLE-546", "--chat-id", "42"])
        self.assertEqual(call.call_args.args[2]["chat_id"], "42")

    def test_thread_id_from_env_and_flag(self) -> None:
        self.env["TELEGRAM_THREAD_ID"] = "21"
        with patch.object(send_telegram, "telegram_call", return_value={}) as call, redirect_stdout(io.StringIO()):
            run(["send", "OOLE-546"])
            self.assertEqual(call.call_args.args[2]["message_thread_id"], 21)
            run(["send", "OOLE-546", "--thread-id", "7"])
            self.assertEqual(call.call_args.args[2]["message_thread_id"], 7)

    def test_env_ids_ignore_inline_comments(self) -> None:
        self.env["TELEGRAM_THREAD_ID"] = "21 # topic Bugs"
        self.env["TELEGRAM_CHAT_ID"] = "-100777\t# Oole - Internal"
        with patch.object(send_telegram, "telegram_call", return_value={}) as call, redirect_stdout(io.StringIO()):
            self.assertEqual(run(["send", "OOLE-546"]), 0)
        self.assertEqual(call.call_args.args[2]["message_thread_id"], 21)
        self.assertEqual(call.call_args.args[2]["chat_id"], "-100777")

    def test_invalid_thread_id_fails_without_sending(self) -> None:
        with patch.object(send_telegram, "telegram_call") as call, redirect_stdout(io.StringIO()):
            self.assertEqual(run(["send", "OOLE-546", "--thread-id", "bugs"]), 1)
        call.assert_not_called()

    def test_missing_chat_id_fails_without_sending(self) -> None:
        self.env.pop("TELEGRAM_CHAT_ID")
        with patch.object(send_telegram, "telegram_call") as call, redirect_stdout(io.StringIO()):
            code = run(["send", "OOLE-546"])
        self.assertEqual(code, 1)
        call.assert_not_called()

    def test_missing_bot_token_fails_without_sending(self) -> None:
        self.env.pop("TELEGRAM_BOT_TOKEN")
        with patch.object(send_telegram, "telegram_call") as call, redirect_stdout(io.StringIO()):
            self.assertEqual(run(["send", "OOLE-546"]), 1)
            self.assertEqual(run(["chats"]), 1)
        call.assert_not_called()

    def test_too_long_message_fails_without_sending(self) -> None:
        with patch.object(send_telegram, "telegram_call") as call, redirect_stdout(io.StringIO()):
            code = run(["send", "OOLE-546", "--intro", "x" * 5000])
        self.assertEqual(code, 1)
        call.assert_not_called()

    def test_chats_lists_chat_ids(self) -> None:
        updates = [{"message": {"chat": {"id": 11, "type": "private", "first_name": "Khánh"}}}]
        stdout = io.StringIO()
        with patch.object(send_telegram, "telegram_call", return_value=updates), redirect_stdout(stdout):
            code = run(["chats"])
        self.assertEqual(code, 0)
        self.assertEqual(stdout.getvalue(), "11\tprivate\tKhánh\n")

    def test_telegram_error_returns_failure(self) -> None:
        with patch.object(send_telegram, "telegram_call", side_effect=TelegramError("Telegram sendMessage failed: HTTP 403 Forbidden")), redirect_stdout(io.StringIO()):
            self.assertEqual(run(["send", "OOLE-546"]), 1)


if __name__ == "__main__":
    unittest.main()
