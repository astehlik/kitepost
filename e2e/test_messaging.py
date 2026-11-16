"""Messaging between the web client and Delta Chat core."""

import re
import subprocess
import time

import pytest
from deltachat_rpc_client import EventType
from deltachat_rpc_client.const import MessageState
from playwright.sync_api import expect

from helpers import PNG, addr_of, open_chat, wait_event, wait_text, web_send


def test_phone_connects_by_scanning_the_setup_qr(web):
    contact = web.phone.get_contact_by_addr(web.addr).get_snapshot()
    assert contact.is_key_contact and contact.e2ee_avail, contact


def test_join_core_invite(dora):
    contact = dora.acc.get_contact_by_id(dora.contact_id).get_snapshot()
    assert contact.is_key_contact, "core has no key contact for web"


def test_text_both_ways(web, dora):
    dora.chat.send_text("Hello from Delta Chat core ✓")
    expect(web.page.locator(".msg.in", has_text="Hello from Delta Chat core ✓")).to_be_visible()
    web_send(web.page, "Hi from the browser 🌐")
    snap = wait_text(dora.acc, "Hi from the browser 🌐")
    assert snap.show_padlock, "message not shown as encrypted in core"


def wait_state(acc, msg_id, state, seconds=60):
    deadline = time.time() + seconds
    while acc.get_message_by_id(msg_id).get_snapshot().state != state:
        assert time.time() < deadline, f"message {msg_id} did not reach state {state}"
        time.sleep(0.5)


def test_read_receipts_both_ways(web, dora):
    web_send(web.page, "please read me")
    snap = wait_text(dora.acc, "please read me")
    dora.acc.mark_seen_messages([dora.acc.get_message_by_id(snap.id)])
    expect(web.page.locator(".msg.out", has_text="please read me").locator(".meta")).to_contain_text("✓✓")

    msg = dora.chat.send_text("read by the browser")
    expect(web.page.locator(".msg.in", has_text="read by the browser")).to_be_visible()
    wait_state(dora.acc, msg.id, MessageState.OUT_MDN_RCVD)


def test_read_receipts_can_be_turned_off(web, dora):
    web.page.get_by_role("button", name="Edit profile").click()
    web.page.get_by_label("Send read receipts").uncheck()
    web.page.get_by_role("button", name="Save").click()

    msg = dora.chat.send_text("read silently")
    expect(web.page.locator(".msg.in", has_text="read silently")).to_be_visible()
    web_send(web.page, "no receipt wanted")
    snap = wait_text(dora.acc, "no receipt wanted")
    dora.acc.mark_seen_messages([dora.acc.get_message_by_id(snap.id)])
    time.sleep(5)
    assert dora.acc.get_message_by_id(msg.id).get_snapshot().state == MessageState.OUT_DELIVERED
    expect(web.page.locator(".msg.out", has_text="no receipt wanted").locator(".meta")).not_to_contain_text("✓✓")


def test_reactions(web, dora):
    msg = dora.chat.send_text("React to me")
    incoming = web.page.locator(".msg.in", has_text="React to me")
    expect(incoming).to_be_visible()

    msg.send_reaction("👍")
    expect(incoming.locator(".reactions")).to_contain_text("👍")

    incoming.hover()
    incoming.get_by_role("button", name="React").click()
    web.page.locator(".quick-reactions button", has_text="❤️").click()
    wait_event(dora.acc, EventType.REACTIONS_CHANGED, lambda e: "❤️" in str(msg.get_reactions()))
    incoming.locator(".reaction.mine").click()
    wait_event(dora.acc, EventType.REACTIONS_CHANGED, lambda e: "❤️" not in str(msg.get_reactions()))


def test_emoji_completion_and_picker(web, dora):
    box = web.page.locator(".composer textarea")
    box.press_sequentially("Emoji test :thumbsu")
    expect(web.page.locator(".emoji-suggest li.active")).to_contain_text("👍")
    box.press("Enter")
    expect(box).to_have_value("Emoji test 👍")
    web.page.get_by_role("button", name="Insert emoji").click()
    web.page.get_by_placeholder("Search emojis").fill("rocket")
    web.page.locator(".emoji-picker .emoji-row button").first.click()
    expect(box).to_have_value("Emoji test 👍🚀")
    box.press("Enter")
    wait_text(dora.acc, "Emoji test 👍🚀")


# Independent of the client's detection: a colored glyph no wider than one emoji.
RENDERS_AS_EMOJI = """emoji => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    ctx.canvas.width = ctx.canvas.height = 40;
    ctx.font = `32px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textBaseline = 'top';
    if (ctx.measureText(emoji).width > ctx.measureText('😀').width * 1.5) return false;
    ctx.fillText(emoji, 0, 0);
    const d = ctx.getImageData(0, 0, 40, 40).data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && Math.abs(d[i] - d[i + 2]) > 40) return true;
    return false;
}"""


PIXEL_STATS = """() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    ctx.canvas.width = ctx.canvas.height = 40;
    ctx.font = `32px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textBaseline = 'top';
    return ['😀', '🫩', '🫪', '🫫'].map(e => {
        ctx.clearRect(0, 0, 40, 40);
        ctx.fillText(e, 0, 0);
        const d = ctx.getImageData(0, 0, 40, 40).data;
        let ink = 0, rg = 0, rb = 0;
        const colors = new Map();
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] <= 128) continue;
            ink++;
            if (Math.max(Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2])) > 40) rg++;
            if (Math.abs(d[i] - d[i + 2]) > 40) rb++;
            const c = `${d[i] >> 5},${d[i + 1] >> 5},${d[i + 2] >> 5}`;
            colors.set(c, (colors.get(c) ?? 0) + 1);
        }
        const top = [...colors].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c}:${n}`).join(' ');
        return `${e} width=${ctx.measureText(e).width.toFixed(1)} ink=${ink} rg/gb=${rg} rb=${rb} top=${top}`;
    }).join('; ');
}"""


def test_picker_only_offers_emojis_the_browser_can_show(web, browser_name):
    page = web.page
    open_chat(page, "Phone")
    page.get_by_role("button", name="Insert emoji").click()
    page.get_by_placeholder("Search emojis").fill("cracking face")
    expect(page.locator(".emoji-picker .hint", has_text="Loading")).to_have_count(0)
    offered = page.locator(".emoji-picker button.emoji", has_text="🫫").count() == 1
    renders = page.evaluate(RENDERS_AS_EMOJI, "🫫")
    if offered != renders:
        fonts = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True).stdout
        pytest.fail(f"offered={offered} renders={renders} "
                    f"picker hides versions: {page.locator('.emoji-picker').get_attribute('data-unsupported')}\n"
                    f"pixels: {page.evaluate(PIXEL_STATS)}\n"
                    f"emoji fonts: {sorted(set(f for f in fonts.splitlines() if 'moji' in f.lower()))}")
    if browser_name == "firefox":
        assert not offered, "Firefox's bundled emoji font has no Emoji 18"


def test_attachment_by_file_picker(web, dora, tmp_path):
    png = tmp_path / "dot.png"
    png.write_bytes(PNG)
    web.page.locator('.composer input[type="file"]').set_input_files(str(png))
    web_send(web.page, "a picture")
    assert wait_text(dora.acc, "a picture").file_name == "dot.png"


def test_attachment_by_paste(web, dora, browser_name):
    if browser_name == "firefox":
        pytest.skip("Firefox drops the files of synthetic paste events; real pastes are trusted events")
    web.page.locator(".composer textarea").evaluate("""(el, hex) => {
        const bytes = new Uint8Array(hex.match(/../g).map(b => parseInt(b, 16)));
        const data = new DataTransfer();
        data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }""", PNG.hex())
    expect(web.page.locator(".composer .chip")).to_contain_text("pasted.png")
    web_send(web.page, "a pasted picture")
    assert wait_text(dora.acc, "a pasted picture").file_name == "pasted.png"


def test_core_group_with_web_member(web, dora):
    group = dora.acc.create_group("Interop group")
    group.add_contact(dora.acc.get_contact_by_id(dora.contact_id))
    group.send_text("Welcome to the group")
    open_chat(web.page, "Interop group")
    expect(web.page.locator(".msg.in", has_text="Welcome to the group")).to_be_visible()
    web_send(web.page, "Group reply from web")
    assert wait_text(dora.acc, "Group reply from web").chat_id == group.id


def test_core_joins_web_invite(web, make_account):
    erin = make_account("Erin")
    web.page.get_by_role("button", name="My invite").click()
    link = web.page.locator("dialog input").input_value()
    web.page.get_by_role("button", name="Copy link").click()
    expect(web.page.locator("dialog .actions button").first).to_have_text(re.compile("Copied|Ctrl"))
    web.page.get_by_role("button", name="Close").click()
    erin.secure_join(link)
    wait_event(erin, EventType.SECUREJOIN_JOINER_PROGRESS, lambda e: e.progress == 1000)
    contact = erin.get_contact_by_addr(web.addr)
    assert contact.get_snapshot().e2ee_avail, "core cannot encrypt to the web inviter"
    erin.get_chat_by_contact(contact).send_text("Erin here")
    open_chat(web.page, "Erin")
    expect(web.page.locator(".msg.in", has_text="Erin here")).to_be_visible()
    expect(web.page.locator(".request")).to_have_count(0)
    web_send(web.page, "Welcome Erin")
    wait_text(erin, "Welcome Erin")


def test_web_group_and_group_invite(web, dora, make_account):
    page = web.page
    page.get_by_role("button", name="New group").click()
    page.locator("dialog .field input").fill("Web group")
    page.locator("dialog .members label", has_text="Dora").locator("input").check()
    page.get_by_role("button", name="Create", exact=True).click()
    expect(page.locator(".info", has_text="Group created")).to_be_visible()
    web_send(page, "First message in web group")
    snap = wait_text(dora.acc, "First message in web group")
    assert dora.acc.get_chat_by_id(snap.chat_id).get_basic_snapshot().name == "Web group"

    erin = make_account("Erin")
    page.get_by_role("button", name="Invite link").click()
    link = page.locator("dialog input").input_value()
    page.get_by_role("button", name="Close").click()
    erin.secure_join(link)
    wait_event(erin, EventType.SECUREJOIN_JOINER_PROGRESS, lambda e: e.progress == 1000)
    expect(page.locator(".info", has_text="joined the group")).to_be_visible()
    erin_group = next(c for c in erin.get_chatlist() if c.get_basic_snapshot().name == "Web group")
    erin_group.send_text("Erin in web group")
    expect(page.locator(".msg.in", has_text="Erin in web group")).to_be_visible()
    snap = wait_text(dora.acc, "Erin in web group")
    assert dora.acc.get_chat_by_id(snap.chat_id).get_basic_snapshot().name == "Web group"


def test_rename_updates_header(web):
    web.page.get_by_role("button", name="Edit profile").click()
    web.page.locator("dialog .field input").first.fill("Webby Renamed")
    web.page.get_by_role("button", name="Save").click()
    expect(web.page.locator(".profile strong")).to_have_text("Webby Renamed")


def test_storage_unlock_and_stay_unlocked(web):
    page = web.page
    page.reload()
    page.locator('input[type="password"]').fill("correct horse battery")
    page.get_by_label("Stay unlocked in this browser").check()
    page.get_by_role("button", name="Unlock").click()
    expect(page.locator(".chatlist li", has_text="Phone")).to_be_visible()

    page.reload()
    expect(page.locator(".chatlist li", has_text="Phone")).to_be_visible()
    page.get_by_role("button", name="Edit profile").click()
    expect(page.get_by_label("Stay unlocked in this browser")).to_be_checked()
    page.get_by_role("button", name="Lock").click()
    expect(page.get_by_role("heading", name="Unlock Kitepost")).to_be_visible()
    page.reload()
    expect(page.get_by_role("heading", name="Unlock Kitepost")).to_be_visible()
    assert addr_of(web.phone)
