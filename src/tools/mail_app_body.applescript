-- Print the body of the first UNREAD inbox message whose subject contains the given string.
-- Usage: osascript mail_app_body.applescript "Security code"
on run argv
	set needle to item 1 of argv
	tell application "Mail"
		with timeout of 120 seconds
			set msgs to (every message of inbox whose read status is false)
			repeat with m in msgs
				if (subject of m) contains needle then
					set c to content of m
					if (length of c) > 2000 then set c to (text 1 thru 2000 of c)
					return "SUBJECT: " & (subject of m) & linefeed & "FROM: " & (sender of m) & linefeed & "DATE: " & (date received of m as string) & linefeed & linefeed & c
				end if
			end repeat
			return "no unread message matching: " & needle
		end timeout
	end tell
end run
