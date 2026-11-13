import base64
import os
import secrets
import subprocess
from pathlib import Path

from deltachat_rpc_client import EventType
from playwright.sync_api import Page, expect

ROOT = Path(__file__).resolve().parent.parent
# The local relay from e2e/relay by default; RELAY=nine.testrun.org RELAY_IP= for a public one.
RELAY = os.environ.get("RELAY", "_chatmail.test")
RELAY_IP = os.environ.get("RELAY_IP", "172.30.99.10")
PORT = 8099
URL = f"http://127.0.0.1:{PORT}/"
INVITE = "http://127.0.0.1:8084/"
ADMIN_TOKEN = "test-admin-token-0123456789abcdef"
PASSPHRASE = "correct horse battery"
TIMEOUT = 60_000
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==")


def wait_event(acc, kind, pred=lambda e: True):
    while True:
        ev = acc.wait_for_event()
        if ev.kind == kind and pred(ev):
            return ev


def wait_text(acc, text):
    """Waits for an incoming message with `text`, skipping others."""
    while True:
        snap = acc.wait_for_incoming_msg().get_snapshot()
        if snap.text == text:
            return snap


def wait_own_msg(acc, text):
    """Waits until a message with `text` sent from another device shows up as outgoing."""
    while True:
        ev = acc.wait_for_event()
        if ev.kind == EventType.MSGS_CHANGED and ev.msg_id:
            snap = acc.get_message_by_id(ev.msg_id).get_snapshot()
            if snap.text == text and snap.from_id == 1:
                return snap


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
    return acc


def relay_exec(*cmd):
    subprocess.run(["docker", "exec", "kitepost-test-chatmail", *cmd], check=True)


def set_passphrase(page: Page, url=URL, continue_label="Continue"):
    page.goto(url)
    page.locator('input[type="password"]').nth(0).fill(PASSPHRASE)
    page.locator('input[type="password"]').nth(1).fill(PASSPHRASE)
    page.get_by_role("button", name=continue_label).click()


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


def web_send(page: Page, text):
    page.locator(".composer textarea").fill(text)
    page.locator(".composer textarea").press("Enter")
    expect(page.locator(".msg.out", has_text=text).locator(".meta")).to_contain_text("✓")
