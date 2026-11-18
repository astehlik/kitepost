from pathlib import Path

from deltachat_rpc_client import EventType
from deltachat_rpc_client.const import ViewType
from playwright.sync_api import expect

from helpers import addr_of, new_chat, open_chat, open_profile, reload_and_unlock, solid_png, wait_event, wait_text, web_send


def delete_chat(page):
    open_profile(page).get_by_role("button", name="Delete chat").click()
    page.locator("dialog", has_text="This cannot be undone.").get_by_role("button", name="Delete").click()


def test_start_chat_from_contact_list(web, dora):
    page = web.page
    delete_chat(page)
    expect(page.locator(".chatlist li[data-chat]", has_text="Dora")).to_have_count(0)

    page.get_by_role("button", name="New chat").click()
    contacts = page.locator(".new-chat li[data-contact]")
    expect(contacts).to_have_count(2)
    expect(contacts.first).to_contain_text("Phone")
    contacts.filter(has_text="Phone").get_by_role("button").click()
    expect(page.locator("dialog")).to_have_count(0)
    expect(page.locator(".chathead strong")).to_have_text("Phone")

    page.get_by_role("button", name="New chat").click()
    page.get_by_role("searchbox", name="Search contacts").fill("dor")
    expect(contacts).to_have_count(1)
    expect(page.locator(".new-chat").get_by_role("button", name="New group")).to_have_count(0)
    contacts.get_by_role("button").click()
    page.locator("dialog", has_text="Chat with Dora?").get_by_role("button", name="OK").click()
    expect(page.locator(".chathead strong")).to_have_text("Dora")
    web_send(page, "back again")
    wait_text(dora.acc, "back again")


def block_in_profile(page):
    profile = open_profile(page)
    profile.get_by_role("button", name="Block contact").click()
    page.locator("dialog", has_text="Block this contact?").get_by_role("button", name="Block contact").click()
    expect(profile.get_by_role("button", name="Unblock contact")).to_be_visible()
    profile.locator(".chathead :is(.back, .close):visible").click()


def test_block_and_unblock_contact(web, dora):
    page = web.page
    entry = page.locator(".chatlist li[data-chat]", has_text="Dora")
    block_in_profile(page)
    expect(entry).to_have_count(0)
    expect(page.locator(".chathead")).to_have_count(0)
    page.get_by_role("button", name="New chat").click()
    expect(page.locator(".new-chat li[data-contact]", has_text="Dora")).to_have_count(0)
    dora.chat.send_text("while blocked")

    page.get_by_role("button", name="Settings").first.click()
    page.get_by_role("button", name="Blocked contacts").click()
    blocked = page.locator("dialog", has_text="Blocked contacts")
    blocked.locator("li", has_text="Dora").get_by_role("button", name="Unblock contact").click()
    page.locator("dialog", has_text="Unblock this contact?").get_by_role("button", name="Unblock contact").click()
    expect(blocked).to_contain_text("Blocked contacts will appear here.")
    blocked.get_by_role("button", name="Close").click()
    expect(entry).to_have_count(1)

    dora.chat.send_text("after unblock")
    entry.click()
    expect(page.locator(".msg.in", has_text="after unblock")).to_be_visible()
    expect(page.locator(".msg.in", has_text="while blocked")).to_have_count(0)


def test_blocked_contact_still_writes_in_groups(web, dora):
    page = web.page
    new_chat(page, "New group")
    page.locator("dialog .field input").fill("Group with Dora")
    page.locator("dialog .members label", has_text="Dora").locator("input").check()
    page.get_by_role("button", name="Create", exact=True).click()
    web_send(page, "hello group")
    group = dora.acc.get_chat_by_id(wait_text(dora.acc, "hello group").chat_id)

    page.locator(".chatlist").get_by_text("Dora", exact=True).click()
    open_profile(page).get_by_role("button", name="Group with Dora").click()
    expect(page.locator(".chathead strong")).to_have_text("Group with Dora")
    page.locator(".chatlist").get_by_text("Dora", exact=True).click()
    block_in_profile(page)

    group.send_text("Dora in the group")
    open_chat(page, "Group with Dora")
    expect(page.locator(".msg.in", has_text="Dora in the group")).to_be_visible()


def test_profile_and_deletion_from_contact_list(web, dora):
    page = web.page
    page.get_by_role("button", name="New chat").click()
    row = page.locator(".new-chat li[data-contact]", has_text="Dora")
    row.click(button="right")
    page.locator(".menu").get_by_role("menuitem", name="View profile").click()
    page.locator(".settings.contact").locator(".chathead :is(.back, .close):visible").click()
    expect(row).to_be_visible()
    row.click(button="right")
    page.locator(".menu").get_by_role("menuitem", name="View profile").click()
    page.locator(".settings.contact").get_by_role("button", name="Send message").click()
    expect(page.locator(".chathead strong")).to_have_text("Dora")

    page.get_by_role("button", name="New chat").click()
    row.click(button="right")
    page.locator(".menu").get_by_role("menuitem", name="Delete contact").click()
    page.locator("dialog", has_text="Delete this contact?").get_by_role("button", name="Delete contact").click()
    expect(row).to_have_count(0)
    reload_and_unlock(page)
    page.get_by_role("button", name="New chat").click()
    expect(page.locator(".new-chat li[data-contact]")).to_have_count(1)

    dora.chat.send_text("still in our chat")
    open_chat(page, "Dora")
    expect(page.locator(".msg.in", has_text="still in our chat")).to_be_visible()


def test_contact_avatars(web, dora, tmp_path):
    page = web.page
    (tmp_path / "dora.png").write_bytes(solid_png(64, 64))
    dora.acc.set_config("selfavatar", str(tmp_path / "dora.png"))
    dora.chat.send_text("now with a picture")
    expect(page.locator(".msg.in", has_text="now with a picture")).to_be_visible()
    entry_avatar = page.locator(".chatlist li[data-chat]", has_text="Dora").locator(".avatar img")
    expect(entry_avatar).to_be_visible()
    expect(page.locator(".chathead .avatar img")).to_be_visible()
    expect(open_profile(page).locator(".profile-head .avatar img")).to_be_visible()
    page.locator(".settings.contact").locator(".chathead :is(.back, .close):visible").click()

    dora.acc.set_config("selfavatar", None)
    dora.chat.send_text("picture gone")
    expect(page.locator(".msg.in", has_text="picture gone")).to_be_visible()
    expect(entry_avatar).to_have_count(0)


def test_avatar_from_the_invite_handshake(web, make_account, tmp_path):
    page = web.page
    erin = make_account("Erin")
    (tmp_path / "erin.png").write_bytes(solid_png(64, 64))
    erin.set_config("selfavatar", str(tmp_path / "erin.png"))
    new_chat(page, "Add contact")
    page.locator("dialog textarea").fill(erin.get_qr_code())
    page.get_by_role("button", name="Connect").click()
    wait_event(erin, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    expect(page.locator(".chatlist li[data-chat]", has_text="Erin").locator(".avatar img")).to_be_visible()


def test_own_avatar_reaches_contacts(web, dora, tmp_path):
    page = web.page
    (tmp_path / "me.png").write_bytes(solid_png(600, 400))
    page.get_by_role("button", name="Settings").click()
    page.locator(".settings input[type=file]").set_input_files(str(tmp_path / "me.png"))
    expect(page.locator(".profile .avatar img")).to_be_visible()
    page.locator(".chatlist").get_by_text("Dora", exact=True).click()
    web_send(page, "see my picture")
    wait_text(dora.acc, "see my picture")
    me = dora.acc.get_contact_by_id(dora.contact_id)
    assert me.get_snapshot().profile_image

    page.get_by_role("button", name="Settings").click()
    page.locator(".settings").get_by_role("button", name="Remove").click()
    expect(page.locator(".profile .avatar img")).to_have_count(0)
    page.locator(".chatlist").get_by_text("Dora", exact=True).click()
    web_send(page, "picture removed")
    wait_text(dora.acc, "picture removed")
    assert not me.get_snapshot().profile_image


def test_share_contacts_with_core(web, dora, make_account, tmp_path):
    page = web.page
    erin = make_account("Erin")
    (tmp_path / "erin.png").write_bytes(solid_png(64, 64))
    erin.set_config("selfavatar", str(tmp_path / "erin.png"))
    new_chat(page, "Add contact")
    page.locator("dialog textarea").fill(erin.get_qr_code())
    page.get_by_role("button", name="Connect").click()
    wait_event(erin, EventType.SECUREJOIN_INVITER_PROGRESS, lambda e: e.progress == 1000)
    erin.get_contact_by_addr(web.addr).create_chat().send_text("hi from Erin")
    expect(page.locator(".msg.in", has_text="hi from Erin")).to_be_visible()

    open_profile(page).get_by_role("button", name="Share contact").click()
    page.locator("dialog .pick li", has_text="Dora").get_by_role("button").click()
    expect(page.locator(".chathead strong")).to_have_text("Dora")
    expect(page.locator(".msg.out .vcard")).to_contain_text(addr_of(erin))
    expect(page.locator(".chatlist li[data-chat]", has_text="Dora")).to_contain_text("👤 Erin")
    is_card = lambda e: dora.acc.get_message_by_id(e.msg_id).get_snapshot().view_type == ViewType.VCARD
    snap = dora.acc.get_message_by_id(wait_event(dora.acc, EventType.INCOMING_MSG, is_card).msg_id).get_snapshot()
    assert snap.view_type == ViewType.VCARD and snap.vcard_contact.addr == addr_of(erin), snap
    [dora_erin] = dora.acc.import_vcard(Path(snap.file).read_text())
    assert dora_erin.get_snapshot().profile_image
    dora_erin.create_chat().send_text("Dora found you")
    assert wait_text(erin, "Dora found you").show_padlock

    fiona = make_account("Fiona")
    [dora_fiona] = dora.acc.import_vcard(fiona.self_contact.make_vcard())
    dora.chat.send_contact(dora_fiona)
    shared = page.locator(".msg.in .vcard", has_text="Fiona")
    shared.click()
    page.locator("dialog", has_text="Chat with Fiona?").get_by_role("button", name="OK").click()
    expect(page.locator(".chathead strong")).to_have_text("Fiona")
    web_send(page, "hello Fiona")
    assert wait_text(fiona, "hello Fiona").show_padlock
