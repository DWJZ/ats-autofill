-- Mark unread inbox messages read, BY SUBJECT NEEDLE - never by position.
--
-- WHY THE INDEX VERSION WAS REMOVED (2026-10-04). It took an index into the unread set and was called with 1, on the
-- reasoning that each success removes a message from the unread set so the next unread message becomes item 1 again.
-- The reasoning is sound and the script worked, but the ORDER Mail reports is not the order any listing presents, so
-- three times in one session the wrong message was marked: a Google account notice, then a housing notice from
-- RentCafe, when the intent was an employer's acknowledgement. Personal and marketing mail must stay untouched, and a
-- positional marker cannot guarantee that. Position-based marking is therefore removed rather than documented around.
--
-- The needle form is the one that behaves: `every message of inbox whose subject contains needle` succeeds INSIDE a
-- with-timeout block, which is exactly what the sibling mark-unread script does. An earlier needle attempt failed with
-- -10004 only because it had no timeout block and used non-repeating accesses.
--
-- Usage: osascript mail_app_mark_read.applescript "Thanks for applying to Confido"
--        osascript mail_app_mark_read.applescript "needle one" "needle two"
-- Only application-related mail may be passed here (see the application-mail-triage skill). The script prints what it
-- matched, so the caller can confirm the right message landed rather than trusting the call.
on run argv
	if (count of argv) = 0 then return "usage: mail_app_mark_read.applescript \"<subject needle>\" [more needles...]"
	tell application "Mail"
		with timeout of 120 seconds
			set report to ""
			repeat with t in argv
				set needle to (t as string)
				-- REFUSE A NEEDLE THAT COULD SWEEP THE INBOX. Mail's `subject contains ""` matches EVERY message, so an
				-- empty or very short needle would mark the user's personal and marketing mail read - the exact thing this
				-- project must never do. Application subjects always carry the employer's name, so a real needle is long.
				-- (2026-10-04: a personal RentCafe message was found marked read; no needle used here could match it, but
				-- the guard costs nothing and makes a sweep impossible.)
				if (length of needle) < 12 then
					set report to report & "REFUSED (needle too short to be safe): " & needle & linefeed
				else
				set n to 0
				try
					-- ONLY UNREAD MESSAGES. The original query asked for every message whose subject contains the needle,
					-- which scans the whole mailbox and TIMES OUT (-1712) on a generic subject like "Thank You for
					-- Applying" even while Mail sits at 0% CPU - the same reason the listing tool, which filters on read
					-- status first, never times out. Adding `read status is false` is semantically identical here (only
					-- unread mail needs marking) and makes the query cheap.
					set msgs to (every message of inbox whose read status is false and subject contains needle)
					repeat with m in msgs
						try
							if (read status of m) is false then
								set read status of m to true
								set n to n + 1
							end if
						end try
					end repeat
					set report to report & "marked-read " & n & " for: " & needle & linefeed
				on error errMsg number errNum
					set report to report & "FAILED (" & errNum & ") for: " & needle & linefeed
				end try
				end if
			end repeat
			return report & "UNREAD NOW: " & (unread count of inbox)
		end timeout
	end tell
end run
