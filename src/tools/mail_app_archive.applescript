-- Archive inbox messages, BY SUBJECT NEEDLE - never by position.
--
-- WHY THIS EXISTS (2026-10-08, user request): "拒信和申请的自动回复都 archive". Marking read leaves the inbox full of
-- rejections and receipts; archiving is what actually clears it. This is the only mail tool that MOVES a message, so
-- it is deliberately the most conservative one here.
--
-- IT WORKS PER ACCOUNT, BECAUSE THERE ARE SIX OF THEM. The mailbox holds user@example.com, user@example.com,
-- user@example.com, user@example.com, user@example.com and user@example.com, and the application
-- mail is spread across them - a first version searched the unified inbox and moved everything into Gmail's All Mail,
-- which could file another account's mail in the wrong place. Instead each account's own INBOX is searched and each
-- match moves into that same account's archive mailbox: **All Mail** on the Gmail accounts, **Archive** on the others.
-- Nothing is deleted: the message leaves the inbox and stays in its own account.
--
-- THE SAME THREE RULES AS THE MARK-READ TOOL, FOR THE SAME REASONS:
--   1. Subject needles, never positions. A positional marker cannot guarantee that personal mail is untouched, and
--      three messages were once marked wrongly that way.
--   2. A needle shorter than 12 characters is REFUSED. `subject contains ""` matches every message, so a short or
--      empty needle would archive the user's personal and marketing mail in one sweep.
--   3. `read status is true` in the query. Scanning every message whose subject contains a generic phrase times out
--      (-1712) even while Mail sits idle; the read filter makes it cheap, and it is right here because this tool is
--      used on mail that has already been triaged.
--
-- Usage: osascript mail_app_archive.applescript "Thanks for applying to Confido"
--        osascript mail_app_archive.applescript "needle one" "needle two"
-- Only application-related mail may be passed here (see the application-mail-triage skill). The script prints what it
-- matched, per account, so the caller can confirm the right messages moved rather than trusting the call.
on run argv
	if (count of argv) = 0 then return "usage: mail_app_archive.applescript \"<subject needle>\" [more needles...]"
	tell application "Mail"
		with timeout of 600 seconds
			set report to ""
			repeat with a in accounts
				set acctName to (user name of a)
				-- Resolve this account's archive mailbox. `mailbox "All Mail" of account 1` is refused with -1728 even
				-- though the name is listed, so the mailboxes are walked by name instead of addressed directly.
				set dest to missing value
				set src to missing value
				repeat with m in mailboxes of a
					set mname to (name of m)
					if mname is "All Mail" or mname is "Archive" then set dest to m
					if mname is "INBOX" then set src to m
				end repeat
				if dest is not missing value and src is not missing value then
					repeat with t in argv
						set needle to (t as string)
						if (length of needle) < 12 then
							set report to report & "REFUSED (needle too short to be safe): " & needle & linefeed
						else
							set n to 0
							try
								set msgs to (every message of src whose read status is true and subject contains needle)
								repeat with msg in msgs
									try
										move msg to dest
										set n to n + 1
									end try
								end repeat
								if n > 0 then set report to report & "archived " & n & " in " & acctName & " for: " & needle & linefeed
							on error errMsg number errNum
								set report to report & "FAILED (" & errNum & ") in " & acctName & " for: " & needle & linefeed
							end try
						end if
					end repeat
				end if
			end repeat
			if report is "" then set report to "nothing matched" & linefeed
			return report & "UNREAD NOW: " & (unread count of inbox)
		end timeout
	end tell
end run
