"""Send ClickUp task summaries to a Telegram chat through a bot."""

from __future__ import annotations

import argparse
import html
import json
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Sequence

from clickup_tools.read_task import get_task_with_subtasks, resolve_destination
from clickup_tools.update_page import err, get_api_token, get_env_value, info, ok


TELEGRAM_API_BASE = "https://api.telegram.org"
TELEGRAM_MAX_MESSAGE_CHARS = 4096
BOT_TOKEN_ENV = "TELEGRAM_BOT_TOKEN"
CHAT_ID_ENV = "TELEGRAM_CHAT_ID"
THREAD_ID_ENV = "TELEGRAM_THREAD_ID"


@dataclass(frozen=True)
class TaskSummary:
    """The task fields included in a Telegram message."""

    task_id: str
    name: str
    url: str


@dataclass(frozen=True)
class ChatInfo:
    """A chat that has messaged the bot."""

    chat_id: int
    chat_type: str
    label: str


@dataclass(frozen=True)
class TopicInfo:
    """A forum topic seen in a message sent to the bot."""

    chat_id: int
    thread_id: int
    name: str


class TelegramError(RuntimeError):
    """Raised when the Telegram Bot API rejects a request."""


def summarize_task(task: dict[str, Any]) -> TaskSummary:
    """Reduce a ClickUp task payload to the fields the message needs."""
    return TaskSummary(
        task_id=str(task.get("custom_id") or task.get("id") or "").strip(),
        name=str(task.get("name") or "").strip(),
        url=str(task.get("url") or "").strip(),
    )


def build_message(tasks: Sequence[TaskSummary], *, intro: str = "") -> str:
    """Build a Telegram HTML message: optional intro line, then one linked line per task."""
    lines: list[str] = []
    if intro.strip():
        lines.append(html.escape(intro.strip()))

    for index, task in enumerate(tasks, start=1):
        task_label = html.escape(task.task_id or "Task")
        if task.url:
            task_label = f'<a href="{html.escape(task.url, quote=True)}">{task_label}</a>'
        lines.append(f"{index}. {task_label} {html.escape(task.name)}")

    return "\n".join(lines)


def telegram_call(bot_token: str, method: str, payload: dict[str, Any] | None = None) -> Any:
    """Call a Telegram Bot API method and return its result.

    Error messages never include the request URL because it contains the bot token.
    """
    request = urllib.request.Request(
        f"{TELEGRAM_API_BASE}/bot{bot_token}/{method}",
        data=json.dumps(payload or {}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        description = ""
        try:
            description = str(json.loads(exc.read() or b"{}").get("description") or "")
        except (ValueError, AttributeError):
            pass
        raise TelegramError(f"Telegram {method} failed: HTTP {exc.code} {description}".strip()) from None
    except urllib.error.URLError as exc:
        raise TelegramError(f"Telegram {method} failed: {exc.reason}") from None

    if not isinstance(body, dict) or not body.get("ok"):
        description = body.get("description") if isinstance(body, dict) else ""
        raise TelegramError(f"Telegram {method} failed: {description or 'unexpected response'}")
    return body.get("result")


def extract_chats(updates: Sequence[dict[str, Any]]) -> list[ChatInfo]:
    """List unique chats found in getUpdates results, in first-seen order."""
    chats: dict[int, ChatInfo] = {}
    for update in updates:
        if not isinstance(update, dict):
            continue
        for key in ("message", "edited_message", "channel_post", "my_chat_member"):
            event = update.get(key)
            chat = event.get("chat") if isinstance(event, dict) else None
            if not isinstance(chat, dict) or not isinstance(chat.get("id"), int):
                continue
            chat_id = chat["id"]
            if chat_id in chats:
                continue
            name = " ".join(
                part for part in (chat.get("first_name"), chat.get("last_name")) if part
            )
            label = chat.get("title") or name or ""
            if chat.get("username"):
                label = f"{label} (@{chat['username']})".strip()
            chats[chat_id] = ChatInfo(chat_id=chat_id, chat_type=str(chat.get("type") or ""), label=label)
    return list(chats.values())


def extract_topics(updates: Sequence[dict[str, Any]]) -> list[TopicInfo]:
    """List unique forum topics found in getUpdates results, in first-seen order.

    The Bot API has no method to list topics, so a topic is only known once a
    message the bot can see is posted in it. The name comes from the
    topic-created service message when Telegram includes it.
    """
    topics: dict[tuple[int, int], TopicInfo] = {}
    for update in updates:
        if not isinstance(update, dict):
            continue
        message = update.get("message") or update.get("edited_message")
        if not isinstance(message, dict) or not message.get("is_topic_message"):
            continue
        chat = message.get("chat")
        thread_id = message.get("message_thread_id")
        if not isinstance(chat, dict) or not isinstance(chat.get("id"), int) or not isinstance(thread_id, int):
            continue
        key = (chat["id"], thread_id)
        reply = message.get("reply_to_message") if isinstance(message.get("reply_to_message"), dict) else {}
        created = message.get("forum_topic_created") or reply.get("forum_topic_created") or {}
        name = str(created.get("name") or "") if isinstance(created, dict) else ""
        if key not in topics or (name and not topics[key].name):
            topics[key] = TopicInfo(chat_id=chat["id"], thread_id=thread_id, name=name)
    return list(topics.values())


def env_id_value(name: str) -> str:
    """Read an ID from env/.env, dropping a trailing ' # comment' as dotenv files allow."""
    value = get_env_value(name)
    for marker in (" #", "\t#"):
        value = value.split(marker, 1)[0]
    return value.strip()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="clickup-send-telegram",
        description=(
            "Send ClickUp tasks to a Telegram chat through a bot. Reads "
            f"{BOT_TOKEN_ENV} and {CHAT_ID_ENV} from the environment or .env."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "chats",
        help="List chats and forum topics that have messaged the bot, to find chat and topic IDs.",
    )

    send = subparsers.add_parser("send", help="Send one message listing the given tasks.")
    send.add_argument("tasks", nargs="+", metavar="TASK_OR_URL", help="Task IDs, custom IDs, or task URLs.")
    send.add_argument("--chat-id", default="", help=f"Telegram chat ID. Defaults to {CHAT_ID_ENV}.")
    send.add_argument(
        "--thread-id",
        default="",
        help=f"Forum topic ID to post in. Defaults to {THREAD_ID_ENV}; omit both to post in General.",
    )
    send.add_argument("--intro", default="", help="Optional text shown above the task list.")
    send.add_argument("--team-id", default="", help="ClickUp team ID for custom task IDs.")
    send.add_argument("--dry-run", action="store_true", help="Print the message instead of sending it.")
    return parser


def run_chats(bot_token: str) -> int:
    updates = telegram_call(bot_token, "getUpdates") or []
    chats = extract_chats(updates)
    if not chats:
        info("No chats found. Ask the recipient to open the bot and press Start, then run this again.")
        return 0
    for chat in chats:
        print(f"{chat.chat_id}\t{chat.chat_type}\t{chat.label}")
    for topic in extract_topics(updates):
        print(f"{topic.chat_id}\ttopic {topic.thread_id}\t{topic.name or '(name not in update)'}")
    return 0


def run_send(args: argparse.Namespace, bot_token: str) -> int:
    clickup_token = get_api_token()
    if not clickup_token:
        err("CLICKUP_API_TOKEN is not set. Add it to .env or the environment.")
        return 1

    summaries = []
    for task_value in args.tasks:
        destination = resolve_destination(task_value, team_id=args.team_id)
        summaries.append(summarize_task(get_task_with_subtasks(destination, clickup_token)))

    message = build_message(summaries, intro=args.intro)
    if len(message) > TELEGRAM_MAX_MESSAGE_CHARS:
        err(f"Message is {len(message)} characters; Telegram allows {TELEGRAM_MAX_MESSAGE_CHARS}. Send fewer tasks.")
        return 1

    if args.dry_run:
        print(message)
        return 0

    chat_id = args.chat_id.strip() or env_id_value(CHAT_ID_ENV)
    if not chat_id:
        err(f"No chat ID. Pass --chat-id or set {CHAT_ID_ENV}. Run 'clickup-send-telegram chats' to find it.")
        return 1

    thread_value = args.thread_id.strip() or env_id_value(THREAD_ID_ENV)
    if thread_value and not thread_value.isdigit():
        err(f"Topic ID must be a positive number, got {thread_value!r}.")
        return 1

    if not bot_token:
        err(f"{BOT_TOKEN_ENV} is not set. Add it to .env or the environment.")
        return 1

    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True},
    }
    if thread_value:
        payload["message_thread_id"] = int(thread_value)

    result = telegram_call(bot_token, "sendMessage", payload)
    message_id = result.get("message_id") if isinstance(result, dict) else None
    where = f"chat {chat_id}" + (f" topic {thread_value}" if thread_value else "")
    ok(f"Sent {len(summaries)} task(s) to {where} (message {message_id})")
    return 0


def run(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    bot_token = get_env_value(BOT_TOKEN_ENV)
    try:
        if args.command == "chats":
            if not bot_token:
                err(f"{BOT_TOKEN_ENV} is not set. Add it to .env or the environment.")
                return 1
            return run_chats(bot_token)
        return run_send(args, bot_token)
    except (TelegramError, ValueError, urllib.error.URLError) as exc:
        err(str(exc))
        return 1


def main(argv: Sequence[str] | None = None) -> None:
    sys.exit(run(argv))


if __name__ == "__main__":
    main()
