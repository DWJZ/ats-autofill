-- Read ONE unread inbox message by position.
--
-- WHY IT TAKES AN INDEX. Mail refuses every LOOPING access to this mailbox - it holds 21,727 messages and
-- `repeat with m in (every message of inbox whose read status is false)`, `repeat ... item i of (...)` and even a plain
-- arithmetic walk all raise -10004 "A privilege violation occurred". What does work, reliably, is a SINGLE non-repeating
-- access in its own osascript invocation:
--   tell application "Mail" to get subject of item 1 of (every message of inbox whose read status is false)
-- So the loop lives in the shell (see mail_unread_report.sh) and each call here does exactly one thing. Index 0 returns
-- just the count, which is also a single access and is what tells the caller how far to loop.
--
-- Usage: osascript mail_app_list_unread.applescript <index>     (0 = count only)
on run argv
	set idx to 0
	if (count of argv) > 0 then set idx to (item 1 of argv) as integer
	tell application "Mail"
		if idx is 0 then
			return "UNREAD: " & (unread count of inbox)
		end if
		set msg to item idx of (every message of inbox whose read status is false)
		set subj to "?"
		set sndr to "?"
		set whens to "?"
		try
			set subj to subject of msg
		end try
		try
			set sndr to sender of msg
		end try
		try
			set whens to (date received of msg) as string
		end try
		return "- " & subj & "  ||  " & sndr & "  ||  " & whens
	end tell
end run
