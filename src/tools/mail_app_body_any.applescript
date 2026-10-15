-- Print the body of the NEWEST inbox message whose subject contains the given string, READ OR UNREAD.
--
-- WHY: mail_app_body.applescript searches only unread messages, so a security code that has been read (or auto-read) is
-- invisible to it. This variant searches every message and returns the most recent match.
--
-- FIXED 2026-10-05. The previous version built a list with `set msgs to (messages of inbox)` and then walked it with
-- `repeat with m in msgs`. THAT LOOP CANNOT WORK: Mail raises -10004 "A privilege violation occurred" on any LOOPING
-- access to this mailbox, which holds over twenty thousand messages - the same constraint documented at the top of
-- mail_app_list_unread.applescript, where the loop was moved into the shell for exactly this reason. Because the error
-- aborted the handler, every call returned "no message (read or unread) matching: ..." even when the message existed:
-- three separate attempts to read a Browserbase follow-up and a Coinbase receipt all reported no match while
-- mail_list_unread_all.sh listed them.
--
-- WHAT BEHAVES: a SINGLE non-repeating access - `every message of inbox whose subject contains needle` - inside a
-- `with timeout` block. That is the form the sibling mark-read script has used successfully since 2026-10-04, and it
-- returns the matches directly instead of building a list one element at a time.
--
-- Usage: osascript mail_app_body_any.applescript "Security code" [maxMessages]

on run argv
	if (count of argv) = 0 then return "usage: mail_app_body_any.applescript \"<subject needle>\" [maxMessages]"
	set needle to item 1 of argv
	set limitN to 3
	if (count of argv) > 1 then set limitN to (item 2 of argv) as integer
	tell application "Mail"
		with timeout of 180 seconds
			-- ONE access, no loop over the mailbox.
			set hits to (every message of inbox whose subject contains needle)
			if (count of hits) = 0 then return "no message (read or unread) matching: " & needle
			-- hits may be large; take the newest few. Slicing a returned list does not re-walk the mailbox.
			set out to ""
			set n to (count of hits)
			if n > limitN then set startAt to n - limitN + 1
			if n <= limitN then set startAt to 1
			repeat with i from startAt to n
				set m to item i of hits
				set c to content of m
				if (length of c) > 1400 then set c to (text 1 thru 1400 of c)
				set out to out & "SUBJECT: " & (subject of m) & linefeed & "FROM: " & (sender of m) & linefeed & "DATE: " & (date received of m as string) & linefeed & "READ: " & (read status of m as string) & linefeed & linefeed & c & linefeed & "----" & linefeed
			end repeat
			return out
		end timeout
	end tell
end run
