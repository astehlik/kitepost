"""Messaging between the web client and Delta Chat core."""

import re
import subprocess
import time

import pytest
from deltachat_rpc_client import EventType
from deltachat_rpc_client.const import MessageState
from playwright.sync_api import expect

from helpers import EVENT_TIMEOUT, PNG, addr_of, capture_clipboard, message_action, open_chat, own_state, reload_and_unlock, wait_event, wait_text, web_send


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


def wait_state(acc, msg_id, state, seconds=EVENT_TIMEOUT):
    deadline = time.time() + seconds
    while acc.get_message_by_id(msg_id).get_snapshot().state != state:
        assert time.time() < deadline, f"message {msg_id} did not reach state {state}"
        time.sleep(0.5)


def test_read_receipts_both_ways(web, dora):
    web_send(web.page, "please read me")
    snap = wait_text(dora.acc, "please read me")
    dora.acc.mark_seen_messages([dora.acc.get_message_by_id(snap.id)])
    expect(own_state(web.page, "please read me")).to_have_attribute("data-state", "read")
    expect(own_state(web.page, "please read me")).to_have_attribute("aria-label", "Read")

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
    expect(own_state(web.page, "no receipt wanted")).not_to_have_attribute("data-state", "read")


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


def test_messages_of_the_same_second_keep_their_order(web, dora):
    page = web.page
    # Core smears its timestamps ahead after the burst of SecureJoin messages.
    time.sleep(3)
    while time.time() % 1 > 0.05:
        time.sleep(0.01)
    box = page.locator(".composer textarea")
    box.fill("first, from the browser")
    box.press("Enter")
    dora.chat.send_text("second, from core")
    expect(page.locator(".msg.in", has_text="second, from core")).to_be_visible()
    texts = page.locator(".messages .msg .text").all_inner_texts()
    assert texts.index("first, from the browser") < texts.index("second, from core"), texts

    reload_and_unlock(page)
    page.locator(".chatlist li", has_text="Dora").first.click()
    expect(page.locator(".msg.in", has_text="second, from core")).to_be_visible()
    texts = page.locator(".messages .msg .text").all_inner_texts()
    assert texts.index("first, from the browser") < texts.index("second, from core"), texts


def wait_core_text(acc, msg_id, text):
    wait_event(acc, EventType.MSGS_CHANGED, lambda e: acc.get_message_by_id(msg_id).get_snapshot().text == text)
    return acc.get_message_by_id(msg_id).get_snapshot()


def test_edits_both_ways(web, dora):
    page = web.page
    web_send(page, "typo heer")
    original = wait_text(dora.acc, "typo heer")
    own = page.locator(".msg.out", has_text="typo heer")
    message_action(page, own, "Edit")
    box = page.locator(".composer textarea")
    expect(page.locator(".composer .reply")).to_contain_text("typo heer")
    expect(box).to_have_value("typo heer")
    box.fill("typo here")
    box.press("Enter")
    expect(page.locator(".msg.out .text", has_text="typo here")).to_be_visible()
    expect(page.locator(".msg.out", has_text="typo here").locator(".meta")).to_contain_text("edited")
    snap = wait_core_text(dora.acc, original.id, "typo here")
    assert snap.is_edited

    expect(box).to_have_value("")
    box.press("ArrowUp")
    expect(box).to_have_value("typo here")
    box.fill("final wording")
    box.press("Enter")
    wait_core_text(dora.acc, original.id, "final wording")
    expect(page.locator(".messages .msg")).to_have_count(1)

    incoming = dora.chat.send_text("from core")
    expect(page.locator(".msg.in", has_text="from core")).to_be_visible()
    dora.acc._rpc.send_edit_request(dora.acc.id, incoming.id, "from core, edited")
    edited = page.locator(".msg.in", has_text="from core, edited")
    expect(edited.locator(".text")).to_have_text("from core, edited")
    expect(edited.locator(".meta")).to_contain_text("edited")


def long_press(msg):
    msg.dispatch_event("pointerdown", {"pointerType": "touch", "clientX": 10, "clientY": 10})
    msg.page.wait_for_timeout(700)
    msg.dispatch_event("pointerup", {"pointerType": "touch"})


def test_hover_offers_react_reply_and_the_menu(web, dora):
    page = web.page
    dora.chat.send_text("hover me")
    incoming = page.locator(".msg.in", has_text="hover me")
    incoming.hover()
    expect(incoming.locator(".actions button")).to_have_count(3)
    for name in ("React", "Reply", "More"):
        expect(incoming.get_by_role("button", name=name)).to_be_visible()

    incoming.locator(".text").click(button="right")
    menu = page.locator(".menu")
    expect(menu.get_by_role("menuitem")).to_have_text(["React", "Reply", "Message info", "Pin", "Save", "Copy text", "Delete message", "Select"])
    page.keyboard.press("Escape")
    expect(menu).to_have_count(0)

    incoming.get_by_role("button", name="More").focus()
    page.keyboard.press("Enter")
    expect(menu.get_by_role("menuitem").first).to_be_focused()
    page.keyboard.press("Escape")


def test_select_several_messages(web, dora):
    page = web.page
    capture_clipboard(page)
    dora.chat.send_text("first of two")
    first = page.locator(".msg.in", has_text="first of two")
    expect(first).to_be_visible()
    web_send(page, "second of two")
    second = page.locator(".msg.out", has_text="second of two")

    message_action(page, first, "Select")
    bar = page.locator(".selbar")
    expect(bar).to_contain_text("1 selected")
    expect(bar.get_by_role("button", name="Reply")).to_be_visible()
    expect(page.locator(".chathead")).to_be_hidden()
    second.click(modifiers=["ControlOrMeta"])
    expect(bar).to_contain_text("2 selected")
    expect(bar.get_by_role("button")).to_have_count(3)
    for name in ("End selection", "Copy text", "Delete message"):
        expect(bar.get_by_role("button", name=name)).to_be_visible()

    bar.get_by_role("button", name="Copy text").click()
    expect(bar).to_be_hidden()
    assert page.evaluate("window.copied") == "Dora:\nfirst of two\n\nWebby:\nsecond of two"

    first.click(modifiers=["ControlOrMeta"])
    second.click()
    expect(bar).to_contain_text("2 selected")
    second.click()
    expect(bar).to_contain_text("1 selected")
    page.keyboard.press("Escape")
    expect(bar).to_be_hidden()
    expect(page.locator(".msg.selected")).to_have_count(0)


def test_long_press_selects_on_narrow_screens(web, dora):
    page = web.page
    page.set_viewport_size({"width": 390, "height": 700})
    dora.chat.send_text("press me long")
    dora.chat.send_text("and me too")
    first = page.locator(".msg.in", has_text="press me long")
    second = page.locator(".msg.in", has_text="and me too")
    expect(second).to_be_visible()

    long_press(first)
    bar = page.locator(".selbar")
    expect(bar).to_contain_text("1 selected")
    expect(first).to_have_class(re.compile("selected"))
    bar.get_by_role("button", name="Reply").click()
    expect(page.locator(".composer .reply")).to_contain_text("press me long")
    expect(bar).to_be_hidden()

    long_press(first)
    second.click()
    expect(bar).to_contain_text("2 selected")
    bar.get_by_role("button", name="Delete message").click()
    expect(page.locator("dialog h2")).to_have_text("Delete 2 messages?")
    page.locator("dialog").get_by_role("button", name="Delete for me").click()
    expect(first).to_have_count(0)
    expect(second).to_have_count(0)


def delete_message(page, msg, label):
    message_action(page, msg, "Delete message")
    page.locator("dialog").get_by_role("button", name=label).click()
    expect(msg).to_have_count(0)


def test_delete_for_me_and_for_everyone(web, dora):
    page = web.page
    dora.chat.send_text("only gone here")
    incoming = page.locator(".msg.in", has_text="only gone here")
    message_action(page, incoming, "Delete message")
    expect(page.locator("dialog").get_by_role("button", name="Delete for everyone")).to_have_count(0)
    page.locator("dialog").get_by_role("button", name="Delete for me").click()
    expect(incoming).to_have_count(0)

    web_send(page, "oops, wrong chat")
    sent = wait_text(dora.acc, "oops, wrong chat")
    delete_message(page, page.locator(".msg.out", has_text="oops, wrong chat"), "Delete for everyone")
    wait_event(dora.acc, EventType.MSG_DELETED, lambda e: e.msg_id == sent.id)

    web_send(page, "one of two mistakes")
    web_send(page, "two of two mistakes")
    one = wait_text(dora.acc, "one of two mistakes")
    two = wait_text(dora.acc, "two of two mistakes")
    message_action(page, page.locator(".msg.out", has_text="one of two mistakes"), "Select")
    page.locator(".msg.out", has_text="two of two mistakes").click()
    page.locator(".selbar").get_by_role("button", name="Delete message").click()
    page.locator("dialog").get_by_role("button", name="Delete for everyone").click()
    expect(page.locator(".msg.out", has_text="of two mistakes")).to_have_count(0)
    deleted = set()
    wait_event(dora.acc, EventType.MSG_DELETED, lambda e: deleted.add(e.msg_id) or {one.id, two.id} <= deleted)


def test_delete_for_everyone_only_where_it_makes_sense(web, dora):
    page = web.page
    dora.chat.send_text("theirs")
    web_send(page, "mine")
    message_action(page, page.locator(".msg.in", has_text="theirs"), "Select")
    page.locator(".msg.out", has_text="mine").click()
    page.locator(".selbar").get_by_role("button", name="Delete message").click()
    dialog = page.locator("dialog")
    expect(dialog.get_by_role("button", name="Delete for me")).to_be_visible()
    expect(dialog.get_by_role("button", name="Delete for everyone")).to_have_count(0)
    dialog.get_by_role("button", name="Cancel").click()
    page.keyboard.press("Escape")
    expect(page.locator(".selbar")).to_be_hidden()

    message_action(page, page.locator(".msg.out", has_text="mine"), "Save")
    page.locator(".chatlist li", has_text="Saved messages").click()
    copy = page.locator(".msg.out", has_text="mine")
    message_action(page, copy, "Delete message")
    expect(dialog).to_contain_text("Removes it here and on your other devices.")
    expect(dialog.get_by_role("button", name="Delete for everyone")).to_have_count(0)
    dialog.get_by_role("button", name="Delete", exact=True).click()
    expect(copy).to_have_count(0)


def open_info(page, msg):
    message_action(page, msg, "Message info")
    return page.locator("dialog")


def test_message_info(web, dora):
    page = web.page
    web_send(page, "info about me")
    sent = wait_text(dora.acc, "info about me")
    dora.acc.mark_seen_messages([dora.acc.get_message_by_id(sent.id)])
    own = page.locator(".msg.out", has_text="info about me")
    expect(own.locator(".meta .state")).to_have_attribute("data-state", "read")
    info = open_info(page, own)
    expect(info).to_contain_text("Sent")
    expect(info.locator("dd", has_text="Dora")).to_contain_text("Dora")
    expect(info).to_contain_text("Read by")
    expect(info).to_contain_text("End-to-end encrypted")
    expect(info.locator(".message-id")).to_contain_text("@")
    info.get_by_role("button", name="Close").click()

    msg = dora.chat.send_text("info about dora")
    msg.send_reaction("👍")
    incoming = page.locator(".msg.in", has_text="info about dora")
    expect(incoming.locator(".reactions")).to_contain_text("👍")
    info = open_info(page, incoming)
    expect(info).to_contain_text("Received")
    expect(info).to_contain_text("👍")
    expect(info).not_to_contain_text("Read by")


def test_send_errors_are_explained(web, dora):
    page = web.page
    web_send(page, "edit me offline")
    page.route_web_socket(re.compile(r"port=465"), lambda ws: ws.close())
    box = page.locator(".composer textarea")
    box.fill("no way out")
    box.press("Enter")
    own = page.locator(".msg.out", has_text="no way out")
    expect(own.locator(".meta .state")).to_have_attribute("data-state", "failed")
    expect(own.locator(".meta")).to_have_text(re.compile(r"No connection to the server$"))
    info = open_info(page, own)
    expect(info.locator("dd", has_text="connection closed")).to_be_visible()
    info.get_by_role("button", name="Close").click()

    message_action(page, page.locator(".msg.out", has_text="edit me offline"), "Edit")
    box.fill("edited offline")
    box.press("Enter")
    error = page.locator("dialog", has_text="That did not work")
    expect(error).to_contain_text("No connection to the server")
    expect(error.locator(".error-detail")).to_have_text("connection closed")


def test_quotes_both_ways(web, dora):
    page = web.page
    web_send(page, "question from the browser")
    question = wait_text(dora.acc, "question from the browser")
    dora.chat.send_message(text="answer from core", quoted_msg=question.id)
    incoming = page.locator(".msg.in", has_text="answer from core")
    expect(incoming.locator(".quote")).to_contain_text("question from the browser")
    expect(incoming.locator(".text")).to_have_text("answer from core")

    incoming.hover()
    incoming.get_by_role("button", name="Reply").click()
    expect(page.locator(".composer .reply")).to_contain_text("answer from core")
    web_send(page, "follow-up from the browser")
    expect(page.locator(".msg.out", has_text="follow-up").locator(".quote")).to_contain_text("answer from core")
    expect(page.locator(".composer .reply")).to_be_hidden()
    reply = wait_text(dora.acc, "follow-up from the browser")
    assert reply.quote.text == "answer from core"
    assert reply.quote.message_id == dora.acc.get_message_by_id(reply.quote.message_id).id

    incoming.hover()
    incoming.get_by_role("button", name="Reply").click()
    page.locator(".composer textarea").press("Escape")
    expect(page.locator(".composer .reply")).to_be_hidden()
    web_send(page, "> not a quote")
    plain = wait_text(dora.acc, "> not a quote")
    assert plain.quote is None


def test_new_messages_leave_the_chat_in_place(web, dora):
    page = web.page
    for i in range(8):
        dora.chat.send_text(f"filler {i}\n" + "line\n" * 6)
    expect(page.locator(".msg.in", has_text="filler 7")).to_be_visible()
    page.locator(".msg.in", has_text="filler 0").evaluate("el => el.dataset.probe = 'kept'")
    box = page.locator(".composer textarea")
    box.fill("unfinished draft")
    messages = page.locator(".messages")
    messages.evaluate("el => el.scrollTop = 0")

    dora.chat.send_text("while typing")
    expect(page.locator(".msg.in", has_text="while typing")).to_be_attached()
    expect(box).to_be_focused()
    expect(box).to_have_value("unfinished draft")
    assert messages.evaluate("el => el.scrollTop") == 0
    expect(page.locator("[data-probe=kept]")).to_have_count(1)

    box.fill("sent now")
    box.press("Enter")
    expect(own_state(page, "sent now")).to_have_attribute("data-state", "sent")
    expect(box).to_be_focused()
    expect(page.locator(".msg.out", has_text="sent now")).to_be_in_viewport()
    expect(page.locator("[data-probe=kept]")).to_have_count(1)


def test_composer_order_like_android(web, dora):
    order = web.page.locator(".composer").evaluate(
        "c => [...c.children].filter(e => e.checkVisibility()).map(e => e.getAttribute('aria-label') || (e.querySelector('textarea') ? 'input' : e.textContent))")
    assert order == ["Insert emoji", "input", "Attach file", "Send"], order


def test_composer_grows_up_to_a_limit(web, dora):
    page = web.page
    for i in range(8):
        dora.chat.send_text(f"filler {i}\n" + "line\n" * 6)
    dora.chat.send_text("latest")
    latest = page.locator(".msg.in", has_text="latest")
    expect(latest).to_be_visible()
    box = page.locator(".composer textarea")
    height = lambda: box.evaluate("el => el.offsetHeight")
    at_bottom = "() => { const l = document.querySelector('.messages'); return l.scrollHeight - l.scrollTop - l.clientHeight < 2; }"
    one_line = height()

    box.fill("1\n2\n3")
    assert height() > one_line * 2
    page.wait_for_function(at_bottom, timeout=2000)
    box.fill("\n".join(str(i) for i in range(30)))
    capped = height()
    assert one_line * 4 < capped < one_line * 10
    assert box.evaluate("el => el.scrollHeight > el.clientHeight")
    page.wait_for_function(at_bottom, timeout=2000)

    box.fill("")
    assert height() == one_line


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


def test_picker_only_offers_emojis_the_browser_can_show(web):
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


def test_pinning_in_core_shows_info_messages(web, dora):
    page = web.page
    msg = dora.chat.send_text("pin me")
    expect(page.locator(".msg.in", has_text="pin me")).to_be_visible()
    dora.acc._rpc.set_pinned_message_state(dora.acc.id, msg.id, True)
    expect(page.locator(".messages .info", has_text="Message pinned by Dora.")).to_be_visible()
    dora.acc._rpc.set_pinned_message_state(dora.acc.id, msg.id, False)
    expect(page.locator(".messages .info", has_text="Message unpinned by Dora.")).to_be_visible()
    expect(page.locator(".messages .msg")).to_have_count(1)


def wait_pinned(acc, chat_id, ids):
    pinned = lambda *_: acc._rpc.get_pinned_messages(acc.id, chat_id) == ids
    if not pinned():
        wait_event(acc, EventType.MSGS_CHANGED, pinned)


def test_pinning_both_ways(web, dora):
    page = web.page
    first = dora.chat.send_text("pin me first")
    second = dora.chat.send_text("pin me second")
    msg = page.locator(".msg.in", has_text="pin me first")
    expect(page.locator(".msg.in", has_text="pin me second")).to_be_visible()
    bar = page.locator(".pinbar")
    expect(bar).to_be_hidden()

    message_action(page, msg, "Pin")
    expect(page.locator(".messages .info", has_text="You pinned a message.")).to_be_visible()
    expect(msg.get_by_role("img", name="Pinned")).to_be_visible()
    expect(bar).to_contain_text("Pinned message")
    expect(bar).to_contain_text("pin me first")
    wait_pinned(dora.acc, dora.chat.id, [first.id])

    dora.acc._rpc.set_pinned_message_state(dora.acc.id, second.id, True)
    expect(page.locator(".msg.in", has_text="pin me second").get_by_role("img", name="Pinned")).to_be_visible()
    expect(bar).to_contain_text("Pinned message 2 of 2")
    expect(bar).to_contain_text("pin me second")
    bar.click()
    expect(bar).to_contain_text("Pinned message 1 of 2")
    expect(bar).to_contain_text("pin me first")
    bar.click()
    expect(msg).to_have_class(re.compile("flash"))
    expect(bar).to_contain_text("pin me second")

    message_action(page, msg, "Unpin")
    expect(page.locator(".messages .info", has_text="You unpinned a message.")).to_be_visible()
    expect(msg.get_by_role("img", name="Pinned")).to_have_count(0)
    expect(bar).to_have_text(re.compile("^Pinned messagepin me second$"))
    wait_pinned(dora.acc, dora.chat.id, [second.id])

    page.locator(".messages .info", has_text="Message pinned by Dora.").click()
    expect(page.locator(".msg.in", has_text="pin me second")).to_have_class(re.compile("flash"))


def test_group_changes_in_core_show_info_messages(web, dora):
    page = web.page
    group = dora.acc.create_group("Before")
    group.send_text("only me so far")
    group.add_contact(dora.acc.get_contact_by_id(dora.contact_id))
    open_chat(page, "Before")
    expect(page.locator(".messages .info", has_text="Dora added you to the group.")).to_be_visible()
    group.set_name("After")
    expect(page.locator(".messages .info", has_text='Group name changed from "Before" to "After" by Dora.')).to_be_visible()
    expect(page.locator(".messages .msg")).to_have_count(0)


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


def chat_menu(page, title, action):
    page.locator(".chatlist li[data-chat]", has_text=title).first.click(button="right")
    page.locator(".menu").get_by_role("menuitem", name=action).click()


def test_archive_and_pin_chats(web, dora):
    page = web.page
    entries = page.locator(".chatlist li[data-chat] strong")
    expect(entries).to_have_text(["Dora", "Phone"])
    chat_menu(page, "Phone", "Pin chat")
    expect(entries).to_have_text(["Phone", "Dora"])
    expect(page.locator(".chatlist li", has_text="Phone").get_by_role("img", name="Pinned chat")).to_be_visible()

    chat_menu(page, "Dora", "Archive")
    expect(entries).to_have_text(["Phone"])
    archive = page.locator(".chatlist li.archive-link")
    expect(archive).to_contain_text("Archived chats1")
    archive.click()
    expect(entries).to_have_text(["Dora"])
    chat_menu(page, "Dora", "Unarchive")
    expect(entries).to_have_text(["Phone", "Dora"])
    expect(archive).to_have_count(0)

    chat_menu(page, "Dora", "Archive")
    expect(entries).to_have_text(["Phone"])
    dora.chat.send_text("back from the archive")
    expect(entries).to_have_text(["Phone", "Dora"])
    chat_menu(page, "Phone", "Unpin chat")
    expect(entries).to_have_text(["Dora", "Phone"])


def test_last_seen(web, dora):
    page = web.page
    entry = page.locator(".chatlist li[data-chat]", has_text="Dora")
    dora.chat.send_text("still here")
    expect(entry.locator(".avatar.seen")).to_be_visible()
    expect(page.locator(".chathead small")).to_contain_text("Last seen 1 minute ago")
    expect(page.locator(".chathead .avatar.seen")).to_be_visible()

    page.clock.install()
    reload_and_unlock(page)
    open_chat(page, "Dora")
    expect(entry.locator(".avatar.seen")).to_be_visible()
    page.clock.fast_forward("11:00")
    expect(entry.locator(".avatar.seen")).to_have_count(0)
    expect(page.locator(".chathead small")).to_contain_text("Last seen 11 minutes ago")


def test_rename_updates_header(web):
    web.page.get_by_role("button", name="Edit profile").click()
    web.page.locator("dialog .field input").first.fill("Webby Renamed")
    web.page.get_by_role("button", name="Save").click()
    expect(web.page.locator(".profile strong")).to_have_text("Webby Renamed")


def test_storage_unlock_and_stay_unlocked(web):
    page = web.page
    reload_and_unlock(page, stay_unlocked=True)
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
