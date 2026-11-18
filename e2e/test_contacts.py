from playwright.sync_api import expect

from helpers import new_chat, open_chat, wait_text, web_send


def delete_chat(page):
    page.locator(".chathead").get_by_role("button", name="Edit chat").click()
    page.locator("dialog").get_by_role("button", name="Delete chat").click()
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
    page.locator(".chathead").get_by_role("button", name="Edit chat").click()
    page.locator("dialog").get_by_role("button", name="Block contact").click()
    page.locator("dialog", has_text="Block this contact?").get_by_role("button", name="Block contact").click()
    expect(page.locator("dialog")).to_have_count(0)


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
    page.locator(".chathead").get_by_role("button", name="Edit chat").click()
    page.locator("dialog").get_by_role("button", name="Group with Dora").click()
    expect(page.locator(".chathead strong")).to_have_text("Group with Dora")
    page.locator(".chatlist").get_by_text("Dora", exact=True).click()
    block_in_profile(page)

    group.send_text("Dora in the group")
    open_chat(page, "Group with Dora")
    expect(page.locator(".msg.in", has_text="Dora in the group")).to_be_visible()
