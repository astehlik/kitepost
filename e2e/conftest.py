"""Fixtures for the end-to-end tests: the web client in Chromium against Delta Chat core.

Needs a built `web/dist`, the bridge dependencies, the venv from e2e/requirements.txt and, by
default, the local relay: docker compose -f e2e/relay/compose.yaml up -d --build --wait
"""

import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest
from deltachat_rpc_client import DeltaChat, EventType, Rpc
from playwright.sync_api import expect

from helpers import INVITE, PORT, RELAY, RELAY_IP, ROOT, TIMEOUT, configure, create_profile, new_chat, wait_event

expect.set_options(timeout=TIMEOUT)


def parallel(config):
    # Workers collect the tests themselves and do not see -n.
    return (config.getoption("numprocesses", None) or "PYTEST_XDIST_WORKER" in os.environ) and not config.getoption("markexpr")


def pytest_collection_modifyitems(config, items):
    if not RELAY_IP:
        skip = pytest.mark.skip(reason="needs the local relay (RELAY_IP)")
        for item in items:
            if "local_relay" in item.keywords:
                item.add_marker(skip)
    if parallel(config):
        exclusive = [item for item in items if "exclusive" in item.keywords]
        if exclusive:
            config.hook.pytest_deselected(items=exclusive)
            items[:] = [item for item in items if "exclusive" not in item.keywords]


def pytest_report_header(config):
    if parallel(config):
        return "exclusive tests are deselected with -n; run them alone: pytest e2e -m exclusive"


@pytest.fixture(scope="session")
def browser_type_launch_args(browser_type_launch_args, browser_name):
    path = os.environ.get("CHROMIUM_PATH") if browser_name == "chromium" else None
    return {**browser_type_launch_args, "executable_path": path} if path else browser_type_launch_args


@pytest.fixture
def context(context):
    context.set_default_timeout(TIMEOUT)
    context.on("console", lambda m: m.type in ("error", "warning") and print(f"browser {m.type}: {m.text}"))
    context.on("weberror", lambda e: print(f"page error: {e.error}"))
    return context


@pytest.fixture(scope="session", autouse=True)
def bridge():
    """Serves web/dist and bridges to the relay; the iroh relay of e2e/relay is allowed for the transfer test."""
    env = {
        **os.environ, "PORT": str(PORT), "HOST_MAP": f"{RELAY}={RELAY_IP}" if RELAY_IP else "",
        "CONNECT_SRC": f"ws://127.0.0.1:3340 http://127.0.0.1:3340 {INVITE.rstrip('/')}",
    }
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", PORT)) == 0:
            raise RuntimeError(f"port {PORT} is in use, the tests would run against another bridge")
    proc = subprocess.Popen(["node", str(ROOT / "bridge/server.mjs")], env=env)
    deadline = time.time() + 20
    while True:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/healthz", timeout=1)
            if proc.poll() is not None:
                raise RuntimeError(f"bridge exited, port {PORT} is probably in use")
            break
        except OSError:
            if time.time() > deadline or proc.poll() is not None:
                proc.terminate()
                raise RuntimeError("bridge did not start")
            time.sleep(0.2)
    yield proc
    proc.terminate()
    proc.wait()


def start_rpc(rpc_server_path):
    tmp = tempfile.TemporaryDirectory()
    rpc = Rpc(accounts_dir=tmp.name, rpc_server_path=rpc_server_path)
    rpc.start()
    return tmp, rpc


@pytest.fixture(scope="session")
def rpc():
    tmp, rpc = start_rpc(str(Path(sys.executable).parent / "deltachat-rpc-server"))
    yield rpc
    rpc.close()
    tmp.cleanup()


@pytest.fixture
def make_account(rpc):
    """Creates configured Delta Chat core accounts and stops them after the test."""
    dc = DeltaChat(rpc)
    created = []

    def make(name):
        acc = configure(dc.add_account(), name)
        created.append(acc)
        return acc

    yield make
    for acc in created:
        acc.stop_io()
        acc.remove()


@pytest.fixture
def web(page, make_account):
    """A new web profile, connected to the core account "Phone" through the QR code after setup."""
    phone = make_account("Phone")
    addr = create_profile(page, phone)
    return SimpleNamespace(page=page, addr=addr, phone=phone)


@pytest.fixture
def dora(web, make_account):
    """A core contact that the web client joined through Dora's invite link (SecureJoin v3)."""
    acc = make_account("Dora")
    page = web.page
    new_chat(page, "Add contact")
    page.locator("dialog textarea").fill(acc.get_qr_code())
    page.get_by_role("button", name="Connect").click()
    ev = wait_event(acc, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    expect(page.locator(".info", has_text="Secure connection established")).to_be_visible()
    page.locator(".chatlist li", has_text="Dora").first.click()
    return SimpleNamespace(acc=acc, contact_id=ev.contact_id, chat=acc.get_chat_by_contact(ev.contact_id))
