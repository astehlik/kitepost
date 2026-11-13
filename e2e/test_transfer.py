"""End-to-end test of "Add second device": Delta Chat core offers its profile via QR code and
the web client receives it over the relay's iroh relay.

Needs a deltachat-rpc-server with the relay patch from docs/upstream (DC_RPC_SERVER) and the
`iroh` service of e2e/relay; otherwise the same as test_interop.py.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from deltachat_rpc_client import DeltaChat, EventType, Rpc
from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_interop import (
    PORT, RELAY, RELAY_IP, ROOT, TIMEOUT, log, new_core_account, open_chat, set_passphrase, wait_event, wait_text,
    web_send,
)


def main():
    rpc_path = os.environ.get("DC_RPC_SERVER") or str(Path(sys.executable).parent / "deltachat-rpc-server")
    bridge = subprocess.Popen(
        ["node", str(ROOT / "bridge/server.mjs")],
        env={**os.environ, "PORT": str(PORT), "CONNECT_SRC": "ws://127.0.0.1:3340 http://127.0.0.1:3340", "HOST_MAP": f"{RELAY}={RELAY_IP}" if RELAY_IP else ""},
    )
    try:
        with tempfile.TemporaryDirectory() as tmp, Rpc(accounts_dir=tmp, rpc_server_path=rpc_path) as rpc, sync_playwright() as pw:
            dc = DeltaChat(rpc)
            phone = new_core_account(dc, "Alice Phone")
            bob = new_core_account(dc, "Bob")
            bob.secure_join(phone.get_qr_code())
            wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
            bob_addr = bob.list_transports()[0]["addr"]
            phone.get_contact_by_addr(bob_addr).create_chat().send_text("before the transfer")
            bob_chat = bob.get_chat_by_id(wait_text(bob, "before the transfer").chat_id)

            log("1. phone offers the profile")
            provided = rpc.provide_backup.future(phone.id)
            qr = rpc.get_backup_qr(phone.id)
            assert '"relay_url"' in qr and "127.0.0.1:3340" in qr, f"QR code has no relay: {qr}"

            browser = pw.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
            page = browser.new_page()
            page.on("console", lambda m: m.type in ("error", "warning") and log(f"browser {m.type}: {m.text}"))
            page.on("pageerror", lambda e: log(f"page error: {e}"))
            page.set_default_timeout(TIMEOUT)

            log("2. web client scans it (pasted, headless Chromium has no camera)")
            set_passphrase(page)
            page.get_by_role("button", name="Scan QR from phone").click()
            page.get_by_label("QR code text").fill(qr)
            expect(page.locator(".status.ok")).to_be_visible(timeout=TIMEOUT)
            provided()
            log("   phone reports the transfer as done")

            log("3. history and messaging")
            open_chat(page, "Bob")
            expect(page.locator(".msg.out", has_text="before the transfer")).to_be_visible()
            web_send(page, "after the transfer")
            assert wait_text(bob, "after the transfer").chat_id == bob_chat.id

            log("ALL TRANSFER TESTS PASSED")
            browser.close()
    finally:
        bridge.terminate()


if __name__ == "__main__":
    main()
