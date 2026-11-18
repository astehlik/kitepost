from playwright.sync_api import expect

from helpers import wait_text, web_send


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
