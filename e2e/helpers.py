import base64
import os
import re
import secrets
import subprocess
import time
from collections import deque
from pathlib import Path
from queue import Empty

from deltachat_rpc_client import EventType
from deltachat_rpc_client._utils import AttrDict
from playwright.sync_api import Page, expect

ROOT = Path(__file__).resolve().parent.parent
# The local relay from e2e/relay by default; RELAY=nine.testrun.org RELAY_IP= for a public one.
RELAY = os.environ.get("RELAY", "_chatmail.test")
RELAY_IP = os.environ.get("RELAY_IP", "172.30.99.10")
# Each pytest-xdist worker (gw0, gw1, ...) serves the web client through its own bridge.
PORT = 8099 + int(os.environ.get("PYTEST_XDIST_WORKER", "gw0")[2:])
URL = f"http://127.0.0.1:{PORT}/"
# APP_URL of the invite service in e2e/relay/compose.yaml.
INVITE_APP_URL = "http://127.0.0.1:8099/"
INVITE = "http://127.0.0.1:8084/"
ADMIN_TOKEN = "test-admin-token-0123456789abcdef"
PASSPHRASE = "correct horse battery"
# Locally the slowest test takes about 5 s; these leave room for slower CI runners.
TIMEOUT = 15_000
EVENT_TIMEOUT = 30
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==")


def wait_event(acc, kind, pred=lambda e: True, timeout=EVENT_TIMEOUT):
    """Like `acc.wait_for_event()` with a timeout that reports the account's last events."""
    deadline = time.monotonic() + timeout
    queue = acc._rpc.get_queue(acc.id)
    seen = deque(maxlen=60)
    while True:
        try:
            ev = AttrDict(queue.get(timeout=max(0, deadline - time.monotonic())))
        except Empty:
            log = "\n".join(seen) or "(none)"
            raise TimeoutError(f"no {kind} matching the condition on account {acc.id} within {timeout} s, last events:\n{log}") from None
        if ev.kind == kind and pred(ev):
            return ev
        seen.append(f"{time.strftime('%H:%M:%S')} {ev.kind} " + " ".join(f"{k}={v}" for k, v in ev.items() if k != "kind"))


def wait_text(acc, text, timeout=EVENT_TIMEOUT):
    """Waits for an incoming message with `text`, skipping others."""
    snap = lambda e: acc.get_message_by_id(e.msg_id).get_snapshot()
    return snap(wait_event(acc, EventType.INCOMING_MSG, lambda e: snap(e).text == text, timeout))


def wait_own_msg(acc, text, timeout=EVENT_TIMEOUT):
    """Waits until a message with `text` sent from another device shows up as outgoing."""
    def own(e):
        if not e.msg_id:
            return False
        s = acc.get_message_by_id(e.msg_id).get_snapshot()
        return s.text == text and s.from_id == 1
    return acc.get_message_by_id(wait_event(acc, EventType.MSGS_CHANGED, own, timeout).msg_id).get_snapshot()


def addr_of(acc):
    return acc.list_transports()[0]["addr"]


def transport(addr, password):
    """Login data that reaches the local relay, which has no public DNS."""
    return {
        "addr": addr, "password": password,
        "imapServer": RELAY_IP, "imapPort": 993, "imapSecurity": "ssl",
        "smtpServer": RELAY_IP, "smtpPort": 465, "smtpSecurity": "ssl",
        "certificateChecks": "acceptInvalidCertificates",
    }


def configure(acc, name):
    acc.set_config("displayname", name)
    if RELAY_IP:
        local = "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(9))
        acc.add_or_update_transport(transport(f"{local}@{RELAY}", secrets.token_urlsafe(16)))
    else:
        acc.add_transport_from_qr(f"dcaccount:{RELAY}")
    acc.start_io()
    # Core skips mail that is already in INBOX when it selects the folder for the first time.
    wait_event(acc, EventType.IMAP_INBOX_IDLE)
    return acc


def relay_exec(*cmd):
    subprocess.run(["docker", "exec", "kitepost-test-chatmail", *cmd], check=True)


def set_passphrase(page: Page, url=URL, continue_label="Continue"):
    page.goto(url)
    page.locator('input[type="password"]').nth(0).fill(PASSPHRASE)
    page.locator('input[type="password"]').nth(1).fill(PASSPHRASE)
    page.get_by_role("button", name=continue_label).click()


def reload_and_unlock(page: Page, stay_unlocked=False):
    """Reloads the web client and unlocks the profile with the test passphrase."""
    page.reload()
    page.locator('input[type="password"]').fill(PASSPHRASE)
    if stay_unlocked:
        page.get_by_label("Stay unlocked in this browser").check()
    page.get_by_role("button", name="Unlock").click()
    expect(page.locator(".chatlist")).to_be_visible()


def create_profile(page: Page, phone, name="Webby"):
    """Creates a web profile and connects it to `phone` via the QR code shown after setup."""
    set_passphrase(page)
    page.locator(".field", has_text="Display name").locator("input").fill(name)
    page.locator(".field", has_text="Chatmail relay").locator("input").fill(RELAY)
    page.get_by_role("button", name="Create profile").click()
    expect(page.get_by_role("heading", name="Connect your phone")).to_be_visible()
    phone.secure_join(page.get_by_label("Invite link").input_value())
    wait_event(phone, EventType.SECUREJOIN_JOINER_PROGRESS, lambda e: e.progress == 1000)
    expect(page.locator(".status.ok")).to_be_visible()
    expect(page.locator(".chatlist li", has_text=phone.get_config("displayname"))).to_be_visible()
    return page.locator(".profile small").inner_text()


def open_chat(page: Page, title):
    page.locator(".chatlist li", has_text=title).first.click()


def own_state(page: Page, text):
    """The state mark of the own message with `text`; its data-state is pending, sent, read or failed."""
    return page.locator(".msg.out", has_text=text).locator(".meta .state")


def web_send(page: Page, text):
    page.locator(".composer textarea").fill(text)
    page.locator(".composer textarea").press("Enter")
    expect(own_state(page, text)).to_have_attribute("data-state", re.compile("sent|read"))


def message_action(page: Page, msg, name):
    """Runs `name` from the menu of the message `msg`."""
    msg.hover()
    msg.get_by_role("button", name="More").click()
    page.locator(".menu").get_by_role("menuitem", name=name).click()


def capture_clipboard(page: Page):
    """Replaces the clipboard with `window.copied`, so tests need no clipboard permission."""
    page.evaluate("navigator.clipboard.writeText = async text => { window.copied = text; }")
