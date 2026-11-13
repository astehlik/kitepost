"""Delta Chat's "Add second device" received by the web client over the relay's iroh relay.

Needs a deltachat-rpc-server with docs/upstream/0003-backup-transfer-relay.patch in
DC_RPC_SERVER and the `iroh` service of e2e/relay.
"""

import os

import pytest
from deltachat_rpc_client import DeltaChat, EventType
from playwright.sync_api import expect

from conftest import start_rpc
from helpers import addr_of, configure, open_chat, set_passphrase, wait_event, wait_text, web_send

pytestmark = [
    pytest.mark.local_relay,
    pytest.mark.skipif(not os.environ.get("DC_RPC_SERVER"), reason="needs a patched core in DC_RPC_SERVER"),
    pytest.mark.skip(reason="the Scan QR button is hidden until Delta Chat releases offer the transfer over a relay"),
]


@pytest.fixture
def patched_rpc():
    tmp, rpc = start_rpc(os.environ["DC_RPC_SERVER"])
    yield rpc
    rpc.close()
    tmp.cleanup()


def test_second_device_by_qr(page, patched_rpc):
    dc = DeltaChat(patched_rpc)
    phone = configure(dc.add_account(), "Alice Phone")
    bob = configure(dc.add_account(), "Bob")
    bob.secure_join(phone.get_qr_code())
    wait_event(phone, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    phone.get_contact_by_addr(addr_of(bob)).create_chat().send_text("before the transfer")
    bob_chat = bob.get_chat_by_id(wait_text(bob, "before the transfer").chat_id)

    provided = patched_rpc.provide_backup.future(phone.id)
    qr = patched_rpc.get_backup_qr(phone.id)
    assert '"relay_url"' in qr and "127.0.0.1:3340" in qr, f"QR code has no relay: {qr}"

    # Headless Chromium has no camera, so the code is pasted.
    set_passphrase(page)
    page.get_by_role("button", name="Scan QR from phone").click()
    page.get_by_label("QR code text").fill(qr)
    expect(page.locator(".status.ok")).to_be_visible()
    provided()

    open_chat(page, "Bob")
    expect(page.locator(".msg.out", has_text="before the transfer")).to_be_visible()
    web_send(page, "after the transfer")
    assert wait_text(bob, "after the transfer").chat_id == bob_chat.id
